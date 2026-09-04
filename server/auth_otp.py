"""
Email OTP verification
======================
Issues and checks one-time codes for sign-up verification.

Firebase's built-in email verification sends a *link*, not a code. A typed
code needs an email sender of our own, which is what this module provides.

Security choices, and why:

- Codes are stored as salted SHA-256 hashes, never in plaintext. A dump of
  server memory or a log leak must not hand over working codes.
- Verification compares with `hmac.compare_digest` so a wrong code takes the
  same time as a right one, closing the timing side channel.
- Five wrong attempts burn the code. Six digits is 1,000,000 possibilities,
  which is only meaningful protection if guesses are capped.
- One code per email at a time; requesting a new one replaces the old.
- Resends are rate limited, so the endpoint cannot be used to flood someone
  else's inbox.
"""

import hashlib
import hmac
import logging
import os
import re
import secrets
import smtplib
import threading
import time
from email.message import EmailMessage

logger = logging.getLogger('sprout-server.otp')

CODE_LENGTH = 6
CODE_TTL_S = 10 * 60          # 10 minutes
MAX_ATTEMPTS = 5
RESEND_COOLDOWN_S = 60
MAX_SENDS_PER_HOUR = 6

EMAIL_RE = re.compile(r'^[^@\s]+@[^@\s]+\.[a-zA-Z]{2,}$')

# --- SMTP configuration (all optional; without them we run in dev mode) ---
SMTP_HOST = os.environ.get('SMTP_HOST', '')
SMTP_PORT = int(os.environ.get('SMTP_PORT', '587'))
SMTP_USER = os.environ.get('SMTP_USER', '')
SMTP_PASS = os.environ.get('SMTP_PASS', '')
SMTP_FROM = os.environ.get('SMTP_FROM', SMTP_USER or 'no-reply@sprout.local')
SMTP_TLS = os.environ.get('SMTP_TLS', '1') != '0'

# Without SMTP credentials the code is logged instead of emailed, so the whole
# flow is testable before mail is configured. Never enable this in production:
# anyone who can read the logs can verify any account.
DEV_MODE = not (SMTP_HOST and SMTP_USER and SMTP_PASS)
DEV_ECHO_CODE = os.environ.get('OTP_DEV_ECHO', '1') != '0'


class _Entry:
    __slots__ = ('code_hash', 'salt', 'expires_at', 'attempts', 'sent_at', 'sends')

    def __init__(self, code_hash, salt, expires_at, sent_at, sends):
        self.code_hash = code_hash
        self.salt = salt
        self.expires_at = expires_at
        self.attempts = 0
        self.sent_at = sent_at
        self.sends = sends


_store = {}
_lock = threading.Lock()


def _hash(code, salt):
    return hashlib.sha256(salt + code.encode()).hexdigest()


def _normalise(email):
    return (email or '').strip().lower()


def _purge_expired(now):
    """Drop entries past their TTL. Called on each request — the store holds
    one small object per pending sign-up, so no background sweeper is needed."""
    for key in [k for k, v in _store.items() if v.expires_at < now - 3600]:
        _store.pop(key, None)


def _render_email(code, to_addr):
    msg = EmailMessage()
    msg['Subject'] = f'{code} is your Sprout verification code'
    msg['From'] = SMTP_FROM
    msg['To'] = to_addr
    minutes = CODE_TTL_S // 60
    msg.set_content(
        f"Your Sprout verification code is:\n\n"
        f"    {code}\n\n"
        f"Enter it in the app to finish setting up your account.\n"
        f"The code expires in {minutes} minutes.\n\n"
        f"If you did not request this, you can ignore this email."
    )
    msg.add_alternative(f"""\
<html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f0f4f0;padding:32px">
  <div style="max-width:440px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;text-align:center">
    <div style="width:56px;height:56px;background:#2c5926;border-radius:50%;margin:0 auto 16px"></div>
    <h1 style="margin:0 0 4px;font-size:22px;color:#1a1a1a">Verify your email</h1>
    <p style="margin:0 0 24px;color:#6b7280;font-size:14px">Enter this code in the Sprout app</p>
    <div style="font-size:36px;font-weight:700;letter-spacing:10px;color:#2c5926;
                background:#e8f0e7;border-radius:12px;padding:18px 12px;margin-bottom:20px">{code}</div>
    <p style="margin:0;color:#9ca3af;font-size:13px">Expires in {minutes} minutes.
       If you did not request this, ignore this email.</p>
  </div>
</body></html>""", subtype='html')
    return msg


def _send_email(code, to_addr):
    """Deliver the code. Returns (ok, detail)."""
    if DEV_MODE:
        logger.warning(f"📧 [DEV MODE — no SMTP configured] code for {to_addr}: {code}")
        return True, 'dev'

    try:
        if SMTP_PORT == 465:
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15)
        with server:
            if SMTP_PORT != 465 and SMTP_TLS:
                server.starttls()
            server.login(SMTP_USER, SMTP_PASS)
            server.send_message(_render_email(code, to_addr))
        logger.info(f"📧 verification code sent to {to_addr}")
        return True, 'sent'
    except Exception as e:
        logger.error(f"❌ SMTP send failed for {to_addr}: {e}")
        return False, str(e)


def request_code(email):
    """Issue a code and email it.

    Returns (status_code, payload) ready to hand to jsonify.
    """
    email = _normalise(email)
    if not EMAIL_RE.match(email):
        return 400, {'error': 'A valid email address is required'}

    now = time.time()
    with _lock:
        _purge_expired(now)
        existing = _store.get(email)

        if existing:
            waited = now - existing.sent_at
            if waited < RESEND_COOLDOWN_S:
                return 429, {
                    'error': 'Please wait before requesting another code',
                    'retry_after_s': int(RESEND_COOLDOWN_S - waited),
                }
            # The window is anchored to the first send in the current burst;
            # the counter resets once that hour has fully elapsed.
            if existing.sends >= MAX_SENDS_PER_HOUR and waited < 3600:
                return 429, {
                    'error': 'Too many codes requested. Try again later.',
                    'retry_after_s': int(3600 - waited),
                }

        code = ''.join(secrets.choice('0123456789') for _ in range(CODE_LENGTH))
        salt = secrets.token_bytes(16)
        _store[email] = _Entry(
            code_hash=_hash(code, salt),
            salt=salt,
            expires_at=now + CODE_TTL_S,
            sent_at=now,
            sends=(existing.sends + 1) if existing else 1,
        )

    ok, detail = _send_email(code, email)
    if not ok:
        with _lock:
            _store.pop(email, None)
        return 502, {'error': 'Could not send the verification email', 'detail': detail}

    payload = {'sent': True, 'expires_in_s': CODE_TTL_S, 'dev_mode': DEV_MODE}
    # In dev mode the code is returned so the flow is usable (and testable)
    # without a mail server. Disable with OTP_DEV_ECHO=0.
    if DEV_MODE and DEV_ECHO_CODE:
        payload['dev_code'] = code
    return 200, payload


def verify_code(email, code):
    """Check a submitted code. Returns (status_code, payload)."""
    email = _normalise(email)
    code = (code or '').strip()

    if not EMAIL_RE.match(email):
        return 400, {'error': 'A valid email address is required'}
    if not code.isdigit() or len(code) != CODE_LENGTH:
        return 400, {'error': f'Enter the {CODE_LENGTH}-digit code'}

    now = time.time()
    with _lock:
        entry = _store.get(email)
        if entry is None:
            return 400, {'error': 'No code was requested for this address'}
        if entry.expires_at < now:
            _store.pop(email, None)
            return 400, {'error': 'That code has expired — request a new one', 'expired': True}
        if entry.attempts >= MAX_ATTEMPTS:
            _store.pop(email, None)
            return 429, {'error': 'Too many incorrect attempts — request a new code'}

        # Constant-time comparison: a byte-by-byte check would leak how much of
        # the code was right through response timing.
        if not hmac.compare_digest(entry.code_hash, _hash(code, entry.salt)):
            entry.attempts += 1
            remaining = MAX_ATTEMPTS - entry.attempts
            if remaining <= 0:
                _store.pop(email, None)
                return 429, {'error': 'Too many incorrect attempts — request a new code'}
            return 400, {'error': 'Incorrect code', 'attempts_remaining': remaining}

        _store.pop(email, None)

    logger.info(f"✅ email verified via OTP: {email}")
    return 200, {'verified': True, 'email': email}


def status():
    """Configuration summary for /api/models-style introspection."""
    return {
        'dev_mode': DEV_MODE,
        'smtp_host': SMTP_HOST or None,
        'smtp_from': SMTP_FROM if not DEV_MODE else None,
        'code_length': CODE_LENGTH,
        'ttl_s': CODE_TTL_S,
        'pending': len(_store),
    }
