// ============================================
// DETECTION OVERLAY
// ============================================
// Draws bounding boxes over the live camera feed.
//
// Boxes arrive in the pixel space of the frame that was *analysed*, which is
// not the space the video is *displayed* in. Two transforms sit between them:
//
//   1. Downscale — automation.ts shrinks the frame to a 640px long edge before
//      upload, so a box at x=320 in the analysed frame is at x=960 in a 1920px
//      camera feed.
//   2. object-fit: cover — the element crops the video to fill its box,
//      centring the overflow. A naive width ratio would misplace every box
//      along the cropped axis.
//
// The feed's zoom is deliberately *not* applied here: the canvas carries the
// same CSS transform as the video, so the browser scales boxes and picture
// together and they stay locked.
// ============================================

export interface OverlayBox {
    label: string;
    confidence: number;
    /** [x1, y1, x2, y2] in the analysed frame's pixel space. */
    bbox: [number, number, number, number];
    role: string;
}

// Matches the server-side annotate() palette and the app's tokens.
const ROLE_COLOURS: Record<string, string> = {
    weed: '#dc2626',
    leaf: '#2cc85a',
    detector: '#7c3aed',
};

/**
 * Maps analysed-frame coordinates to displayed-element coordinates.
 * `frameW/H` is the size of the image that was sent for inference.
 */
function makeMapper(video: HTMLVideoElement, frameW: number, frameH: number) {
    const elW = video.clientWidth;
    const elH = video.clientHeight;
    const vidW = video.videoWidth || frameW;
    const vidH = video.videoHeight || frameH;

    // Step 1: analysed frame -> native video pixels.
    const toNativeX = vidW / frameW;
    const toNativeY = vidH / frameH;

    // Step 2: native video -> element, replicating object-fit: cover.
    const cover = Math.max(elW / vidW, elH / vidH);
    const renderedW = vidW * cover;
    const renderedH = vidH * cover;
    const offsetX = (elW - renderedW) / 2;
    const offsetY = (elH - renderedH) / 2;

    return {
        x: (v: number) => v * toNativeX * cover + offsetX,
        y: (v: number) => v * toNativeY * cover + offsetY,
        elW,
        elH,
    };
}

/** Clears and redraws the overlay for one set of detections. */
export function drawBoxes(
    canvas: HTMLCanvasElement,
    video: HTMLVideoElement,
    boxes: OverlayBox[],
    frameW: number,
    frameH: number
): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const map = makeMapper(video, frameW, frameH);

    // Back the canvas at device resolution so strokes and text are not blurry
    // on a retina screen, then work in CSS pixels.
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(map.elW * dpr) || canvas.height !== Math.round(map.elH * dpr)) {
        canvas.width = Math.round(map.elW * dpr);
        canvas.height = Math.round(map.elH * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, map.elW, map.elH);

    ctx.lineWidth = 2;
    ctx.font = '600 12px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'top';

    for (const box of boxes) {
        const [x1, y1, x2, y2] = box.bbox;
        const left = map.x(x1);
        const top = map.y(y1);
        const width = map.x(x2) - left;
        const height = map.y(y2) - top;
        const colour = ROLE_COLOURS[box.role] ?? ROLE_COLOURS.detector;

        ctx.strokeStyle = colour;
        ctx.strokeRect(left, top, width, height);

        const caption = `${box.label} ${Math.round(box.confidence * 100)}%`;
        const textW = ctx.measureText(caption).width;
        const padX = 5;
        const labelH = 17;
        // Above the box normally; tucked inside when it would fall off the top.
        const labelY = top - labelH >= 0 ? top - labelH : top;

        ctx.fillStyle = colour;
        ctx.fillRect(left, labelY, textW + padX * 2, labelH);
        ctx.fillStyle = '#fff';
        ctx.fillText(caption, left + padX, labelY + 3);
    }
}

/** Removes every box. */
export function clearBoxes(canvas: HTMLCanvasElement): void {
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
}
