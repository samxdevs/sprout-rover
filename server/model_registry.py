"""
Model discovery
===============
Scans server/weights/ and works out what each file is, so any filename works —
`best.pt`, `rice_disease_final_v3.h5`, whatever your training run produced.

Identification is by file extension first, then by content for the ambiguous
case: `.pt` is used by both Ultralytics YOLO and plain PyTorch, and those load
completely differently. An Ultralytics checkpoint is a dict carrying a 'model'
key whose module exposes class `names`, so that is what gets probed.

Nothing here loads a model for inference; it only classifies files and reads
their embedded labels. app.py hands the results to the real wrappers.
"""

import os
import logging

logger = logging.getLogger('sprout-server.registry')

WEIGHTS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'weights')

YOLO_EXTS = {'.pt'}
KERAS_EXTS = {'.h5', '.keras', '.hdf5'}
TORCH_EXTS = {'.pt', '.pth'}
ALL_EXTS = YOLO_EXTS | KERAS_EXTS | TORCH_EXTS | {'.onnx', '.tflite'}


def _is_ultralytics_checkpoint(path):
    """True for an Ultralytics YOLO .pt, False for a plain PyTorch one.

    Returns None when torch is missing — the caller then falls back to the
    filename, which is better than claiming the file is something it isn't.
    """
    try:
        import torch
    except ImportError:
        return None

    try:
        # weights_only=False: Ultralytics checkpoints pickle their model class.
        # These files come from the operator's own machine, not the network.
        ckpt = torch.load(path, map_location='cpu', weights_only=False)
    except Exception as e:
        logger.debug(f"Could not inspect {path}: {e}")
        return None

    if isinstance(ckpt, dict):
        if 'model' in ckpt and hasattr(ckpt.get('model'), 'names'):
            return True
        # Ultralytics also stamps these keys on training checkpoints.
        if {'epoch', 'best_fitness'} & set(ckpt.keys()):
            return True
    return False


def read_yolo_labels(path):
    """Class names embedded in a YOLO checkpoint, in model order, or None."""
    try:
        from ultralytics import YOLO
        names = YOLO(path).names
        if isinstance(names, dict):
            return [names[i] for i in sorted(names)]
        return list(names) if names else None
    except Exception as e:
        logger.debug(f"Could not read labels from {path}: {e}")
        return None


def read_label_sidecar():
    """Labels from a text/JSON file dropped alongside the weights.

    Keras and plain PyTorch files almost never carry class names, so a sidecar
    is the only way to get them without the operator editing Python.
    """
    import json

    for name in ('labels.txt', 'classes.txt', 'labels.json', 'classes.json'):
        path = os.path.join(WEIGHTS_DIR, name)
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                if path.endswith('.json'):
                    data = json.load(f)
                    if isinstance(data, dict):
                        # {"0": "Rice Blast", ...} — order by numeric key.
                        return [data[k] for k in sorted(data, key=lambda k: int(k))]
                    return list(data)
                return [line.strip() for line in f if line.strip()]
        except Exception as e:
            logger.warning(f"Could not parse {name}: {e}")
    return None


def _detector_role(labels, filename):
    """What a detector is for, from its own class list.

    Naming is unreliable across training runs, so the class names decide:
    a model that knows 'weed' is the weed detector, one that knows 'leaf' is
    the leaf/canopy detector. The filename is only consulted when a model
    reports no labels at all.
    """
    lowered = [str(l).lower() for l in (labels or [])]
    if any('weed' in l for l in lowered):
        return 'weed'
    if any('leaf' in l or 'plant' in l for l in lowered):
        return 'leaf'

    name = filename.lower()
    if 'weed' in name:
        return 'weed'
    if 'leaf' in name or 'crop' in name or 'plant' in name:
        return 'leaf'
    return 'detector'


def scan():
    """Classify every model file in weights/.

    Returns:
      detectors  list of YOLO models, each {path, filename, role, labels, ...}
      cnn        the classifier, or None
      ignored    files that were skipped, with the reason
    """
    result = {'detectors': [], 'cnn': None, 'ignored': [], 'sidecar_labels': None}

    if not os.path.isdir(WEIGHTS_DIR):
        return result

    files = sorted(
        f for f in os.listdir(WEIGHTS_DIR)
        if os.path.splitext(f)[1].lower() in ALL_EXTS
    )
    result['sidecar_labels'] = read_label_sidecar()

    for filename in files:
        path = os.path.join(WEIGHTS_DIR, filename)
        ext = os.path.splitext(filename)[1].lower()
        lower = filename.lower()
        size_mb = round(os.path.getsize(path) / 1_048_576, 1)

        if ext in KERAS_EXTS:
            kind, framework = 'cnn', 'tensorflow'
        elif ext in YOLO_EXTS or ext in TORCH_EXTS:
            verdict = _is_ultralytics_checkpoint(path)
            if verdict is None:
                # torch unavailable or unreadable — guess from the name, which
                # is right for the overwhelmingly common `best.pt` / `yolo*.pt`.
                verdict = 'yolo' in lower or lower in ('best.pt', 'last.pt')
            kind, framework = ('yolo', 'ultralytics') if verdict else ('cnn', 'pytorch')
        else:
            # .onnx / .tflite need a different runtime than the wrappers use.
            result['ignored'].append({'filename': filename, 'reason': f'{ext} not supported yet'})
            continue

        if kind == 'yolo':
            # Every detector is kept: a rig can carry several (leaf, weed, pest…)
            # and the analyse endpoint runs them all over the same frame.
            labels = read_yolo_labels(path)
            result['detectors'].append({
                'path': path,
                'filename': filename,
                'framework': framework,
                'role': _detector_role(labels, filename),
                'labels': labels,
                'size_mb': size_mb,
            })
            continue

        if result['cnn'] is not None:
            result['ignored'].append({
                'filename': filename,
                'reason': f"another classifier ({result['cnn']['filename']}) was already loaded",
            })
            continue

        result['cnn'] = {
            'path': path,
            'filename': filename,
            'framework': framework,
            'labels': result['sidecar_labels'],
            'size_mb': size_mb,
        }

    return result


def check_classifier_head(path):
    """Detect a classifier whose output layer was never trained.

    A head left at its initialiser produces a uniform distribution for every
    input — the model loads, runs, and reports a confident-looking result that
    carries no information. That is far worse than a hard failure, so it is
    checked explicitly rather than discovered in the field.

    Glorot-uniform (Keras' default) draws from ±sqrt(6/(fan_in+fan_out)) and
    leaves the bias at zero; matching that signature means untrained.
    Returns (ok: bool, detail: str).
    """
    try:
        import numpy as np
        import tensorflow as tf
    except ImportError:
        return True, 'tensorflow not installed — head not checked'

    try:
        model = tf.keras.models.load_model(path)
    except Exception as e:
        return False, f'will not load: {e}'

    dense = None
    for layer in reversed(model.layers):
        if hasattr(layer, 'get_weights') and len(layer.get_weights()) == 2:
            dense = layer
            break
    if dense is None:
        return True, 'no dense head found to check'

    W, b = dense.get_weights()
    fan_in, fan_out = W.shape[0], W.shape[1]
    glorot_limit = float(np.sqrt(6.0 / (fan_in + fan_out)))

    bias_untouched = bool(np.all(b == 0))
    # A trained kernel drifts off the initialiser's exact bounds; an untrained
    # one still sits inside them to within floating-point noise.
    kernel_at_init = abs(float(W.max()) - glorot_limit) < 1e-4 and \
                     abs(float(W.min()) + glorot_limit) < 1e-4

    if bias_untouched and kernel_at_init:
        return False, (
            f'output layer is untrained (bias all-zero, kernel exactly at the '
            f'Glorot bound ±{glorot_limit:.6f}). It will return a flat '
            f'1/{fan_out} for every image. Retrain or re-export the model.'
        )
    return True, f'head looks trained ({fan_out} classes)'
