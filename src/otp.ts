// ============================================
// EMAIL OTP VERIFICATION
// ============================================
// Talks to the Python server's /api/auth/* endpoints, which issue and check
// six-digit codes emailed to the user.
//
// This replaces Firebase's built-in email verification, which sends a link
// rather than a code. Firebase Auth still owns the account and the password;
// only the "is this address real" step moved here.
// ============================================

import { SERVER_URL } from './server';

export interface SendResult {
    sent: boolean;
    expiresInS: number;
    /** True when the server has no SMTP configured and is logging codes. */
    devMode: boolean;
    /** Only present in dev mode — lets the flow be used before mail is set up. */
    devCode?: string;
}

export class OtpError extends Error {
    /** Seconds to wait, when the failure was rate limiting. */
    retryAfterS?: number;
    attemptsRemaining?: number;
    expired?: boolean;
    constructor(message: string, extra: Partial<OtpError> = {}) {
        super(message);
        this.name = 'OtpError';
        Object.assign(this, extra);
    }
}

async function post(path: string, body: unknown): Promise<any> {
    let res: Response;
    try {
        res = await fetch(`${SERVER_URL}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20000),
        });
    } catch {
        throw new OtpError('Verification server unreachable — is the Sprout server running?');
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new OtpError(data.error || `Request failed (${res.status})`, {
            retryAfterS: data.retry_after_s,
            attemptsRemaining: data.attempts_remaining,
            expired: data.expired,
        });
    }
    return data;
}

/** Sends a fresh code to the address. */
export async function sendOtp(email: string): Promise<SendResult> {
    const d = await post('/api/auth/send-otp', { email });
    return {
        sent: !!d.sent,
        expiresInS: Number(d.expires_in_s ?? 600),
        devMode: !!d.dev_mode,
        devCode: d.dev_code,
    };
}

/** Checks a submitted code. Throws OtpError with the reason on failure. */
export async function verifyOtp(email: string, code: string): Promise<void> {
    await post('/api/auth/verify-otp', { email, code });
}

/** Whether the server can actually send mail, for showing a dev-mode notice. */
export async function otpStatus(): Promise<{ devMode: boolean; codeLength: number } | null> {
    try {
        const res = await fetch(`${SERVER_URL}/api/auth/status`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) return null;
        const d = await res.json();
        return { devMode: !!d.dev_mode, codeLength: Number(d.code_length ?? 6) };
    } catch {
        return null;
    }
}
