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


def _parse_label(raw):
    """Split a training folder name into crop, disease and severity.

    Datasets name classes either "Tomato___Late_blight" (PlantVillage style) or
    "Okra Downy Mildew" (plain words). Both appear in the same training set, so
    both are handled rather than assuming one convention.
    """
    text = (raw or '').strip()

    if '___' in text:
        crop, disease = text.split('___', 1)
    else:
        parts = text.split(' ', 1)
        crop, disease = (parts[0], parts[1]) if len(parts) == 2 else (text, text)

    crop = crop.replace('_', ' ').replace(',', '').strip().title()
    disease = disease.replace('_', ' ').strip()

    low = disease.lower()
    if low.startswith('healthy') or low.endswith('healthy'):
        return {'crop': crop, 'disease': 'Healthy', 'severity': 'none'}

    disease = disease.title()
    low = disease.lower()
    # Viruses and late blight spread fastest and cost the most yield; spots and
    # mildews progress slowly and are usually treatable in place.
    if any(k in low for k in ('virus', 'late blight', 'wilt', 'mold')):
        severity = 'high'
    elif any(k in low for k in ('blight', 'mildew', 'scorch', 'rot', 'beetle', 'pest', 'mite')):
        severity = 'medium'
    else:
        severity = 'low'
    return {'crop': crop, 'disease': disease, 'severity': severity}


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
        # 'tf' -> [-1, 1] (MobileNet family), 'zero_one' -> [0, 1].
        # Detected from the loaded architecture; override with
        # CNN_PREPROCESS=tf|zero_one when auto-detection cannot tell.
        self.preprocess_mode = os.environ.get('CNN_PREPROCESS', 'zero_one')
        # Class names from weights/labels.txt, injected by app.py. When set,
        # these replace the hardcoded CLASS_LABELS table, which only matches
        # the original training run.
        self.labels = None

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

            # Match preprocessing to the backbone unless the operator pinned it.
            if 'CNN_PREPROCESS' not in os.environ:
                # Walk nested submodels: a backbone wrapped in a Sequential
                # hides its layer names one level down, and the wrapper may
                # have been renamed when the model was saved.
                def _all_layers(m, depth=0):
                    for layer in getattr(m, 'layers', []):
                        yield layer
                        if depth < 2 and hasattr(layer, 'layers'):
                            yield from _all_layers(layer, depth + 1)

                layers = list(_all_layers(self.model))
                names = ' '.join(l.name.lower() for l in layers)
                classes = {l.__class__.__name__ for l in layers}

                # A model carrying its own Rescaling/Normalization scales the
                # input itself; feeding it pre-scaled pixels would scale twice.
                self_scaling = bool({'Rescaling', 'Normalization'} & classes)

                if self_scaling or 'efficientnet' in names or 'stem_conv' in names:
                    self.preprocess_mode = 'raw'
                    logger.info("   preprocessing: raw [0, 255] "
                                "(model rescales internally — EfficientNet-style)")
                elif any(k in names for k in ('mobilenet', 'inception', 'xception', 'nasnet')):
                    self.preprocess_mode = 'tf'
                    logger.info("   preprocessing: [-1, 1] (MobileNet-family backbone detected)")
                else:
                    logger.info("   preprocessing: [0, 1] — set CNN_PREPROCESS=tf if the backbone needs [-1, 1]")

            # Input size comes from the model rather than the 224x224 default.
            shape = self.model.input_shape
            if isinstance(shape, (list, tuple)) and len(shape) == 4 and shape[1] and shape[2]:
                self.input_size = (int(shape[2]), int(shape[1]))  # PIL wants (w, h)
                logger.info(f"   input size: {self.input_size[0]}x{self.input_size[1]}")
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
        img_array = np.array(img).astype('float32')

        # Scale to the range the backbone was trained on. MobileNet/MobileNetV2,
        # Inception and Xception expect [-1, 1]; ResNet/VGG-style stacks expect
        # [0, 1] (or ImageNet mean/std). Getting this wrong does not raise —
        # it silently produces confident, meaningless predictions — so it is
        # made explicit rather than assumed.
        if self.preprocess_mode == 'raw':         # [0, 255]
            pass                                  # model rescales internally
        elif self.preprocess_mode == 'tf':        # [-1, 1] — MobileNet family
            img_array = img_array / 127.5 - 1.0
        else:                                     # [0, 1]
            img_array = img_array / 255.0

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
            if self.labels and 0 <= class_idx < len(self.labels):
                label = _parse_label(self.labels[class_idx])
            else:
                label = CLASS_LABELS.get(class_idx, {
                    'crop': 'Unknown',
                    'disease': 'Unknown',
                    'severity': 'unknown',
                })

            probs = predictions[0]
            ranked = np.argsort(probs)[::-1][:3]
            result = {
                'crop': label['crop'],
                'disease': label['disease'],
                'confidence': round(confidence, 4),
                'severity': label['severity'],
                'class_index': class_idx,
                'raw_label': (self.labels[class_idx]
                              if self.labels and class_idx < len(self.labels) else None),
                # A report needs the runners-up: a 40/38% split means something
                # very different from 95/2%, and the farmer should see that.
                'top_k': [
                    {
                        'label': (self.labels[int(i)] if self.labels and int(i) < len(self.labels)
                                  else str(int(i))),
                        'confidence': round(float(probs[int(i)]), 4),
                    }
                    for i in ranked
                ],
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
