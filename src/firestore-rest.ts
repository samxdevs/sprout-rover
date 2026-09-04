// ============================================
// FIRESTORE OVER REST
// ============================================
// Profile data access via the Firestore REST API instead of the Firestore
// SDK.
//
// Why: the SDK's realtime transport (WebChannel / streaming fetch) fails to
// establish inside Capacitor's WKWebView — verified on the iOS simulator,
// where an SDK getDoc stayed pending past 12s even with
// experimentalForceLongPolling, while Firebase Auth's plain REST calls from
// the same WebView worked fine. Worse, SDK writes never reject on transport
// failure (they wait for connectivity by design), which is exactly the
// sign-up button hanging on "Please wait..." forever.
//
// The REST API is ordinary request/response HTTPS: it works from
// capacitor:// origins, and failures surface as real rejections with real
// messages. Security rules apply to REST exactly as they do to the SDK; the
// user's identity travels as a Bearer ID token from Firebase Auth.
// ============================================

import { auth } from './firebase';

const PROJECT_ID = import.meta.env.VITE_FIREBASE_PROJECT_ID;
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const TIMEOUT_MS = 15000;

// ============================================
// VALUE ENCODING
// ============================================
// Firestore REST wraps every value in a typed envelope: "x" becomes
// { stringValue: "x" }, nested objects become mapValue, and so on.

type RestValue = Record<string, unknown>;

function encodeValue(value: unknown): RestValue {
    if (value === null || value === undefined) return { nullValue: 'NULL_VALUE' };
    if (typeof value === 'string') return { stringValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (typeof value === 'number') {
        return Number.isInteger(value)
            ? { integerValue: String(value) }
            : { doubleValue: value };
    }
    if (value instanceof Date) return { timestampValue: value.toISOString() };
    if (Array.isArray(value)) {
        return { arrayValue: { values: value.map(encodeValue) } };
    }
    if (typeof value === 'object') {
        return { mapValue: { fields: encodeFields(value as Record<string, unknown>) } };
    }
    // Symbols/functions have no Firestore representation; storing their string
    // form would be silent corruption, so refuse loudly.
    throw new Error(`Cannot store value of type ${typeof value} in Firestore`);
}

function encodeFields(obj: Record<string, unknown>): Record<string, RestValue> {
    const fields: Record<string, RestValue> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (value === undefined) continue;
        fields[key] = encodeValue(value);
    }
    return fields;
}

function decodeValue(value: RestValue): unknown {
    if ('stringValue' in value) return value.stringValue;
    if ('booleanValue' in value) return value.booleanValue;
    if ('integerValue' in value) return Number(value.integerValue);
    if ('doubleValue' in value) return value.doubleValue;
    if ('timestampValue' in value) return value.timestampValue; // ISO string
    if ('nullValue' in value) return null;
    if ('mapValue' in value) {
        return decodeFields((value.mapValue as { fields?: Record<string, RestValue> }).fields ?? {});
    }
    if ('arrayValue' in value) {
        const items = (value.arrayValue as { values?: RestValue[] }).values ?? [];
        return items.map(decodeValue);
    }
    return null;
}

function decodeFields(fields: Record<string, RestValue>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) out[key] = decodeValue(value);
    return out;
}

// ============================================
// TRANSPORT
// ============================================

async function authHeader(): Promise<Record<string, string>> {
    const user = auth.currentUser;
    if (!user) return {};
    try {
        return { Authorization: `Bearer ${await user.getIdToken()}` };
    } catch {
        // An expired/unrefreshable token falls through to an unauthenticated
        // request, which the security rules then reject with a clear 403.
        return {};
    }
}

async function request(
    method: 'GET' | 'PATCH' | 'DELETE',
    pathAndQuery: string,
    body?: unknown
): Promise<any | null> {
    let res: Response;
    try {
        res = await fetch(`${BASE}/${pathAndQuery}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(await authHeader()),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch (err: any) {
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
            throw new Error('Firestore request timed out — check your connection and try again.');
        }
        throw new Error('Could not reach Firestore — check your connection and try again.');
    }

    if (res.status === 404) return null;

    if (!res.ok) {
        const detail = await res.json().catch(() => null);
        const status = detail?.error?.status ?? String(res.status);
        if (status === 'PERMISSION_DENIED') {
            throw new Error('Permission denied by Firestore security rules.');
        }
        if (status === 'FAILED_PRECONDITION') {
            // Raised by currentDocument.exists=true when the doc is missing.
            return null;
        }
        throw new Error(detail?.error?.message || `Firestore error (${status})`);
    }

    return res.json();
}

// ============================================
// DOCUMENT OPERATIONS
// ============================================

/** Reads a document. Returns null when it does not exist. */
export async function getDocument(path: string): Promise<Record<string, unknown> | null> {
    const doc = await request('GET', path);
    if (!doc) return null;
    return decodeFields(doc.fields ?? {});
}

/** Creates or fully replaces a document. */
export async function setDocument(path: string, data: Record<string, unknown>): Promise<void> {
    await request('PATCH', path, { fields: encodeFields(data) });
}

/** Writes an object value at a dotted path inside a plain nested object. */
function setDeep(target: Record<string, unknown>, dottedPath: string, value: unknown): void {
    const parts = dottedPath.split('.');
    let node = target;
    for (const part of parts.slice(0, -1)) {
        node = (node[part] ??= {}) as Record<string, unknown>;
    }
    node[parts[parts.length - 1]] = value;
}

/**
 * Patches only the given dotted field paths (e.g. "roverConfig.roverId"),
 * leaving every other field untouched — same semantics as the SDK's
 * updateDoc. Throws if the document does not exist.
 */
export async function updateDocument(
    path: string,
    fields: Record<string, unknown>
): Promise<void> {
    const mask = Object.keys(fields)
        .map(p => `updateMask.fieldPaths=${encodeURIComponent(p)}`)
        .join('&');

    const nested: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) setDeep(nested, key, value);

    const result = await request(
        'PATCH',
        `${path}?${mask}&currentDocument.exists=true`,
        { fields: encodeFields(nested) }
    );
    if (result === null) {
        throw new Error('Profile not found — sign out and back in to recreate it.');
    }
}
