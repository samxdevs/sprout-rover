// ============================================
// SERVER CONNECTION MODULE
// ============================================
// Handles:
// - WebSocket connection to AI server (Socket.IO)
// - MJPEG live stream URL management
// - REST API calls to AI endpoints
// ============================================

// Change this to your Hugging Face Spaces URL after deployment:
// e.g. 'https://YOUR-USERNAME-sprout-ai-server.hf.space'
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:7860';
const STREAM_URL = `${SERVER_URL}/api/stream`;

// ============================================
// SERVER STATUS
// ============================================
let isServerOnline = false;

/**
 * Check if the AI server is online.
 */
export async function checkServerHealth(): Promise<boolean> {
    try {
        const response = await fetch(`${SERVER_URL}/api/health`, {
            signal: AbortSignal.timeout(3000),
        });
        const data = await response.json();
        isServerOnline = data.status === 'online';
        return isServerOnline;
    } catch {
        isServerOnline = false;
        return false;
    }
}

/**
 * Get the live stream URL. Returns MJPEG endpoint if server is online,
 * or falls back to static image.
 */
export function getStreamUrl(): string {
    return isServerOnline ? STREAM_URL : '/images/rover-field.png';
}

/**
 * Try to connect the live feed image to the MJPEG stream.
 */
export async function connectLiveStream(imgElement: HTMLImageElement): Promise<boolean> {
    const online = await checkServerHealth();
    if (online) {
        imgElement.src = STREAM_URL;
        return true;
    }
    return false;
}

// ============================================
// REST API CALLS
// ============================================

/**
 * Send an image to the YOLOv8 detection endpoint.
 */
export async function detectDiseases(imageFile: File | Blob): Promise<any> {
    const formData = new FormData();
    formData.append('image', imageFile);

    const response = await fetch(`${SERVER_URL}/api/detect`, {
        method: 'POST',
        body: formData,
    });
    return response.json();
}

/**
 * Send an image to the CNN classification endpoint.
 */
export async function classifyDisease(imageFile: File | Blob): Promise<any> {
    const formData = new FormData();
    formData.append('image', imageFile);

    const response = await fetch(`${SERVER_URL}/api/classify`, {
        method: 'POST',
        body: formData,
    });
    return response.json();
}

/**
 * Get path planning results.
 */
export async function planPath(
    waypoints: Array<{ lat: number; lon: number }>,
    obstacles: Array<{ lat: number; lon: number; radius: number }> = [],
    currentPosition?: { lat: number; lon: number }
): Promise<any> {
    const response = await fetch(`${SERVER_URL}/api/path`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ waypoints, obstacles, current_position: currentPosition }),
    });
    return response.json();
}

/**
 * Capture a single frame from the camera.
 */
export async function captureFrame(): Promise<string | null> {
    try {
        const response = await fetch(`${SERVER_URL}/api/capture`, { method: 'POST' });
        const data = await response.json();
        return data.image || null;
    } catch {
        return null;
    }
}

// ============================================
// WEBSOCKET CONNECTION (Socket.IO)
// ============================================
// Note: For production, install socket.io-client:
//   npm install socket.io-client
// For now, we use a polling-based fallback.
// ============================================

type EventCallback = (data: any) => void;
const eventListeners: Record<string, EventCallback[]> = {};

/**
 * Register a listener for server events.
 */
export function onServerEvent(event: string, callback: EventCallback) {
    if (!eventListeners[event]) eventListeners[event] = [];
    eventListeners[event].push(callback);
}

/**
 * Emit a server event (triggers local listeners + sends to server if connected).
 */
function emitLocal(event: string, data: any) {
    const listeners = eventListeners[event] || [];
    listeners.forEach(cb => cb(data));
}

/**
 * Start polling for telemetry data (fallback when Socket.IO is not available).
 */
let telemetryInterval: ReturnType<typeof setInterval> | null = null;

export function startTelemetryPolling(intervalMs: number = 2000) {
    if (telemetryInterval) return;

    telemetryInterval = setInterval(async () => {
        if (!isServerOnline) return;

        try {
            const response = await fetch(`${SERVER_URL}/api/health`);
            const data = await response.json();
            emitLocal('server_status', data);
        } catch {
            isServerOnline = false;
            emitLocal('server_status', { status: 'offline' });
        }
    }, intervalMs);
}

export function stopTelemetryPolling() {
    if (telemetryInterval) {
        clearInterval(telemetryInterval);
        telemetryInterval = null;
    }
}

// Export constants
export { SERVER_URL, STREAM_URL, isServerOnline };
