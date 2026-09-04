# Drop your AI model files in this folder

Any filename works. `best.pt`, `rice_model_v3_FINAL.h5` — whatever your training
run produced. The server identifies each file by type, not by name.

```
server/weights/
├── <your YOLO model>.pt        →  detection
├── <your CNN model>.h5 / .pt   →  classification
└── labels.txt                  →  class names (see below)
```

Then check it was picked up:

```bash
python3 server/check_models.py
```

```
YOLO detector
  my_crop_model_v3_FINAL.pt  (6.2 MB, ultralytics)
  7 classes: Rice Blast, Leaf Blight, Brown Spot, Tungro, …

CNN classifier
  disease_classifier.pt  (4.0 MB, pytorch)
  7 classes: Rice Blast, Leaf Blight, Brown Spot, Tungro, …
```

Anything reported as missing runs in mock mode: the server still starts and the
app still works, it just returns placeholder results instead of real ones.

## How files are identified

| Extension | Goes to | Notes |
|---|---|---|
| `.h5` `.keras` `.hdf5` | CNN classifier | TensorFlow / Keras |
| `.pt` `.pth` | YOLO **or** CNN | decided by inspecting the file, not the name |
| `.onnx` `.tflite` | *not supported yet* | tell me and I'll add the runtime |

Both Ultralytics YOLO and plain PyTorch use `.pt`, so a `.pt` is opened and
checked for the structure Ultralytics writes. A YOLO checkpoint goes to the
detector; anything else goes to the classifier. One model per slot — extra
files of the same kind are listed as skipped rather than silently ignored.

## Class labels

**YOLO**: read straight out of the checkpoint. Nothing to do.

**CNN**: Keras and PyTorch files almost never store class names, so add
`weights/labels.txt` — one class per line, **in your model's output order**:

```
Rice Blast
Leaf Blight
Brown Spot
Tungro
Bacterial Leaf Streak
Sheath Rot
Healthy
```

`labels.json` also works (`["Rice Blast", …]` or `{"0": "Rice Blast", …}`).

Without it, predictions fall back to the hardcoded list in
`models/cnn_classifier.py`, which is only correct for the original training run
— every result would be mislabelled.

## Preprocessing must match your training

The CNN wrapper resizes to **224×224** and scales pixels to **0..1**. If you
trained at another size, or with ImageNet mean/std normalisation, edit
`input_size` and `preprocess()` in `models/cnn_classifier.py`. A mismatch does
not raise an error — it returns confident nonsense.

## Dependencies

```bash
python3 -m venv server/venv
server/venv/bin/pip install -r server/requirements.txt
```

`ultralytics` (which brings `torch`) is already listed. TensorFlow is not — it
is large, so `pip install tensorflow` only if your CNN is a `.h5`.

## Keeping models out of git

This folder is gitignored except for this README, so large weights never get
committed. Copy them to the Pi separately:

```bash
scp server/weights/*.pt pi@raspberrypi.local:~/sprout/server/weights/
```

## Models outside the repo

```bash
export YOLO_MODEL_PATH=/mnt/models/crop_yolo.pt
export CNN_MODEL_PATH=/mnt/models/crop_cnn.h5
```

These override the folder scan entirely.
