"""
YOLOv8 Crop Disease Detector
=============================
Wrapper for Ultralytics YOLOv8 model for detecting crop diseases.
Supports custom-trained models for agricultural disease detection.

Usage:
    detector = YOLODetector(model_path='path/to/best.pt')
    results = detector.detect(image_np)
"""

import os
import logging
import numpy as np

logger = logging.getLogger('sprout-server')

# Disease classes the model can detect
DISEASE_CLASSES = [
    'Rice Blast',
    'Leaf Blight',
    'Brown Spot',
    'Tungro',
    'Bacterial Leaf Streak',
    'Sheath Rot',
    'Healthy',
]

# Treatment recommendations per disease
TREATMENTS = {
    'Rice Blast': {
        'product': 'Nativo',
        'active_ingredient': 'Trifloxystrobin + Tebuconazole',
        'dosage': '120 g/acre',
        'method': 'Rover Spray Arm B',
    },
    'Leaf Blight': {
        'product': 'Copper Oxychloride',
        'active_ingredient': 'Copper Oxychloride 50% WP',
        'dosage': '500 g/acre',
        'method': 'Rover Spray Arm A',
    },
    'Brown Spot': {
        'product': 'Mancozeb',
        'active_ingredient': 'Mancozeb 75% WP',
        'dosage': '400 g/acre',
        'method': 'Rover Spray Arm B',
    },
    'Tungro': {
        'product': 'Imidacloprid',
        'active_ingredient': 'Imidacloprid 17.8% SL',
        'dosage': '100 ml/acre',
        'method': 'Rover Spray Arm A',
    },
    'Bacterial Leaf Streak': {
        'product': 'Streptomycin',
        'active_ingredient': 'Streptomycin Sulphate',
        'dosage': '150 g/acre',
        'method': 'Rover Spray Arm B',
    },
    'Sheath Rot': {
        'product': 'Carbendazim',
        'active_ingredient': 'Carbendazim 50% WP',
        'dosage': '200 g/acre',
        'method': 'Rover Spray Arm A',
    },
}


class YOLODetector:
    """YOLOv8 wrapper for crop disease detection."""

    def __init__(self, model_path: str = None):
        """
        Initialize the YOLOv8 detector.
        
        Args:
            model_path: Path to custom .pt model. If None, uses default YOLOv8n.
        """
        self.model = None
        self.model_path = model_path
        self._loaded = False

        try:
            from ultralytics import YOLO

            if model_path and os.path.exists(model_path):
                # Load custom crop disease model
                self.model = YOLO(model_path)
                logger.info(f"✅ YOLOv8 custom model loaded: {model_path}")
            else:
                # Load default YOLOv8 nano for testing
                self.model = YOLO('yolov8n.pt')
                logger.info("✅ YOLOv8n default model loaded (use custom model for crop diseases)")

            self._loaded = True
        except ImportError:
            logger.warning("⚠️  ultralytics not installed. YOLOv8 running in mock mode.")
        except Exception as e:
            logger.error(f"❌ Failed to load YOLOv8: {e}")

    def is_loaded(self) -> bool:
        return self._loaded

    def detect(self, image: np.ndarray, confidence: float = 0.25) -> list:
        """
        Run YOLOv8 detection on an image.
        
        Args:
            image: numpy array (H, W, C) in RGB
            confidence: minimum confidence threshold
            
        Returns:
            List of detections: [{class, confidence, bbox, treatment}]
        """
        if self.model is None:
            # Mock mode: return simulated detection
            return self._mock_detect()

        try:
            results = self.model(image, conf=confidence, verbose=False)
            detections = []

            for result in results:
                for box in result.boxes:
                    cls_id = int(box.cls[0])
                    conf = float(box.conf[0])
                    bbox = box.xyxy[0].tolist()

                    # Map class name
                    class_name = result.names.get(cls_id, f'class_{cls_id}')

                    # Check if it's a known disease class
                    disease_match = None
                    for disease in DISEASE_CLASSES:
                        if disease.lower() in class_name.lower():
                            disease_match = disease
                            break

                    detection = {
                        'class': disease_match or class_name,
                        'confidence': round(conf, 4),
                        'bbox': [round(c, 1) for c in bbox],
                    }

                    # Add treatment if disease detected
                    if disease_match and disease_match in TREATMENTS:
                        detection['treatment'] = TREATMENTS[disease_match]

                    detections.append(detection)

            return detections

        except Exception as e:
            logger.error(f"YOLOv8 inference error: {e}")
            return self._mock_detect()

    def _mock_detect(self) -> list:
        """Return mock detection results for development/testing."""
        import random
        diseases = ['Rice Blast', 'Leaf Blight', 'Brown Spot', 'Healthy']
        detected = random.choice(diseases)
        conf = round(random.uniform(0.85, 0.98), 4)

        result = {
            'class': detected,
            'confidence': conf,
            'bbox': [100, 150, 300, 350],
        }

        if detected in TREATMENTS:
            result['treatment'] = TREATMENTS[detected]

        return [result]
