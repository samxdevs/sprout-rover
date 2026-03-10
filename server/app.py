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
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('sprout-server')

# ============================================
# MODEL INITIALIZATION
# ============================================
logger.info("🌱 Loading AI models...")

yolo = YOLODetector()
cnn = CNNClassifier()
path_detector = PathDetector()
camera = PiCameraStream()

logger.info("✅ All models loaded successfully!")

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
            'yolov8': yolo.is_loaded(),
            'cnn': cnn.is_loaded(),
            'path_detection': True,
        },
        'camera': camera.is_available(),
        'firebase': FIREBASE_ENABLED,
        'timestamp': datetime.now().isoformat(),
    })


@app.route('/api/detect', methods=['POST'])
def detect():
    """
    YOLOv8 Object Detection
    -----------------------
    POST an image → get bounding boxes with disease labels.
    
    Request: multipart/form-data with 'image' file
    Response: { detections: [{class, confidence, bbox: [x1,y1,x2,y2]}] }
    """
    if 'image' not in request.files:
        return jsonify({'error': 'No image provided'}), 400

    file = request.files['image']
    image = Image.open(file.stream).convert('RGB')
    image_np = np.array(image)

    # Run YOLOv8 inference
    start_time = time.time()
    detections = yolo.detect(image_np)
    inference_time = round((time.time() - start_time) * 1000, 1)

    result = {
        'detections': detections,
        'inference_time_ms': inference_time,
        'image_size': {'width': image_np.shape[1], 'height': image_np.shape[0]},
        'timestamp': datetime.now().isoformat(),
    }

    # Emit to WebSocket clients
    socketio.emit('detection_result', result)

    # Log to AI Action log
    if detections:
        for det in detections:
            socketio.emit('action_log', {
                'text': f"Detected {det['class']} ({det['confidence']:.0%} confidence)",
                'time': datetime.now().strftime('%H:%M'),
                'type': 'detection',
            })

    # Save to Firebase if enabled
    if FIREBASE_ENABLED and detections:
        try:
            save_inference_result('detection', result)
        except Exception as e:
            logger.error(f"Firebase save error: {e}")

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

    socketio.run(app, host='0.0.0.0', port=PORT, debug=False)
