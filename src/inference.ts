// ============================================
// AI INFERENCE
// ============================================
// Sends captured frames to the Python server's model endpoints and normalises
// the responses into one shape the Diagnostics screen can render.
//
// The server contract (server/app.py):
//   POST /api/classify -> { crop, disease, confidence, severity, treatment? }
//   POST /api/detect   -> { detections: [{class, confidence, bbox}], ... }
//
// Confidence arrives as a 0..1 float from both endpoints.
// ============================================

import { SERVER_URL } from './server';
import { dataUrlToBlob } from './camera';

export interface Detection {
    label: string;
    confidence: number;
    bbox: [number, number, number, number];
    /** Which model produced it — 'weed', 'leaf', … */
    role: string;
}

export interface Treatment {
    product?: string;
    activeIngredient?: string;
    dosage?: string;
    method?: string;
}

export interface InferenceResult {
    crop: string;
    disease: string;
    /** 0..1 */
    confidence: number;
    severity: string;
    treatment: Treatment | null;
    detections: Detection[];
    /** Runner-up classes, most likely first. */
    alternatives: { label: string; confidence: number }[];
    /** One-line detector summary from the server. */
    summary: string;
    /** The analysed frame with boxes drawn on it, as a data URL. */
    annotatedImage: string | null;
    /** Set when the server has no usable classifier. */
    classifierUnavailable: string | null;
    inferenceTimeMs: number | null;
    timestamp: number;
}

export class ServerOfflineError extends Error {
    constructor() {
        super('AI server offline — start server/app.py to run inference');
        this.name = 'ServerOfflineError';
    }
}

function toFormData(dataUrl: string): FormData {
    const fd = new FormData();
    fd.append('image', dataUrlToBlob(dataUrl), 'capture.jpg');
    return fd;
}

async function postImage(path: string, dataUrl: string, timeoutMs: number): Promise<any> {
    let res: Response;
    try {
        res = await fetch(`${SERVER_URL}${path}`, {
            method: 'POST',
            body: toFormData(dataUrl),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch {
        // Network-level failure: server down, DNS, CORS preflight rejected.
        throw new ServerOfflineError();
    }

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Inference failed (${res.status})${body ? `: ${body.slice(0, 140)}` : ''}`);
    }
    return res.json();
}

/**
 * Normalises the treatment block, which the server may return either as a
 * nested object or as flat fields depending on the model bundle.
 */
function normaliseTreatment(raw: any): Treatment | null {
    const t = raw?.treatment ?? raw;
    if (!t || typeof t !== 'object') return null;
    const treatment: Treatment = {
        product: t.product ?? t.name ?? undefined,
        activeIngredient: t.active_ingredient ?? t.activeIngredient ?? undefined,
        dosage: t.dosage ?? t.dose ?? undefined,
        method: t.method ?? t.application_method ?? undefined,
    };
    return Object.values(treatment).some(Boolean) ? treatment : null;
}

/**
 * Runs classification and detection on one frame.
 *
 * Detection is best-effort: a missing or failing /api/detect still yields a
 * usable classification result rather than failing the whole analysis.
 */
export async function analyseCapture(dataUrl: string): Promise<InferenceResult> {
    // /api/analyze runs every loaded detector *and* the classifier in one
    // pass, and returns the frame with boxes drawn on it. The older
    // /api/classify path only reached the classifier, so detections from the
    // YOLO models never appeared on this screen.
    const raw = await postImage('/api/analyze', dataUrl, 40000);

    const detections: Detection[] = (raw?.detections ?? []).map((d: any) => ({
        label: String(d.label ?? d.class ?? 'object'),
        confidence: Number(d.confidence ?? 0),
        bbox: (d.bbox ?? [0, 0, 0, 0]) as [number, number, number, number],
        role: String(d.role ?? 'detector'),
    }));

    const c = raw?.classification;

    return {
        crop: String(c?.crop ?? 'Unknown'),
        disease: String(c?.disease ?? (c ? 'Unknown' : 'No disease classifier')),
        confidence: Number(c?.confidence ?? 0),
        severity: String(c?.severity ?? 'unknown'),
        treatment: c ? normaliseTreatment(c) : null,
        detections,
        // Ranked runners-up: a 49/28% split is a far weaker call than 95/2%,
        // and the farmer should be able to see which one they have.
        alternatives: (c?.top_k ?? []).slice(1).map((k: any) => ({
            label: String(k.label ?? ''),
            confidence: Number(k.confidence ?? 0),
        })),
        summary: String(raw?.summary ?? ''),
        annotatedImage: raw?.annotated_image ?? null,
        classifierUnavailable: raw?.classification_unavailable ?? null,
        inferenceTimeMs: raw?.inference_time_ms ?? null,
        timestamp: Date.now(),
    };
}

/** Maps a severity string to a display label and a 0..1 bar position. */
export function severityMeta(severity: string): { label: string; level: number; color: string } {
    const s = severity.toLowerCase();
    if (s.includes('high') || s.includes('severe')) {
        return { label: 'HIGH RISK', level: 0.9, color: 'var(--red)' };
    }
    if (s.includes('moderate') || s.includes('medium')) {
        return { label: 'MODERATE', level: 0.55, color: 'var(--orange)' };
    }
    if (s.includes('low') || s.includes('mild')) {
        return { label: 'LOW RISK', level: 0.25, color: 'var(--green-success)' };
    }
    if (s.includes('healthy') || s.includes('none')) {
        return { label: 'HEALTHY', level: 0.05, color: 'var(--green-success)' };
    }
    return { label: severity.toUpperCase() || 'UNKNOWN', level: 0.5, color: 'var(--text-muted)' };
}
