"""
CNN Crop Disease Classifier
=============================
Convolutional Neural Network for classifying crop diseases.
Supports TensorFlow/Keras or PyTorch models.

Usage:
    classifier = CNNClassifier(model_path='path/to/model.h5')
    result = classifier.classify(image_np)
"""

import os
import logging
import numpy as np

logger = logging.getLogger('sprout-server')

# Crop disease classification labels
CLASS_LABELS = {
    0: {'crop': 'Rice', 'disease': 'Rice Blast', 'severity': 'high'},
    1: {'crop': 'Rice', 'disease': 'Leaf Blight', 'severity': 'medium'},
    2: {'crop': 'Rice', 'disease': 'Brown Spot', 'severity': 'medium'},
    3: {'crop': 'Rice', 'disease': 'Tungro', 'severity': 'high'},
    4: {'crop': 'Rice', 'disease': 'Bacterial Leaf Streak', 'severity': 'low'},
    5: {'crop': 'Rice', 'disease': 'Sheath Rot', 'severity': 'medium'},
    6: {'crop': 'Rice', 'disease': 'Healthy', 'severity': 'none'},
    7: {'crop': 'Wheat', 'disease': 'Rust', 'severity': 'high'},
    8: {'crop': 'Wheat', 'disease': 'Septoria', 'severity': 'medium'},
    9: {'crop': 'Wheat', 'disease': 'Healthy', 'severity': 'none'},
    10: {'crop': 'Corn', 'disease': 'Northern Leaf Blight', 'severity': 'high'},
    11: {'crop': 'Corn', 'disease': 'Gray Leaf Spot', 'severity': 'medium'},
    12: {'crop': 'Corn', 'disease': 'Healthy', 'severity': 'none'},
}

# Treatment lookup
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
    'Rust': {
        'product': 'Propiconazole',
        'active_ingredient': 'Propiconazole 25% EC',
        'dosage': '200 ml/acre',
        'method': 'Rover Spray Arm A',
    },
    'Northern Leaf Blight': {
        'product': 'Azoxystrobin',
        'active_ingredient': 'Azoxystrobin 23% SC',
        'dosage': '300 ml/acre',
        'method': 'Rover Spray Arm B',
    },
}


class CNNClassifier:
    """CNN wrapper for crop disease classification."""

    def __init__(self, model_path: str = None, framework: str = 'tensorflow'):
        """
        Initialize the CNN classifier.

        Args:
            model_path: Path to model file (.h5 for Keras, .pt for PyTorch)
            framework: 'tensorflow' or 'pytorch'
        """
        self.model = None
        self.framework = framework
        self._loaded = False
        self.input_size = (224, 224)  # Standard CNN input size

        if model_path and os.path.exists(model_path):
            try:
                if framework == 'tensorflow':
                    self._load_tensorflow(model_path)
                else:
                    self._load_pytorch(model_path)
            except Exception as e:
                logger.error(f"❌ Failed to load CNN model: {e}")
        else:
            logger.info("ℹ️  CNN running in mock mode (no model file provided)")

    def _load_tensorflow(self, model_path: str):
        """Load a TensorFlow/Keras model."""
        try:
            import tensorflow as tf
            self.model = tf.keras.models.load_model(model_path)
            self._loaded = True
            logger.info(f"✅ CNN TensorFlow model loaded: {model_path}")
        except ImportError:
            logger.warning("⚠️  TensorFlow not installed")

    def _load_pytorch(self, model_path: str):
        """Load a PyTorch model."""
        try:
            import torch
            self.model = torch.load(model_path, map_location='cpu')
            self.model.eval()
            self._loaded = True
            logger.info(f"✅ CNN PyTorch model loaded: {model_path}")
        except ImportError:
            logger.warning("⚠️  PyTorch not installed")

    def is_loaded(self) -> bool:
        return self._loaded

    def preprocess(self, image: np.ndarray) -> np.ndarray:
        """Preprocess image for CNN input."""
        from PIL import Image as PILImage

        # Resize to model input size
        img = PILImage.fromarray(image)
        img = img.resize(self.input_size)
        img_array = np.array(img).astype('float32') / 255.0

        # Add batch dimension
        img_array = np.expand_dims(img_array, axis=0)
        return img_array

    def classify(self, image: np.ndarray) -> dict:
        """
        Classify a crop disease image.

        Args:
            image: numpy array (H, W, C) in RGB

        Returns:
            {crop, disease, confidence, severity, treatment}
        """
        if self.model is None:
            return self._mock_classify()

        try:
            preprocessed = self.preprocess(image)

            if self.framework == 'tensorflow':
                predictions = self.model.predict(preprocessed, verbose=0)
            else:
                import torch
                with torch.no_grad():
                    tensor = torch.FloatTensor(preprocessed).permute(0, 3, 1, 2)
                    predictions = self.model(tensor).numpy()

            class_idx = int(np.argmax(predictions[0]))
            confidence = float(np.max(predictions[0]))

            # Get label info
            label = CLASS_LABELS.get(class_idx, {
                'crop': 'Unknown',
                'disease': 'Unknown',
                'severity': 'unknown',
            })

            result = {
                'crop': label['crop'],
                'disease': label['disease'],
                'confidence': round(confidence, 4),
                'severity': label['severity'],
                'class_index': class_idx,
            }

            # Add treatment recommendation
            if label['disease'] in TREATMENTS:
                result['treatment'] = TREATMENTS[label['disease']]

            return result

        except Exception as e:
            logger.error(f"CNN classification error: {e}")
            return self._mock_classify()

    def _mock_classify(self) -> dict:
        """Return mock classification for development/testing."""
        import random
        mock_diseases = [
            {'crop': 'Rice', 'disease': 'Rice Blast', 'severity': 'high'},
            {'crop': 'Rice', 'disease': 'Leaf Blight', 'severity': 'medium'},
            {'crop': 'Rice', 'disease': 'Healthy', 'severity': 'none'},
            {'crop': 'Wheat', 'disease': 'Rust', 'severity': 'high'},
        ]
        selected = random.choice(mock_diseases)
        confidence = round(random.uniform(0.88, 0.98), 4)

        result = {
            **selected,
            'confidence': confidence,
            'class_index': 0,
        }

        if selected['disease'] in TREATMENTS:
            result['treatment'] = TREATMENTS[selected['disease']]

        return result
