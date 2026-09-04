// ============================================
// AI AUTOMATION LOOP
// ============================================
// Drives the "ACTIVATE AI AUTOMATION" button: opens the device camera, then
// grabs a frame on an interval, posts it to the server's /api/analyze (which
// runs every loaded YOLO detector plus the classifier), and reports each
// result back for the action log.
//
// One frame is in flight at a time. Inference takes 150-800 ms per frame with
// two detectors, and a fixed timer would queue requests faster than the server
// drains them; each cycle therefore waits for the previous result and only
// then schedules the next.
// ============================================

import { SERVER_URL } from './server';
import { dataUrlToBlob } from './camera';

export interface AutomationDetection {
    label: string;
    confidence: number;
    bbox: [number, number, number, number];
    /** Which model found it — 'weed', 'leaf', … */
    role: string;
}

export interface AutomationFrame {
    detections: AutomationDetection[];
    /** Pixel size of the frame that was analysed — the box coordinate space. */
    frameWidth: number;
    frameHeight: number;
    byRole: Record<string, { count: number; top: AutomationDetection | null }>;
    summary: string;
    classification: {
        crop: string;
        disease: string;
        confidence: number;
        severity: string;
    } | null;
    /** Present when the server has no usable classifier. */
    classificationUnavailable: string | null;
    inferenceTimeMs: number;
    modelsRun: number;
    frameNumber: number;
}

export interface AutomationHandlers {
    onFrame: (frame: AutomationFrame) => void;
    onError: (message: string, fatal: boolean) => void;
    onStopped?: () => void;
}

const INTERVAL_MS = 4000;
const REQUEST_TIMEOUT_MS = 20000;
/** Consecutive failures tolerated before the loop gives up. */
const MAX_CONSECUTIVE_ERRORS = 3;

let running = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let frameNumber = 0;
let consecutiveErrors = 0;

export function isAutomationRunning(): boolean {
    return running;
}

/** Captures the current frame from a <video> as a JPEG data URL. */
interface Grabbed { dataUrl: string; width: number; height: number; }

function grabFrame(video: HTMLVideoElement): Grabbed | null {
    // videoWidth is 0 until the stream produces its first frame; encoding then
    // yields a blank image the models would happily analyse.
    if (!video.videoWidth || !video.videoHeight) return null;

    const canvas = document.createElement('canvas');
    // Downscale the long edge: YOLO resizes to 640 internally, so sending more
    // costs upload time and encode time without improving detections.
    const maxEdge = 640;
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return {
        dataUrl: canvas.toDataURL('image/jpeg', 0.8),
        width: canvas.width,
        height: canvas.height,
    };
}

async function analyseFrame(dataUrl: string): Promise<any> {
    const body = new FormData();
    body.append('image', dataUrlToBlob(dataUrl), 'frame.jpg');

    let res: Response;
    try {
        res = await fetch(`${SERVER_URL}/api/analyze?annotate=0`, {
            method: 'POST',
            body,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
    } catch {
        throw new Error('AI server unreachable');
    }
    if (!res.ok) throw new Error(`Analysis failed (${res.status})`);
    return res.json();
}

function normalise(raw: any, frameW: number, frameH: number): AutomationFrame {
    const detections: AutomationDetection[] = (raw?.detections ?? []).map((d: any) => ({
        label: String(d.label ?? d.class ?? 'object'),
        confidence: Number(d.confidence ?? 0),
        bbox: (d.bbox ?? [0, 0, 0, 0]) as [number, number, number, number],
        role: String(d.role ?? 'detector'),
    }));

    const byRole: AutomationFrame['byRole'] = {};
    for (const [role, info] of Object.entries<any>(raw?.by_role ?? {})) {
        byRole[role] = {
            count: Number(info?.count ?? 0),
            top: info?.top
                ? {
                    label: String(info.top.label),
                    confidence: Number(info.top.confidence ?? 0),
                    bbox: info.top.bbox,
                    role,
                }
                : null,
        };
    }

    const c = raw?.classification;
    return {
        detections,
        frameWidth: frameW,
        frameHeight: frameH,
        byRole,
        summary: String(raw?.summary ?? 'Scan complete'),
        classification: c
            ? {
                crop: String(c.crop ?? 'Unknown'),
                disease: String(c.disease ?? 'Unknown'),
                confidence: Number(c.confidence ?? 0),
                severity: String(c.severity ?? 'unknown'),
            }
            : null,
        classificationUnavailable: raw?.classification_unavailable ?? null,
        inferenceTimeMs: Number(raw?.inference_time_ms ?? 0),
        modelsRun: Number(raw?.models_run ?? 0),
        frameNumber: ++frameNumber,
    };
}

/**
 * Starts the loop against an already-playing <video>.
 * Caller owns the camera; stopping automation leaves the feed running.
 */
export function startAutomation(video: HTMLVideoElement, handlers: AutomationHandlers): void {
    if (running) return;
    running = true;
    frameNumber = 0;
    consecutiveErrors = 0;

    const cycle = async () => {
        if (!running) return;

        const frame = grabFrame(video);
        if (!frame) {
            // Camera still warming up — retry shortly rather than counting it
            // as an inference failure.
            timer = setTimeout(cycle, 500);
            return;
        }

        try {
            const raw = await analyseFrame(frame.dataUrl);
            // Stopping cannot cancel a request already in flight. Without this
            // check its result still arrives and repaints boxes onto a feed the
            // user has just switched off.
            if (!running) return;
            handlers.onFrame(normalise(raw, frame.width, frame.height));
            consecutiveErrors = 0;
        } catch (err: any) {
            if (!running) return;
            consecutiveErrors += 1;
            const fatal = consecutiveErrors >= MAX_CONSECUTIVE_ERRORS;
            handlers.onError(err?.message || 'Analysis failed', fatal);
            if (fatal) {
                stopAutomation();
                handlers.onStopped?.();
                return;
            }
        }

        if (running) timer = setTimeout(cycle, INTERVAL_MS);
    };

    void cycle();
}

export function stopAutomation(): void {
    running = false;
    if (timer !== null) {
        clearTimeout(timer);
        timer = null;
    }
}
