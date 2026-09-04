// ============================================
// CAMERA
// ============================================
// Three possible sources for the Control screen's feed, in priority order:
//
//   server  — MJPEG stream from the Python AI server (the real rover camera)
//   device  — this phone/laptop's own camera, for testing without a rover
//   demo    — bundled still image, so the screen is never blank
//
// Capture works against whichever source is live. On native builds the
// device source uses the Capacitor Camera plugin (a real native capture UI);
// on web it uses getUserMedia with a live <video> preview.
// ============================================

import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { KEYS, getPref, setPref } from './storage';

export type FeedSource = 'server' | 'device' | 'demo';

export interface Capture {
    id: string;
    /** Downscaled JPEG data URL — small enough to persist. */
    thumb: string;
    timestamp: number;
    source: FeedSource;
}

/** Full-resolution captures for the current session, keyed by capture id.
 *  Kept in memory only: these are megabytes each and are what gets POSTed
 *  to the inference endpoints. */
const fullResCache = new Map<string, string>();

const MAX_CAPTURES = 12;
const THUMB_MAX_PX = 480;

export function isNative(): boolean {
    return Capacitor.isNativePlatform();
}

// ============================================
// WEB CAMERA (getUserMedia)
// ============================================
let activeStream: MediaStream | null = null;

/**
 * Attaches the device camera to a <video> element.
 * Throws with a human-readable message when permission is refused or no
 * camera exists, so the caller can surface it directly.
 */
export async function startDeviceCamera(video: HTMLVideoElement): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Camera not supported on this device');
    }

    stopDeviceCamera();

    try {
        activeStream = await navigator.mediaDevices.getUserMedia({
            // Rear camera when there is one; harmless on laptops.
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
            audio: false,
        });
    } catch (err: any) {
        const name = err?.name || '';
        if (name === 'NotAllowedError') throw new Error('Camera permission denied');
        if (name === 'NotFoundError') throw new Error('No camera found on this device');
        throw new Error(err?.message || 'Could not start camera');
    }

    video.srcObject = activeStream;
    video.setAttribute('playsinline', 'true'); // iOS Safari would go fullscreen otherwise
    video.muted = true;
    await video.play().catch(() => {
        // Autoplay can be refused; the stream is still attached and the first
        // frame renders, which is enough for a preview.
    });
}

export function stopDeviceCamera(): void {
    activeStream?.getTracks().forEach(t => t.stop());
    activeStream = null;
}

export function isDeviceCameraActive(): boolean {
    return activeStream !== null;
}

// ============================================
// CAPTURE
// ============================================

/** Draws the current frame of a video or image element to a JPEG data URL. */
function elementToDataUrl(
    el: HTMLVideoElement | HTMLImageElement,
    maxPx?: number,
    quality = 0.9
): string {
    const srcW = el instanceof HTMLVideoElement ? el.videoWidth : el.naturalWidth;
    const srcH = el instanceof HTMLVideoElement ? el.videoHeight : el.naturalHeight;
    if (!srcW || !srcH) throw new Error('Feed has no frame to capture yet');

    const scale = maxPx ? Math.min(1, maxPx / Math.max(srcW, srcH)) : 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(srcW * scale);
    canvas.height = Math.round(srcH * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not create canvas context');
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
}

/** Shrinks an existing data URL to thumbnail size for persistence. */
function toThumb(dataUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            try {
                resolve(elementToDataUrl(img, THUMB_MAX_PX, 0.6));
            } catch (e) {
                reject(e);
            }
        };
        img.onerror = () => reject(new Error('Could not read captured image'));
        img.src = dataUrl;
    });
}

/**
 * Captures from the live web feed element (video or img).
 * Note: capturing from an <img> pointed at a cross-origin MJPEG stream taints
 * the canvas and throws — the AI server must send CORS headers for that path.
 */
export async function captureFromElement(
    el: HTMLVideoElement | HTMLImageElement,
    source: FeedSource
): Promise<Capture> {
    let full: string;
    try {
        full = elementToDataUrl(el);
    } catch (err: any) {
        if (err?.name === 'SecurityError') {
            throw new Error('Stream blocked capture (server needs CORS headers)');
        }
        throw err;
    }
    return storeCapture(full, source);
}

/** Opens the native camera UI and returns the resulting capture. */
export async function captureNative(): Promise<Capture> {
    const photo = await Camera.getPhoto({
        quality: 90,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Camera,
        correctOrientation: true,
    });
    if (!photo.dataUrl) throw new Error('Capture returned no image');
    return storeCapture(photo.dataUrl, 'device');
}

/** Lets the user pick an existing photo — useful for testing inference. */
export async function pickFromGallery(): Promise<Capture> {
    const photo = await Camera.getPhoto({
        quality: 90,
        resultType: CameraResultType.DataUrl,
        source: CameraSource.Photos,
        correctOrientation: true,
    });
    if (!photo.dataUrl) throw new Error('No image selected');
    return storeCapture(photo.dataUrl, 'device');
}

async function storeCapture(fullDataUrl: string, source: FeedSource): Promise<Capture> {
    const id = `cap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const capture: Capture = {
        id,
        thumb: await toThumb(fullDataUrl),
        timestamp: Date.now(),
        source,
    };

    fullResCache.set(id, fullDataUrl);

    const existing = await listCaptures();
    const next = [capture, ...existing].slice(0, MAX_CAPTURES);
    await setPref(KEYS.captures, next);

    // Drop full-res data for captures that fell off the end of the list.
    const liveIds = new Set(next.map(c => c.id));
    for (const key of fullResCache.keys()) {
        if (!liveIds.has(key)) fullResCache.delete(key);
    }

    return capture;
}

export async function listCaptures(): Promise<Capture[]> {
    return getPref<Capture[]>(KEYS.captures, []);
}

export async function clearCaptures(): Promise<void> {
    fullResCache.clear();
    await setPref(KEYS.captures, []);
}

/** Full-resolution image if still cached this session, else the thumbnail. */
export function getCaptureImage(capture: Capture): string {
    return fullResCache.get(capture.id) ?? capture.thumb;
}

/** Converts a data URL to a Blob for multipart upload to the AI server. */
export function dataUrlToBlob(dataUrl: string): Blob {
    const [header, b64] = dataUrl.split(',');
    const mime = /:(.*?);/.exec(header)?.[1] || 'image/jpeg';
    const bytes = atob(b64);
    const buf = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    return new Blob([buf], { type: mime });
}
