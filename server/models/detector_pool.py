"""
Detector pool
=============
Runs every YOLO detector in weights/ over the same frame and merges the
results, so a rig carrying a leaf detector plus a weed detector produces one
combined answer rather than the caller orchestrating each model.

Models are loaded once at construction; Ultralytics keeps them warm, so
per-frame cost is inference only. Loading is lazy-per-model and failures are
isolated — one bad checkpoint disables itself instead of taking the pool down.
"""

import logging
import time

logger = logging.getLogger('sprout-server.detectors')


class DetectorPool:
    def __init__(self, entries, conf_threshold=0.25):
        """entries: the `detectors` list from model_registry.scan()."""
        self.conf_threshold = conf_threshold
        self.models = []

        for entry in entries:
            try:
                from ultralytics import YOLO
                model = YOLO(entry['path'])
                self.models.append({
                    'model': model,
                    'role': entry['role'],
                    'filename': entry['filename'],
                    'labels': entry.get('labels') or [],
                })
                logger.info(
                    f"✅ detector '{entry['role']}' loaded: {entry['filename']} "
                    f"({len(entry.get('labels') or [])} classes)"
                )
            except ImportError:
                logger.error("❌ ultralytics not installed — detectors disabled")
                return
            except Exception as e:
                logger.error(f"❌ failed to load {entry['filename']}: {e}")

    def is_loaded(self):
        return len(self.models) > 0

    def describe(self):
        return [
            {'role': m['role'], 'filename': m['filename'], 'classes': len(m['labels'])}
            for m in self.models
        ]

    def detect(self, image_np):
        """Run every detector over one frame.

        Returns {detections: [...], by_role: {...}, inference_time_ms, models_run}
        with each detection carrying the role that produced it, so the caller
        can tell a weed hit from a leaf hit without re-deriving it from labels.
        """
        started = time.time()
        detections = []
        by_role = {}

        for entry in self.models:
            role = entry['role']
            try:
                result = entry['model'].predict(
                    image_np, verbose=False, conf=self.conf_threshold
                )[0]
            except Exception as e:
                logger.error(f"detector {entry['filename']} failed: {e}")
                by_role[role] = {'error': str(e), 'count': 0}
                continue

            names = entry['model'].names
            found = []
            for box in result.boxes:
                cls_id = int(box.cls)
                x1, y1, x2, y2 = (float(v) for v in box.xyxy[0])
                found.append({
                    'label': names.get(cls_id, str(cls_id)) if isinstance(names, dict)
                             else str(cls_id),
                    'confidence': round(float(box.conf), 4),
                    'bbox': [round(x1), round(y1), round(x2), round(y2)],
                    'role': role,
                })

            found.sort(key=lambda d: d['confidence'], reverse=True)
            detections.extend(found)
            by_role[role] = {
                'count': len(found),
                'top': found[0] if found else None,
                'model': entry['filename'],
            }

        detections.sort(key=lambda d: d['confidence'], reverse=True)
        return {
            'detections': detections,
            'by_role': by_role,
            'inference_time_ms': round((time.time() - started) * 1000, 1),
            'models_run': len(self.models),
        }

    def annotate(self, image_np, detections):
        """Draw the boxes onto a copy of the frame and return it as JPEG bytes.

        Rendering server-side keeps the app from having to re-derive box
        geometry: coordinates are already in the analysed image's pixel space,
        so a client scaling the photo for display would otherwise have to
        rescale every box to match.
        """
        from PIL import Image, ImageDraw, ImageFont
        import io

        # Per-role colours so a weed hit is distinguishable from a leaf hit at
        # a glance. RGB, matching the app's palette.
        colours = {
            'weed': (220, 38, 38),      # red   — the thing to act on
            'leaf': (44, 200, 90),      # green — crop canopy
            'detector': (124, 58, 237), # purple — anything unlabelled
        }

        img = Image.fromarray(image_np).convert('RGB')
        draw = ImageDraw.Draw(img)
        # Thicker strokes on big frames, so boxes stay visible when the image
        # is scaled down to phone width.
        width = max(2, round(min(img.size) / 200))

        try:
            font = ImageFont.load_default(size=max(13, round(min(img.size) / 40)))
        except TypeError:
            font = ImageFont.load_default()   # Pillow < 10 has no size argument

        for det in detections:
            x1, y1, x2, y2 = det['bbox']
            colour = colours.get(det['role'], colours['detector'])
            draw.rectangle([x1, y1, x2, y2], outline=colour, width=width)

            caption = f"{det['label']} {det['confidence']:.0%}"
            box = draw.textbbox((0, 0), caption, font=font)
            tw, th = box[2] - box[0], box[3] - box[1]
            pad = 4
            # Above the box normally, inside it when the box touches the top
            # edge, so the caption is never clipped off-frame.
            ly = y1 - th - pad * 2 if y1 - th - pad * 2 >= 0 else y1
            draw.rectangle([x1, ly, x1 + tw + pad * 2, ly + th + pad * 2], fill=colour)
            draw.text((x1 + pad, ly + pad), caption, fill=(255, 255, 255), font=font)

        buf = io.BytesIO()
        img.save(buf, format='JPEG', quality=85)
        return buf.getvalue()

    def summarise(self, result):
        """One line for the app's AI action log."""
        by_role = result['by_role']
        weeds = by_role.get('weed', {}).get('count', 0)
        leaves = by_role.get('leaf', {}).get('count', 0)

        parts = []
        if weeds:
            top = by_role['weed']['top']
            parts.append(f"{weeds} weed{'s' if weeds > 1 else ''} ({top['label']} {top['confidence']:.0%})")
        if leaves:
            parts.append(f"{leaves} leaf region{'s' if leaves > 1 else ''}")
        if not parts:
            return 'Scan clear — nothing detected'
        return 'Detected ' + ', '.join(parts)
