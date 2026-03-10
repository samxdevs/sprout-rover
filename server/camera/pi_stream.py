"""
Raspberry Pi Camera Stream
============================
MJPEG streaming from Raspberry Pi camera module.
Falls back to a mock stream using test images when Pi camera is not available.

Usage:
    camera = PiCameraStream()
    # In Flask route:
    return Response(camera.generate_frames(), 
                    mimetype='multipart/x-mixed-replace; boundary=frame')
"""

import os
import time
import logging
import numpy as np

logger = logging.getLogger('sprout-server')


class PiCameraStream:
    """Raspberry Pi camera MJPEG streamer with fallback."""

    def __init__(self, resolution: tuple = (640, 480), framerate: int = 30):
        """
        Initialize the camera stream.

        Args:
            resolution: (width, height) tuple
            framerate: Target frames per second
        """
        self.resolution = resolution
        self.framerate = framerate
        self.camera = None
        self._available = False
        self.cv2 = None

        # Try to import OpenCV
        try:
            import cv2
            self.cv2 = cv2
        except ImportError:
            logger.warning("⚠️  OpenCV not installed")

        # Try Pi camera first
        self._init_pi_camera()

        # Fallback to USB camera / webcam
        if not self._available and self.cv2:
            self._init_usb_camera()

        if not self._available:
            logger.info("ℹ️  Camera: using mock frame generator (no camera detected)")

    def _init_pi_camera(self):
        """Try to initialize Raspberry Pi camera using picamera2."""
        try:
            from picamera2 import Picamera2
            self.camera = Picamera2()
            config = self.camera.create_preview_configuration(
                main={"size": self.resolution, "format": "RGB888"}
            )
            self.camera.configure(config)
            self.camera.start()
            self._available = True
            self._camera_type = 'pi'
            logger.info(f"✅ Pi Camera initialized at {self.resolution}")
        except (ImportError, Exception) as e:
            logger.info(f"Pi camera not available: {e}")

    def _init_usb_camera(self):
        """Try to initialize USB camera / webcam via OpenCV."""
        try:
            cap = self.cv2.VideoCapture(0)
            if cap.isOpened():
                cap.set(self.cv2.CAP_PROP_FRAME_WIDTH, self.resolution[0])
                cap.set(self.cv2.CAP_PROP_FRAME_HEIGHT, self.resolution[1])
                self.camera = cap
                self._available = True
                self._camera_type = 'usb'
                logger.info(f"✅ USB Camera initialized at {self.resolution}")
            else:
                cap.release()
        except Exception as e:
            logger.info(f"USB camera not available: {e}")

    def is_available(self) -> bool:
        return self._available

    def capture_frame(self) -> np.ndarray:
        """Capture a single frame from the camera."""
        if not self._available:
            return self._generate_mock_frame()

        try:
            if self._camera_type == 'pi':
                return self.camera.capture_array()
            elif self._camera_type == 'usb':
                ret, frame = self.camera.read()
                if ret:
                    return self.cv2.cvtColor(frame, self.cv2.COLOR_BGR2RGB)
        except Exception as e:
            logger.error(f"Frame capture error: {e}")

        return self._generate_mock_frame()

    def generate_frames(self):
        """
        Generator that yields MJPEG frames for HTTP streaming.

        Yields frames as bytes with MJPEG boundary headers.
        """
        frame_delay = 1.0 / self.framerate

        while True:
            start_time = time.time()

            frame = self.capture_frame()

            # Encode as JPEG
            if self.cv2 is not None:
                frame_bgr = self.cv2.cvtColor(frame, self.cv2.COLOR_RGB2BGR)
                _, buffer = self.cv2.imencode('.jpg', frame_bgr, 
                    [self.cv2.IMWRITE_JPEG_QUALITY, 75])
                frame_bytes = buffer.tobytes()
            else:
                # Fallback: use PIL
                from PIL import Image
                from io import BytesIO
                img = Image.fromarray(frame)
                buf = BytesIO()
                img.save(buf, format='JPEG', quality=75)
                frame_bytes = buf.getvalue()

            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' +
                   frame_bytes + b'\r\n')

            # Throttle to target framerate
            elapsed = time.time() - start_time
            if elapsed < frame_delay:
                time.sleep(frame_delay - elapsed)

    def _generate_mock_frame(self) -> np.ndarray:
        """
        Generate a mock camera frame for development/testing.
        Creates a simulated field view with timestamp overlay.
        """
        w, h = self.resolution
        frame = np.zeros((h, w, 3), dtype=np.uint8)

        # Green field gradient
        for y in range(h):
            green_val = int(60 + (y / h) * 80)
            frame[y, :] = [30, green_val, 20]

        # Add some "crop rows" as lighter vertical stripes
        row_spacing = w // 8
        for x in range(0, w, row_spacing):
            stripe_width = 12
            x_start = max(0, x - stripe_width // 2)
            x_end = min(w, x + stripe_width // 2)
            frame[:, x_start:x_end] = [40, 120, 30]

        # Sky at top
        sky_height = h // 4
        for y in range(sky_height):
            ratio = y / sky_height
            frame[y, :] = [
                int(135 + ratio * 20),
                int(180 + ratio * 20),
                int(220 - ratio * 10),
            ]

        # Add timestamp text using numpy (no cv2 dependency needed for text)
        # We'll skip text overlay in pure numpy mode
        if self.cv2 is not None:
            timestamp = time.strftime('%H:%M:%S')
            self.cv2.putText(frame, f'SPROUT CAM - {timestamp}',
                           (10, 25), self.cv2.FONT_HERSHEY_SIMPLEX,
                           0.6, (255, 255, 255), 1)
            self.cv2.putText(frame, 'MOCK FEED - No camera connected',
                           (10, h - 15), self.cv2.FONT_HERSHEY_SIMPLEX,
                           0.5, (200, 200, 200), 1)
            # REC indicator
            self.cv2.circle(frame, (w - 30, 25), 8, (0, 0, 255), -1)
            self.cv2.putText(frame, 'REC', (w - 70, 30),
                           self.cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)

        return frame

    def release(self):
        """Release camera resources."""
        if self._available:
            try:
                if self._camera_type == 'pi':
                    self.camera.stop()
                elif self._camera_type == 'usb':
                    self.camera.release()
            except Exception:
                pass
            self._available = False

    def __del__(self):
        self.release()
