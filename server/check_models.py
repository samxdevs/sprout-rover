#!/usr/bin/env python3
"""
Check what the server will find in weights/.

    python3 server/check_models.py

Prints each file it detected, which slot it fills, and its class labels. Run it
after copying models in — it needs no Flask and no camera, so it works before
the server is set up at all.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from model_registry import scan, WEIGHTS_DIR  # noqa: E402

GREEN, YELLOW, RED, DIM, RESET = '\033[92m', '\033[93m', '\033[91m', '\033[2m', '\033[0m'


def main():
    print(f"\nScanning {WEIGHTS_DIR}\n" + "=" * 60)

    if not os.path.isdir(WEIGHTS_DIR):
        print(f"{RED}Folder does not exist.{RESET}")
        return 1

    found = scan()
    any_model = False

    for slot, title in (('yolo', 'YOLO detector'), ('cnn', 'CNN classifier')):
        entry = found[slot]
        print(f"\n{title}")
        if not entry:
            print(f"  {YELLOW}nothing found — this model will return placeholder results{RESET}")
            continue

        any_model = True
        print(f"  {GREEN}{entry['filename']}{RESET}  ({entry['size_mb']} MB, {entry['framework']})")

        labels = entry['labels']
        if labels:
            print(f"  {len(labels)} classes: " + ", ".join(labels[:8]) + (" …" if len(labels) > 8 else ""))
        elif slot == 'yolo':
            print(f"  {YELLOW}labels unreadable — install ultralytics, or they will come from"
                  f" DISEASE_CLASSES in models/yolo_detector.py{RESET}")
        else:
            print(f"  {YELLOW}no labels. Add weights/labels.txt (one class per line, in the model's"
                  f" output order) or predictions will be mislabelled.{RESET}")

    for item in found['ignored']:
        print(f"\n{DIM}skipped {item['filename']}: {item['reason']}{RESET}")

    print("\n" + "=" * 60)
    if not any_model:
        print(f"{YELLOW}No models found. Copy your .pt / .h5 files into:{RESET}\n  {WEIGHTS_DIR}")
    else:
        print(f"{GREEN}Ready.{RESET} Start the server, then verify with:"
              f"\n  curl http://localhost:7860/api/models")
    print()
    return 0


if __name__ == '__main__':
    sys.exit(main())
