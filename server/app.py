"""
Sprout AI Server — Flask + SocketIO
====================================
Main application server providing:
- REST API for AI model inference (YOLOv8, CNN, Path Detection)
- WebSocket for real-time events (AI action log, telemetry)
- MJPEG video proxy from Raspberry Pi camera
- Firebase Admin SDK for storing inference results
"""

import os
import time
import base64
import logging
from datetime import datetime
from io import BytesIO

from flask import Flask, request, jsonify, Response
from flask_socketio import SocketIO, emit
from flask_cors import CORS
from PIL import Image
import numpy as np

# Local model imports
from models.yolo_detector import YOLODetector
from models.cnn_classifier import CNNClassifier
from models.path_detector import PathDetector
from camera.pi_stream import PiCameraStream
from gps.serial_gps import SerialGPS
from model_registry import scan, check_classifier_head, WEIGHTS_DIR
import auth_otp
from models.detector_pool import DetectorPool

# Optional: Firebase Admin
try:
    from firebase_admin_config import initialize_firebase, save_inference_result
    FIREBASE_ENABLED = True
except Exception:
    FIREBASE_ENABLED = False
    print("⚠️  Firebase Admin not configured. Inference results won't be saved to Firestore.")

# ============================================
# APP SETUP
# ============================================
app = Flask(__name__)
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'sprout-secret-key-change-in-production')

CORS(app, resources={r"/api/*": {"origins": "*"}})
# Threading, not eventlet. Eventlet's green threads only switch at patched I/O
# points, and YOLO/TensorFlow inference is a long native call that yields
# nothing — the first /api/analyze request wedges the whole server, so even
# health checks stop responding. Real OS threads let the interpreter preempt
# the blocking call and keep the server answering during inference.
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading')

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('sprout-server')

# ============================================
# MODEL INITIALIZATION
# ============================================
logger.info("🌱 Loading AI models...")

# Trained weights live in server/weights/ under any filename — model_registry
# identifies them by extension and content, and assigns each detector a role
# from its own class list. Env vars still override for models kept outside
# the repo.
FOUND = scan()

detectors = DetectorPool(FOUND['detectors'])

_cnn_override = os.environ.get('CNN_MODEL_PATH')
CNN_PATH = _cnn_override or (FOUND['cnn']['path'] if FOUND['cnn'] else None)
if _cnn_override and not os.path.exists(_cnn_override):
    logger.warning(f"⚠️  CNN_MODEL_PATH={_cnn_override} does not exist")

CNN_FRAMEWORK = os.environ.get(
    'CNN_FRAMEWORK',
    (FOUND['cnn']['framework'] if FOUND['cnn'] else None)
    or ('pytorch' if (CNN_PATH or '').endswith(('.pt', '.pth')) else 'tensorflow'),
)

# A classifier whose output layer was never trained loads and runs happily
# while returning a flat distribution for every image. Catching that here
# keeps meaningless predictions out of the app.
CNN_HEALTHY, CNN_HEALTH_DETAIL = (True, 'no classifier loaded')
if CNN_PATH:
    CNN_HEALTHY, CNN_HEALTH_DETAIL = check_classifier_head(CNN_PATH)
    if not CNN_HEALTHY:
        logger.error(f"❌ {os.path.basename(CNN_PATH)}: {CNN_HEALTH_DETAIL}")
        logger.error("   Classification is DISABLED — detection still works.")

cnn = CNNClassifier(
    model_path=CNN_PATH if CNN_HEALTHY else None,
    framework=CNN_FRAMEWORK,
)

DETECTED_LABELS = {
    'detectors': {d['role']: d['labels'] for d in FOUND['detectors']},
    'cnn': (FOUND['cnn']['labels'] if FOUND['cnn'] else None) or FOUND['sidecar_labels'],
}

# Hand the classifier its real class names. Without these it falls back to the
# hardcoded CLASS_LABELS table, which belongs to a different training run and
# would mislabel every prediction.
if DETECTED_LABELS['cnn'] and cnn.is_loaded():
    cnn.labels = DETECTED_LABELS['cnn']
    logger.info(f"📋 classifier labels: {len(cnn.labels)} classes from weights/labels.txt")
elif cnn.is_loaded():
    logger.warning("⚠️  classifier loaded but no labels.txt — predictions may be mislabelled")
if not detectors.is_loaded():
    logger.warning("⚠️  No detectors loaded — /api/analyze returns nothing")
path_detector = PathDetector()
camera = PiCameraStream()
gps = SerialGPS()  # background thread; reconnects when the Arduino is unplugged


def _model_status():
    """What is actually loaded — the quickest way to spot a missed weights file."""
    return {
        'detectors': detectors.describe(),
        'detector_labels': DETECTED_LABELS['detectors'],
        'cnn': {
            'loaded': cnn.is_loaded(),
            'filename': os.path.basename(CNN_PATH) if CNN_PATH else None,
            'framework': CNN_FRAMEWORK if CNN_PATH else None,
            'labels': DETECTED_LABELS['cnn'],
            'healthy': CNN_HEALTHY,
            'health_detail': CNN_HEALTH_DETAIL,
            'mock': not cnn.is_loaded(),
        },
        'weights_dir': WEIGHTS_DIR,
        'ignored_files': FOUND['ignored'],
    }


logger.info(f"🧠 {len(detectors.describe())} detector(s) ready; "
            f"classifier: {'ready' if cnn.is_loaded() else 'disabled'}")

# ============================================
# REST API ENDPOINTS
# ============================================

@app.route('/api/health', methods=['GET'])
def health():
    """Health check endpoint."""
    return jsonify({
        'status': 'online',
        'server': 'Sprout AI Server',
        'version': '2.4.12',
        'models': {
            'detectors': len(detectors.describe()),
            'cnn': cnn.is_loaded(),
            'path_detection': True,
        },
        'camera': camera.is_available(),
        'firebase': FIREBASE_ENABLED,
        'gps': gps.snapshot().get('status'),
        'timestamp': datetime.now().isoformat(),
    })


@app.route('/api/auth/send-otp', methods=['POST'])
def send_otp():
    """Email a one-time verification code.

    Body: { "email": "..." }
    200 { sent, expires_in_s }  429 rate limited  502 mail failure
    """
    body = request.get_json(silent=True) or {}
    status_code, payload = auth_otp.request_code(body.get('email'))
    return jsonify(payload), status_code


@app.route('/api/auth/verify-otp', methods=['POST'])
def verify_otp():
    """Check a submitted code.

    Body: { "email": "...", "code": "123456" }
    200 { verified: true }  400 wrong/expired  429 too many attempts
    """
    body = request.get_json(silent=True) or {}
    status_code, payload = auth_otp.verify_code(body.get('email'), body.get('code'))
    return jsonify(payload), status_code


@app.route('/api/auth/status', methods=['GET'])
def auth_status():
    """Whether real email sending is configured."""
    return jsonify(auth_otp.status())


@app.route('/api/models', methods=['GET'])
def models_status():
    """Which models are really loaded vs running as mocks."""
    return jsonify(_model_status())


@app.route('/api/gps', methods=['GET'])
def rover_gps():
    """Latest rover position from the GPS chip (Arduino → serial → here).

    Response shapes:
      {status: 'fix', lat, lon, speed, heading, sats, hdop, accuracy, age_s}
      {status: 'no_fix', sats}          — receiver connected, still acquiring
      {status: 'no_device', detail}     — nothing on the serial port
    """
    return jsonify(gps.snapshot())


@app.route('/api/detect', methods=['POST'])
def detect():
    """Run every loaded detector over one frame.

    Request:  multipart/form-data with an 'image' file
    Response: { detections: [{label, confidence, bbox, role}], by_role, summary }
    """
    if 'image' not in request.files:
        return jsonify({'error': 'No image provided'}), 400

    image = Image.open(request.files['image'].stream).convert('RGB')
    image_np = np.array(image)

    outcome = detectors.detect(image_np)
    summary = detectors.summarise(outcome)

    result = {
        **outcome,
        'summary': summary,
        'image_size': {'width': image_np.shape[1], 'height': image_np.shape[0]},
        'timestamp': datetime.now().isoformat(),
    }

    socketio.emit('detection_result', result)
    socketio.emit('action_log', {
        'text': summary,
        'time': datetime.now().strftime('%H:%M'),
        'type': 'detection',
    })

    if FIREBASE_ENABLED and outcome['detections']:
        try:
            save_inference_result('detection', result)
        except Exception as e:
            logger.error(f"Firebase save error: {e}")

    return jsonify(result)


@app.route('/api/analyze', methods=['POST'])
def analyze():
    """Detection + classification in one call, for the app's automation loop.

    Classification is included only when a healthy classifier is loaded, so a
    broken or absent one degrades to detection-only instead of poisoning the
    result with a meaningless prediction.
    """
    if 'image' not in request.files:
        return jsonify({'error': 'No image provided'}), 400

    image = Image.open(request.files['image'].stream).convert('RGB')
    image_np = np.array(image)

    outcome = detectors.detect(image_np)
    result = {
        **outcome,
        'summary': detectors.summarise(outcome),
        'classification': None,
        'image_size': {'width': image_np.shape[1], 'height': image_np.shape[0]},
        'timestamp': datetime.now().isoformat(),
    }

    # Annotated frame as a data URL, so the app can show the boxes without
    # reimplementing the drawing or rescaling coordinates for its viewport.
    # Skipped when nothing was found (?annotate=0 also opts out, for the
    # automation loop, where a few hundred KB every few seconds is wasteful).
    if outcome['detections'] and request.args.get('annotate') != '0':
        try:
            jpeg = detectors.annotate(image_np, outcome['detections'])
            result['annotated_image'] = 'data:image/jpeg;base64,' + \
                base64.b64encode(jpeg).decode('ascii')
        except Exception as e:
            logger.error(f"Annotation failed: {e}")

    if cnn.is_loaded():
        try:
            result['classification'] = cnn.classify(image_np)
        except Exception as e:
            logger.error(f"Classification failed: {e}")
    else:
        result['classification_unavailable'] = CNN_HEALTH_DETAIL

    socketio.emit('action_log', {
        'text': result['summary'],
        'time': datetime.now().strftime('%H:%M'),
        'type': 'detection',
    })
    return jsonify(result)


@app.route('/api/classify', methods=['POST'])
def classify():
    """
    CNN Crop Disease Classification
    --------------------------------
    POST an image → get crop type, disease, confidence, severity.
    
    Request: multipart/form-data with 'image' file
    Response: { crop, disease, confidence, severity, treatment }
    """
    if 'image' not in request.files:
        return jsonify({'error': 'No image provided'}), 400

    file = request.files['image']
    image = Image.open(file.stream).convert('RGB')
    image_np = np.array(image)

    # Run CNN classification
    start_time = time.time()
    classification = cnn.classify(image_np)
    inference_time = round((time.time() - start_time) * 1000, 1)

    result = {
        **classification,
        'inference_time_ms': inference_time,
        'timestamp': datetime.now().isoformat(),
    }

    # Emit event
    socketio.emit('classification_result', result)
    socketio.emit('action_log', {
        'text': f"AI classified: {classification['disease']} on {classification['crop']} ({classification['confidence']:.0%})",
        'time': datetime.now().strftime('%H:%M'),
        'type': 'classification',
    })

    # Save to Firebase
    if FIREBASE_ENABLED:
        try:
            save_inference_result('classification', result)
        except Exception as e:
            logger.error(f"Firebase save error: {e}")

    return jsonify(result)


@app.route('/api/path', methods=['POST'])
def detect_path():
    """
    Path Detection for Rover Navigation
    ------------------------------------
    POST an image or waypoints → get path boundaries + steering angle.
    
    Request: multipart/form-data with 'image' file
             OR JSON with 'waypoints' and 'obstacles'
    Response: { steering_angle, path_boundaries, waypoints }
    """
    if request.content_type and 'multipart' in request.content_type:
        # Image-based path detection
        if 'image' not in request.files:
            return jsonify({'error': 'No image provided'}), 400
        file = request.files['image']
        image = Image.open(file.stream).convert('RGB')
        image_np = np.array(image)
        result = path_detector.detect_from_image(image_np)
    else:
        # Waypoint-based path planning
        data = request.get_json()
        if not data:
            return jsonify({'error': 'No data provided'}), 400
        result = path_detector.plan_path(
            waypoints=data.get('waypoints', []),
            obstacles=data.get('obstacles', []),
            current_position=data.get('current_position', None),
        )

    result['timestamp'] = datetime.now().isoformat()

    socketio.emit('path_update', result)
    socketio.emit('action_log', {
        'text': f"Path updated — steering angle: {result.get('steering_angle', 0):.1f}°",
        'time': datetime.now().strftime('%H:%M'),
        'type': 'path',
    })

    return jsonify(result)


@app.route('/api/stream')
def video_stream():
    """
    MJPEG Video Stream
    ------------------
    Proxies the Raspberry Pi camera feed as an MJPEG stream.
    Falls back to a test image loop when no Pi camera is available.
    """
    return Response(
        camera.generate_frames(),
        mimetype='multipart/x-mixed-replace; boundary=frame'
    )


@app.route('/api/capture', methods=['POST'])
def capture_frame():
    """Capture a single frame from the camera and return as JPEG."""
    frame = camera.capture_frame()
    if frame is None:
        return jsonify({'error': 'Camera not available'}), 503

    # Convert to base64
    img = Image.fromarray(frame)
    buffer = BytesIO()
    img.save(buffer, format='JPEG', quality=85)
    img_base64 = base64.b64encode(buffer.getvalue()).decode('utf-8')

    return jsonify({
        'image': f'data:image/jpeg;base64,{img_base64}',
        'timestamp': datetime.now().isoformat(),
    })


# ============================================
# WEBSOCKET EVENTS
# ============================================

@socketio.on('connect')
def handle_connect():
    logger.info(f"Client connected: {request.sid}")
    emit('server_status', {
        'status': 'connected',
        'server': 'Sprout AI Server',
        'timestamp': datetime.now().isoformat(),
    })


@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"Client disconnected: {request.sid}")


@socketio.on('rover_command')
def handle_rover_command(data):
    """
    Handle rover control commands from the joystick.
    Expects: { x: float, y: float, speed: int }
    """
    logger.info(f"Rover command: {data}")
    # Forward to rover via serial/bluetooth (implement based on your hardware)
    emit('action_log', {
        'text': f"Manual drive: X={data.get('x', 0)}, Y={data.get('y', 0)} at {data.get('speed', 0)}% speed",
        'time': datetime.now().strftime('%H:%M'),
        'type': 'manual',
    }, broadcast=True)


@socketio.on('emergency_stop')
def handle_emergency_stop():
    """Emergency stop command."""
    logger.warning("🛑 EMERGENCY STOP triggered!")
    # Send stop command to rover hardware
    emit('action_log', {
        'text': 'EMERGENCY STOP — Rover halted',
        'time': datetime.now().strftime('%H:%M'),
        'type': 'emergency',
    }, broadcast=True)


@socketio.on('ai_toggle')
def handle_ai_toggle(data):
    """Toggle AI automation on/off."""
    enabled = data.get('enabled', False)
    status = 'enabled' if enabled else 'disabled'
    logger.info(f"AI Automation {status}")
    emit('action_log', {
        'text': f"AI Automation {status} — {'scanning field...' if enabled else 'manual mode'}",
        'time': datetime.now().strftime('%H:%M'),
        'type': 'ai',
    }, broadcast=True)


# ============================================
# SIMULATED TELEMETRY (for development)
# ============================================

def emit_telemetry():
    """Periodically emit simulated telemetry data."""
    import random
    base_lat, base_lon = 34.0522, -118.2437
    heading = 42
    while True:
        socketio.sleep(2)
        base_lat += random.uniform(-0.0001, 0.0001)
        base_lon += random.uniform(-0.0001, 0.0001)
        heading = (heading + random.uniform(-5, 5)) % 360
        velocity = round(random.uniform(0.8, 1.5), 2)

        socketio.emit('telemetry', {
            'latitude': round(base_lat, 6),
            'longitude': round(base_lon, 6),
            'heading': round(heading, 1),
            'velocity': velocity,
            'signal': 'RTK Fixed',
            'battery': max(0, 65 - int(time.time() % 100) // 10),
            'timestamp': datetime.now().isoformat(),
        })


# ============================================
# MAIN
# ============================================

# Read port from environment (Hugging Face Spaces uses 7860)
PORT = int(os.environ.get('PORT', 7860))

# Start telemetry emitter as a background task
# This runs whether started via `python app.py` or via gunicorn
socketio.start_background_task(emit_telemetry)

if __name__ == '__main__':
    logger.info("🌱 Sprout AI Server starting...")
    logger.info(f"   REST API:  http://localhost:{PORT}/api/health")
    logger.info(f"   Stream:    http://localhost:{PORT}/api/stream")
    logger.info(f"   WebSocket: ws://localhost:{PORT}/socket.io")

    # allow_unsafe_werkzeug: in threading mode Flask-SocketIO refuses
    # Werkzeug's dev server unless told explicitly. This is the local/Pi
    # development entry point; production uses gunicorn via the Dockerfile.
    socketio.run(
        app,
        host='0.0.0.0',
        port=PORT,
        debug=False,
        allow_unsafe_werkzeug=True,
    )
