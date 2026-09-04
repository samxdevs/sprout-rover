// ============================================
// FIELD MAP
// ============================================
// Leaflet over OpenStreetMap tiles — no API key and no billing account,
// unlike Google Maps or Mapbox.
//
// Two independent position sources share the map:
//   DEVICE — this phone/laptop, via Capacitor Geolocation (native location
//            services on iOS/Android, browser API on web), with IP-based
//            approximation and manual entry as fallbacks. Blue dot.
//   ROVER  — the vehicle's GPS chip (Arduino Uno → Raspberry Pi), polled
//            from the Pi server's /api/gps endpoint. Green dot + trail.
// ============================================

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Geolocation, type Position } from '@capacitor/geolocation';
import { KEYS, getPref, setPref } from './storage';
import { SERVER_URL } from './server';

export interface Telemetry {
    lat: number;
    lon: number;
    /** Degrees clockwise from north, or null when it cannot be determined. */
    heading: number | null;
    /** Metres per second. */
    speed: number;
    /** Horizontal accuracy in metres. */
    accuracy: number;
    timestamp: number;
}

/** A rover fix as reported by the Pi server. */
export interface RoverFix extends Telemetry {
    /** Satellites used in the fix, when the receiver reports it. */
    sats: number | null;
}

let map: L.Map | null = null;
let roverMarker: L.Marker | null = null;
let deviceMarker: L.Marker | null = null;
let accuracyCircle: L.Circle | null = null;
let pathLine: L.Polyline | null = null;
let watchId: string | null = null;
let roverPollTimer: ReturnType<typeof setInterval> | null = null;
let didFitBoth = false;

/** Rover breadcrumb trail for the current session. */
const trail: L.LatLngExpression[] = [];

// Fallback view when there is no fix yet: a wide, unremarkable world view is
// less misleading than dropping the user somewhere specific and wrong.
const FALLBACK_CENTER: L.LatLngExpression = [20, 0];
const FALLBACK_ZOOM = 2;

/**
 * Creates the Leaflet map inside `container`.
 * Safe to call repeatedly — an existing instance is torn down first.
 */
export function initMap(container: HTMLElement): L.Map {
    destroyMap();

    map = L.map(container, {
        zoomControl: false,      // the screen has its own styled buttons
        attributionControl: true,
    }).setView(FALLBACK_CENTER, FALLBACK_ZOOM);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    pathLine = L.polyline([], {
        color: '#2c5926',
        weight: 3,
        dashArray: '8,4',
        opacity: 0.85,
    }).addTo(map);

    return map;
}

// Markers are created on first fix rather than at init, so a source that
// never reports (rover offline, GPS denied) never paints a misleading dot at
// the fallback view. divIcons avoid Leaflet's default marker PNGs, whose
// bundler-relative URLs break under Vite without extra asset wiring.
function ensureRoverMarker(at: L.LatLngExpression): L.Marker | null {
    if (!map) return null;
    if (!roverMarker) {
        roverMarker = L.marker(at, {
            icon: L.divIcon({
                className: 'rover-leaflet-marker',
                html: '<div class="rover-dot"></div>',
                iconSize: [18, 18],
                iconAnchor: [9, 9],
            }),
            zIndexOffset: 200,
        }).addTo(map).bindTooltip('Rover');
    }
    return roverMarker;
}

function ensureDeviceMarker(at: L.LatLngExpression): L.Marker | null {
    if (!map) return null;
    if (!deviceMarker) {
        deviceMarker = L.marker(at, {
            icon: L.divIcon({
                className: 'device-leaflet-marker',
                html: '<div class="device-dot"></div>',
                iconSize: [16, 16],
                iconAnchor: [8, 8],
            }),
            zIndexOffset: 100,
        }).addTo(map).bindTooltip('You');
    }
    return deviceMarker;
}

// The first time both the device and the rover are on the map, widen the view
// to show the pair; after that the user owns the viewport.
function fitBothOnce(): void {
    if (didFitBoth || !map || !roverMarker || !deviceMarker) return;
    didFitBoth = true;
    map.fitBounds(
        L.latLngBounds([roverMarker.getLatLng(), deviceMarker.getLatLng()]),
        { padding: [40, 40], maxZoom: 18 }
    );
}

export function destroyMap(): void {
    stopTracking();
    stopRoverPolling();
    map?.remove();
    map = null;
    roverMarker = null;
    deviceMarker = null;
    accuracyCircle = null;
    pathLine = null;
    trail.length = 0;
    didFitBoth = false;
}

export function isMapReady(): boolean {
    return map !== null;
}

// ============================================
// LOCATION
// ============================================

function toTelemetry(pos: Position): Telemetry {
    const c = pos.coords;
    return {
        lat: c.latitude,
        lon: c.longitude,
        heading: typeof c.heading === 'number' && !Number.isNaN(c.heading) ? c.heading : null,
        speed: typeof c.speed === 'number' && !Number.isNaN(c.speed) ? Math.max(0, c.speed) : 0,
        accuracy: c.accuracy ?? 0,
        timestamp: pos.timestamp,
    };
}

/** Great-circle bearing between two points, for when the OS omits heading. */
function bearingBetween(a: L.LatLngExpression, b: L.LatLngExpression): number {
    const [lat1, lon1] = a as [number, number];
    const [lat2, lon2] = b as [number, number];
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export interface PermissionOutcome {
    granted: boolean;
    /** Set when not granted: a message safe to show the user. */
    message?: string;
    /** True when the user (or browser policy) refused, rather than a transient failure. */
    denied?: boolean;
}

/**
 * Requests location access, driving the OS prompt on native and the browser
 * prompt on web.
 *
 * Must run before watchPosition: on native, watching without an granted
 * permission fails silently, which leaves the UI waiting forever.
 */
export async function ensureLocationPermission(): Promise<PermissionOutcome> {
    try {
        const perm = await Geolocation.checkPermissions();
        if (perm.location === 'granted' || perm.coarseLocation === 'granted') {
            return { granted: true };
        }
        if (perm.location === 'denied') {
            return {
                granted: false,
                denied: true,
                message: 'Location is blocked. Enable it for this site in your browser or system settings.',
            };
        }
        const req = await Geolocation.requestPermissions();
        if (req.location === 'granted' || req.coarseLocation === 'granted') {
            return { granted: true };
        }
        return { granted: false, denied: true, message: 'Location permission denied' };
    } catch {
        // checkPermissions/requestPermissions are not implemented on every web
        // target. Report success and let the actual position call surface any
        // real error, rather than blocking on a missing capability check.
        return { granted: true };
    }
}

/** Requests permission and returns a single fix. */
export async function getCurrentPosition(): Promise<Telemetry> {
    const perm = await ensureLocationPermission();
    if (!perm.granted) throw new Error(perm.message || 'Location permission denied');

    const pos = await Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 15000,
    });
    return toTelemetry(pos);
}

/**
 * Places the rover at a hand-entered coordinate.
 * Lets the map, and the weather that keys off it, work on machines with no
 * usable GPS — desktop browsers, denied permission, indoors.
 */
export function setManualPosition(lat: number, lon: number): Telemetry {
    const t: Telemetry = {
        lat,
        lon,
        heading: null,
        speed: 0,
        accuracy: 0,
        timestamp: Date.now(),
    };
    applyPosition(t, true);
    return t;
}

/**
 * Starts continuous tracking, invoking `onUpdate` for each fix.
 * Returns a stop function.
 */
export async function startTracking(
    onUpdate: (t: Telemetry, isFirstFix: boolean) => void,
    onError?: (message: string, denied: boolean) => void,
    recenterOnFirstFix = true
): Promise<() => void> {
    stopTracking();
    // Owning "first fix" here keeps applyPosition to a single call per update;
    // callers get told which one it was rather than re-applying to recentre.
    let isFirstFix = true;

    // Permission must be settled before watching: watchPosition on native
    // neither prompts nor errors without it, so the screen would sit on
    // "Acquiring GPS" indefinitely.
    const perm = await ensureLocationPermission();
    if (!perm.granted) {
        onError?.(perm.message || 'Location permission denied', true);
        return stopTracking;
    }

    const publish = (t: Telemetry) => {
        applyPosition(t, isFirstFix && recenterOnFirstFix);
        onUpdate(t, isFirstFix);
        isFirstFix = false;
    };

    // A one-shot fix lands far sooner than the first watch callback, which can
    // take tens of seconds; the watch below then keeps it current.
    try {
        publish(toTelemetry(await Geolocation.getCurrentPosition({
            enableHighAccuracy: true,
            timeout: 12000,
        })));
    } catch (err: any) {
        const message = err?.message || 'Could not get position';
        // Report but keep going: the watch may still acquire a fix.
        onError?.(message, /denied|permission/i.test(message));
    }

    try {
        watchId = await Geolocation.watchPosition(
            { enableHighAccuracy: true, timeout: 20000 },
            (pos, err) => {
                if (err || !pos) {
                    const message = err?.message || 'Lost GPS signal';
                    onError?.(message, /denied|permission/i.test(message));
                    return;
                }
                publish(toTelemetry(pos));
            }
        );
    } catch (err: any) {
        const message = err?.message || 'Could not start location tracking';
        onError?.(message, /denied|permission/i.test(message));
    }

    return stopTracking;
}

export function stopTracking(): void {
    if (watchId !== null) {
        Geolocation.clearWatch({ id: watchId }).catch(() => {});
        watchId = null;
    }
}

/**
 * Moves the DEVICE marker and accuracy circle, and stores the fix (which the
 * weather screen also keys off).
 */
export function applyPosition(t: Telemetry, recenter = false): void {
    const point: L.LatLngExpression = [t.lat, t.lon];

    ensureDeviceMarker(point)?.setLatLng(point);

    if (accuracyCircle) {
        accuracyCircle.setLatLng(point).setRadius(t.accuracy);
    } else if (map && t.accuracy > 0) {
        accuracyCircle = L.circle(point, {
            radius: t.accuracy,
            color: '#3b82f6',
            fillColor: '#3b82f6',
            fillOpacity: 0.1,
            weight: 1,
        }).addTo(map);
    }

    if (recenter && map && !didFitBoth) map.setView(point, Math.max(map.getZoom(), 16));
    fitBothOnce();
    void setPref(KEYS.lastPosition, { lat: t.lat, lon: t.lon, timestamp: t.timestamp });
}

/** Moves the ROVER marker and extends its breadcrumb trail. */
export function applyRoverPosition(t: RoverFix, recenter = false): void {
    const point: L.LatLngExpression = [t.lat, t.lon];

    // Sub-metre deltas are GPS jitter, not movement — they get a marker update
    // but no new trail vertex, so the path does not accumulate noise while the
    // rover sits still. Only trail recording is skipped: the marker and any
    // requested recentre still apply, or a stationary first fix would leave the
    // map stranded on its fallback view.
    let recordPoint = true;
    if (trail.length > 0) {
        const prev = trail[trail.length - 1] as [number, number];
        const moved = map ? map.distance(prev, point as L.LatLngTuple) : Infinity;
        if (moved < 1) {
            recordPoint = false;
        } else if (t.heading === null) {
            t.heading = bearingBetween(prev, point);
        }
    }

    if (recordPoint) {
        trail.push(point);
        pathLine?.setLatLngs(trail);
    }

    ensureRoverMarker(point)?.setLatLng(point);

    if (recenter && map && !didFitBoth) map.setView(point, Math.max(map.getZoom(), 17));
    fitBothOnce();
}

/** Last known position from a previous session, for an instant first paint. */
export async function loadLastPosition(): Promise<{ lat: number; lon: number } | null> {
    return getPref<{ lat: number; lon: number } | null>(KEYS.lastPosition, null);
}

/** Centres on the rover when it has reported, else on the device. */
export function centerOnRover(): boolean {
    if (!map) return false;
    const target = roverMarker?.getLatLng() ?? deviceMarker?.getLatLng();
    if (!target) return false;
    map.setView(target, Math.max(map.getZoom(), 17));
    return true;
}

export function zoomBy(delta: number): void {
    if (!map) return;
    map.setZoom(map.getZoom() + delta);
}

export function getTrailLength(): number {
    if (!map || trail.length < 2) return 0;
    let metres = 0;
    for (let i = 1; i < trail.length; i++) {
        metres += map.distance(trail[i - 1] as L.LatLngTuple, trail[i] as L.LatLngTuple);
    }
    return metres;
}

// ============================================
// ROVER GPS — polled from the Pi server
// ============================================
// The rover's GPS chip feeds an Arduino Uno, which streams fixes over USB
// serial to the Raspberry Pi; the Pi server exposes the latest one at
// /api/gps (see server/app.py). Plain short-poll: a fix every few seconds is
// plenty for a walking-pace rover, and it survives flaky field Wi-Fi far
// better than a held-open socket.

const ROVER_POLL_MS = 3000;

export type RoverStatus =
    | { state: 'fix'; fix: RoverFix }
    | { state: 'no_fix'; sats: number | null }   // Pi up, GPS still acquiring
    | { state: 'offline' };                      // Pi server unreachable

async function fetchRoverFix(): Promise<RoverStatus> {
    let res: Response;
    try {
        res = await fetch(`${SERVER_URL}/api/gps`, { signal: AbortSignal.timeout(2500) });
    } catch {
        return { state: 'offline' };
    }
    if (!res.ok) return { state: 'offline' };

    const d = await res.json().catch(() => null);
    if (!d) return { state: 'offline' };

    if (d.status === 'fix' && Number.isFinite(d.lat) && Number.isFinite(d.lon)) {
        return {
            state: 'fix',
            fix: {
                lat: d.lat,
                lon: d.lon,
                heading: Number.isFinite(d.heading) ? d.heading : null,
                speed: Number.isFinite(d.speed) ? Math.max(0, d.speed) : 0,
                accuracy: Number.isFinite(d.accuracy) ? d.accuracy : 0,
                sats: Number.isFinite(d.sats) ? d.sats : null,
                timestamp: Date.now(),
            },
        };
    }
    return { state: 'no_fix', sats: Number.isFinite(d.sats) ? d.sats : null };
}

/**
 * Polls the rover's position and paints it on the map. `onStatus` fires on
 * every poll with the current state, so the UI can show fix/acquiring/offline
 * without owning any timing.
 */
export function startRoverPolling(onStatus: (s: RoverStatus, isFirstFix: boolean) => void): () => void {
    stopRoverPolling();
    let isFirstFix = true;

    const poll = async () => {
        const status = await fetchRoverFix();
        if (status.state === 'fix') {
            applyRoverPosition(status.fix, isFirstFix);
            onStatus(status, isFirstFix);
            isFirstFix = false;
        } else {
            onStatus(status, false);
        }
    };

    void poll();
    roverPollTimer = setInterval(poll, ROVER_POLL_MS);
    return stopRoverPolling;
}

export function stopRoverPolling(): void {
    if (roverPollTimer !== null) {
        clearInterval(roverPollTimer);
        roverPollTimer = null;
    }
}

// ============================================
// IP-BASED DEVICE FALLBACK
// ============================================

/**
 * City-level position from the network address, for devices with no usable
 * GPS — desktop browsers, denied permission, indoors. Good to a few km at
 * best, so the accuracy is set pessimistically and callers should label it
 * approximate.
 */
export async function getApproxPositionFromIP(): Promise<(Telemetry & { city: string | null }) | null> {
    try {
        const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(5000) });
        if (!res.ok) return null;
        const d = await res.json();
        if (!Number.isFinite(d.latitude) || !Number.isFinite(d.longitude)) return null;
        return {
            lat: d.latitude,
            lon: d.longitude,
            heading: null,
            speed: 0,
            accuracy: 5000,
            timestamp: Date.now(),
            city: typeof d.city === 'string' ? d.city : null,
        };
    } catch {
        return null;
    }
}
