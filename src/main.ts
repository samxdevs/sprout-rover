import './styles.css';
import {
  signUpUser,
  loginUser,
  logoutUser,
  resetPassword,
  onAuthChange,
  getUserProfile,
  ensureUserProfile,
  updateRoverConfig,
  updateUserPreferences,
  updateProfileFields,
  validateSignUpInput,
  validateLoginInput,
  getFirebaseErrorMessage,
  type UserProfile,
} from './auth';
import { auth } from './firebase';
import { connectLiveStream, checkServerHealth } from './server';
import { initTheme, setDarkMode } from './theme';
import { KEYS, getPref, setPref } from './storage';
import {
  isNative,
  startDeviceCamera,
  stopDeviceCamera,
  captureNative,
  captureFromElement,
  listCaptures,
  clearCaptures,
  getCaptureImage,
  type FeedSource,
} from './camera';
import {
  initMap,
  destroyMap,
  isMapReady,
  startTracking,
  applyPosition,
  loadLastPosition,
  centerOnRover,
  zoomBy,
  getTrailLength,
  setManualPosition,
  startRoverPolling,
  getApproxPositionFromIP,
  type Telemetry,
  type RoverFix,
} from './maps';
import { fetchWeather, sprayAdvice } from './weather';
import { startAutomation, stopAutomation } from './automation';
import { sendOtp, verifyOtp } from './otp';
import { drawBoxes, clearBoxes } from './overlay';
import { analyseCapture, severityMeta, type InferenceResult } from './inference';

// ============================================
// APP STATE
// ============================================
const state: {
  currentScreen: string;
  isLoggedIn: boolean;
  aiActive: boolean;
  speed: number;
  zoom: number;
  resetTimer: number;
  darkMode: boolean;
  notifications: boolean;
  userProfile: UserProfile | null;
  isLoading: boolean;
  /** Capture selected for inference on the Diagnostics screen. */
  lastCaptureId: string | null;
  /** Rover charge from server telemetry; null until the server reports it. */
  roverBattery: number | null;
  /** Dev-only: session entered via the skip-login button; gates stand down. */
  devBypass: boolean;
  /** Set once the emailed OTP has been accepted for this session. */
  otpVerified: boolean;
  /** Address awaiting a code, for the verify screen after a page reload. */
  pendingVerifyEmail: string | null;
} = {
  currentScreen: 'login',
  isLoggedIn: false,
  aiActive: false,
  speed: 65,
  // 1x = the feed's full field of view. The old 2.4x default came from the
  // mock-up and cropped the camera before the user touched anything.
  zoom: 1,
  resetTimer: 60,
  darkMode: false,
  notifications: true,
  userProfile: null,
  isLoading: false,
  lastCaptureId: null,
  roverBattery: null,
  // Survives page reloads (Vite hot-reload triggers them constantly during
  // dev) — otherwise every reload bounced a bypassed session back to the
  // verification gate. sessionStorage, not localStorage: closing the tab
  // ends the bypass.
  devBypass: sessionStorage.getItem('sprout.devBypass') === '1',
  // Persisted for the same reason as devBypass: a Vite reload after entering
  // a valid code must not send the user back to the verification gate.
  otpVerified: sessionStorage.getItem('sprout.otpVerified') === '1',
  pendingVerifyEmail: sessionStorage.getItem('sprout.pendingEmail'),
};

// The skip-login button shows on the dev server always, and in built apps
// (iOS/Android load a production build) only while VITE_DEV_LOGIN=1 is set in
// .env. Remove that line and rebuild before any real release.
const DEV_LOGIN_ENABLED = import.meta.env.DEV || import.meta.env.VITE_DEV_LOGIN === '1';
const DEV_LOGIN_EMAIL = 'test@sprout.com';
const DEV_LOGIN_PASSWORD = 'Sprout123';

// Feed state lives outside `state` because it survives re-renders of the
// Control screen and owns a MediaStream that must be torn down explicitly.
const feedState: { source: FeedSource; sessionStart: number } = {
  source: 'demo',
  sessionStart: Date.now(),
};

/** Handle for the REC timer so re-entering Control does not stack intervals. */
let recInterval = 0;

// Diagnostics results persist across navigation so switching tabs does not
// discard an analysis that took seconds of server time to produce.
const diagState: {
  status: 'idle' | 'running' | 'done' | 'error';
  result: InferenceResult | null;
  error: string | null;
  imageDataUrl: string | null;
} = {
  status: 'idle',
  result: null,
  error: null,
  imageDataUrl: null,
};

// ============================================
// HTML ESCAPING
// ============================================
// Screens are built as HTML strings and assigned to innerHTML, so any value
// that originates from a user (their name, organisation, rover ID) has to be
// escaped on the way in — otherwise a profile saved as `<img onerror=...>`
// would execute for anyone who renders it.
function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Initials for the profile avatar, e.g. "Sam Xavier" -> "SX". */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// ============================================
// FORM ERROR DISPLAY HELPERS
// ============================================
function showFieldError(fieldId: string, message: string) {
  const wrapper = document.getElementById(fieldId)?.closest('.form-group');
  if (!wrapper) return;
  // Remove existing error
  const existing = wrapper.querySelector('.field-error');
  if (existing) existing.remove();
  // Add error
  const errorEl = document.createElement('div');
  errorEl.className = 'field-error';
  errorEl.style.cssText = 'color: #DC2626; font-size: 12px; margin-top: 4px; font-weight: 500;';
  errorEl.textContent = message;
  wrapper.appendChild(errorEl);
  // Highlight input
  const inputWrapper = wrapper.querySelector('.input-wrapper') as HTMLElement;
  if (inputWrapper) inputWrapper.style.borderColor = '#DC2626';
}

function clearFieldErrors() {
  document.querySelectorAll('.field-error').forEach(el => el.remove());
  document.querySelectorAll('.input-wrapper').forEach(el => {
    (el as HTMLElement).style.borderColor = '';
  });
}

function setButtonLoading(btnId: string, loading: boolean, originalText: string) {
  const btn = document.getElementById(btnId) as HTMLButtonElement;
  if (!btn) return;
  btn.disabled = loading;
  if (loading) {
    btn.innerHTML = '<span style="display:inline-flex;align-items:center;gap:8px;"><span class="material-symbols-outlined" style="animation:spin 1s linear infinite;font-size:18px;">progress_activity</span> Please wait...</span>';
    btn.style.opacity = '0.7';
  } else {
    btn.textContent = originalText;
    btn.style.opacity = '1';
  }
}

// ============================================
// SPROUT LOGO SVG
// ============================================
const logoSVG = (size = 16) => `
  <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none">
    <path d="M12 3C12 3 6 8 6 15C6 19 9 22 12 22C15 22 18 19 18 15C18 8 12 3 12 3Z" fill="white" opacity="0.9"/>
    <path d="M12 8C12 8 9 11 9 15C9 17.5 10.5 19 12 19C13.5 19 15 17.5 15 15C15 11 12 8 12 8Z" fill="white" opacity="0.6"/>
  </svg>
`;

// ============================================
// ROUTER
// ============================================
function navigate(screen: string) {
  state.currentScreen = screen;
  render();
  window.location.hash = screen;
}

function initRouter() {
  const hash = window.location.hash.slice(1) || 'login';
  state.currentScreen = hash;
  render();
}

window.addEventListener('hashchange', () => {
  const hash = window.location.hash.slice(1) || 'login';
  if (hash !== state.currentScreen) {
    state.currentScreen = hash;
    render();
  }
});

// ============================================
// TOAST NOTIFICATIONS
// ============================================
function showToast(message: string) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

// ============================================
// PROMPT MODAL
// ============================================
// Replaces window.prompt(), which is styled inconsistently and is suppressed
// outright in some WebViews — including Capacitor's on Android.
// Resolves with the entered value, or null if dismissed.
function showPrompt(opts: {
  title: string;
  label: string;
  value?: string;
  options?: string[];
  placeholder?: string;
}): Promise<string | null> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const field = opts.options
      ? `<select class="modal-input" id="modal-input">
           ${opts.options.map(o =>
             `<option value="${esc(o)}"${o === opts.value ? ' selected' : ''}>${esc(o)}</option>`
           ).join('')}
         </select>`
      : `<input class="modal-input" id="modal-input" type="text"
                value="${esc(opts.value ?? '')}"
                placeholder="${esc(opts.placeholder ?? '')}" />`;

    overlay.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="${esc(opts.title)}">
        <div class="modal-title">${esc(opts.title)}</div>
        <label class="modal-label" for="modal-input">${esc(opts.label)}</label>
        ${field}
        <div class="modal-actions">
          <button class="modal-btn" id="modal-cancel">Cancel</button>
          <button class="modal-btn primary" id="modal-save">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('#modal-input') as HTMLInputElement | HTMLSelectElement;
    requestAnimationFrame(() => {
      overlay.classList.add('show');
      input?.focus();
      if (input instanceof HTMLInputElement) input.select();
    });

    let settled = false;
    const close = (result: string | null) => {
      if (settled) return;
      settled = true;
      overlay.classList.remove('show');
      setTimeout(() => overlay.remove(), 200);
      resolve(result);
    };

    overlay.querySelector('#modal-save')?.addEventListener('click', () => close(input.value.trim()));
    overlay.querySelector('#modal-cancel')?.addEventListener('click', () => close(null));
    // Click-outside dismisses, but only on the backdrop itself.
    overlay.addEventListener('click', e => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !(input instanceof HTMLSelectElement)) close(input.value.trim());
      if (e.key === 'Escape') close(null);
    });
  });
}

// ============================================
// BOTTOM NAVIGATION
// ============================================
function renderBottomNav(active: string) {
  const items = [
    { id: 'control', icon: 'auto_awesome', label: 'Control' },
    { id: 'maps', icon: 'map', label: 'Maps' },
    { id: 'diagnostics', icon: 'monitoring', label: 'Diagnostics' },
    { id: 'settings', icon: 'settings', label: 'Settings' },
  ];

  return `
    <nav class="bottom-nav" id="bottom-nav">
      ${items.map(item => `
        <button class="nav-item ${active === item.id ? 'active' : ''}" data-nav="${item.id}" id="nav-${item.id}">
          <span class="material-symbols-outlined ${active === item.id ? 'filled' : ''}">${item.icon}</span>
          <span>${item.label}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

// ============================================
// APP HEADER
// ============================================

/** Material battery glyph for a charge level, or an unknown state for null. */
function batteryIcon(pct: number | null): string {
  if (pct === null) return 'battery_unknown';
  if (pct >= 90) return 'battery_full';
  if (pct >= 60) return 'battery_5_bar';
  if (pct >= 40) return 'battery_4_bar';
  if (pct >= 20) return 'battery_3_bar';
  return 'battery_alert';
}

function renderHeader(title: string) {
  return `
    <header class="app-header">
      <div class="header-left">
        <div class="header-logo">${logoSVG(16)}</div>
        <span class="header-title">Sprout</span>
        <span style="color: var(--text-muted); margin: 0 2px;">·</span>
        <span style="font-size: 14px; color: var(--text-secondary); font-weight: 500;">${title}</span>
      </div>
      <div class="header-right">
        <div class="battery-indicator" id="battery-indicator">
          <span class="material-symbols-outlined filled">${batteryIcon(state.roverBattery)}</span>
          <span>${state.roverBattery === null ? '—' : `${state.roverBattery}%`}</span>
        </div>
      </div>
    </header>
  `;
}

// ============================================
// LOGIN SCREEN
// ============================================
function renderLogin() {
  return `
    <div class="screen auth-screen" id="login-screen">
      <div class="auth-logo">${logoSVG(36)}</div>
      <h1 class="auth-title">Sprout</h1>
      <p class="auth-subtitle">Cultivate your future</p>
      
      <div class="auth-form">
        <div class="form-group">
          <label class="form-label">Email Address</label>
          <div class="input-wrapper">
            <span class="material-symbols-outlined">mail</span>
            <input type="email" id="login-email" placeholder="farmer@sprout.com" />
          </div>
        </div>
        
        <div class="form-group">
          <label class="form-label">Password</label>
          <div class="input-wrapper">
            <span class="material-symbols-outlined">lock</span>
            <input type="password" id="login-password" placeholder="••••••••" />
            <button class="toggle-password" id="toggle-login-pw" type="button">
              <span class="material-symbols-outlined">visibility</span>
            </button>
          </div>
        </div>
        
        <div class="form-row">
          <label>
            <input type="checkbox" id="remember-me" />
            Remember me
          </label>
          <a href="#forgot-password" id="forgot-password-link">Forgot password?</a>
        </div>
        
        <button class="btn-primary" id="login-btn">Login</button>
      </div>
      
      <p class="auth-footer">Don't have an account? <a href="#signup" id="signup-link">Sign Up</a></p>
      ${DEV_LOGIN_ENABLED ? `
        <button class="modal-btn" id="dev-skip-login"
                style="margin-top: 18px; opacity: 0.75; border: 1px dashed var(--border);">
          🛠 Dev: Skip login
        </button>` : ''}
    </div>
  `;
}

// ============================================
// SIGN UP SCREEN
// ============================================
function renderSignUp() {
  return `
    <div class="screen auth-screen" id="signup-screen">
      <div class="auth-logo">${logoSVG(36)}</div>
      <h1 class="auth-title">Sprout</h1>
      <p class="auth-subtitle">Join our agricultural community today</p>
      
      <div class="auth-form">
        <div class="form-group">
          <label class="form-label">Full Name</label>
          <div class="input-wrapper">
            <span class="material-symbols-outlined">person</span>
            <input type="text" id="signup-name" placeholder="John Farmer" />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Email Address</label>
          <div class="input-wrapper">
            <span class="material-symbols-outlined">mail</span>
            <input type="email" id="signup-email" placeholder="farmer@sprout.com" />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Organization</label>
          <div class="input-wrapper">
            <span class="material-symbols-outlined">business</span>
            <input type="text" id="signup-org" placeholder="Farm Co." />
          </div>
        </div>
        
        <div class="form-group">
          <label class="form-label">Password</label>
          <div class="input-wrapper">
            <span class="material-symbols-outlined">lock</span>
            <input type="password" id="signup-password" placeholder="••••••••" />
            <button class="toggle-password" id="toggle-signup-pw" type="button">
              <span class="material-symbols-outlined">visibility</span>
            </button>
          </div>
        </div>
        
        <div class="form-row">
          <label>
            <input type="checkbox" id="agree-terms" />
            I agree to the <a href="#" style="margin-left:4px;">Terms of Service</a>
          </label>
        </div>
        
        <button class="btn-primary" id="signup-btn">Create Account</button>
      </div>
      
      <p class="auth-footer">Already have an account? <a href="#login" id="login-link">Login</a></p>
    </div>
  `;
}

// ============================================
// FORGOT PASSWORD SCREEN
// ============================================
// ============================================
// VERIFY EMAIL SCREEN
// ============================================
// Shown after sign-up and to any signed-in-but-unverified account at login.
// The app proper is gated on user.emailVerified.
function renderVerifyEmail() {
  const email = auth.currentUser?.email || state.pendingVerifyEmail || 'your email address';
  return `
    <div class="screen auth-screen" id="verify-email-screen">
      <div class="auth-logo">${logoSVG(36)}</div>
      <h1 class="auth-title">Enter your code</h1>
      <p class="auth-subtitle">One quick step before you start</p>

      <div class="auth-form" style="text-align: center;">
        <span class="material-symbols-outlined" style="font-size: 44px; color: var(--primary);">mark_email_unread</span>
        <p style="margin: 12px 0 4px; font-size: 14px; color: var(--text-secondary);">We emailed a 6-digit code to</p>
        <p style="font-weight: 700; margin-bottom: 18px; word-break: break-all;">${esc(email)}</p>

        <div class="otp-inputs" id="otp-inputs">
          ${Array.from({ length: 6 }, (_, i) => `
            <input class="otp-digit" id="otp-${i}" type="text" inputmode="numeric"
                   autocomplete="${i === 0 ? 'one-time-code' : 'off'}"
                   maxlength="1" aria-label="Digit ${i + 1}" />`).join('')}
        </div>

        <div class="otp-message" id="otp-message"></div>

        <button class="btn-primary" id="otp-verify-btn" style="margin-top: 4px;">Verify</button>
        <button class="modal-btn" id="otp-resend-btn" style="width: 100%; margin-top: 10px;">Resend code</button>
      </div>

      <p class="auth-footer"><a href="#login" id="verify-logout">Use a different account</a></p>
    </div>
  `;
}

function renderForgotPassword() {
  return `
    <div class="screen auth-screen" id="forgot-password-screen">
      <div class="auth-image-header">
        <img src="/images/crop-field.png" alt="Green crop field" />
      </div>
      
      <div class="auth-logo">${logoSVG(36)}</div>
      <h1 class="auth-title" style="font-size: 24px;">Forgot Password?</h1>
      <p class="auth-subtitle">Enter your email address and we'll send you a link to reset your password.</p>
      
      <div class="auth-form">
        <div class="form-group">
          <label class="form-label">Email Address</label>
          <div class="input-wrapper">
            <span class="material-symbols-outlined">mail</span>
            <input type="email" id="reset-email" placeholder="farmer@sprout.com" />
          </div>
        </div>
        
        <button class="btn-primary" id="send-reset-btn">Send Reset Link</button>
      </div>
      
      <p class="auth-footer" style="margin-top: 16px;">
        <a href="#login" id="back-to-login" style="display: inline-flex; align-items: center; gap: 4px;">
          <span class="material-symbols-outlined" style="font-size: 18px;">login</span>
          Back to Login
        </a>
      </p>
      <p class="auth-footer" style="margin-top: 8px;">
        Need help? <a href="#" id="contact-support">Contact Support</a>
      </p>
    </div>
  `;
}

// ============================================
// RESET SUCCESS SCREEN
// ============================================
function renderResetSuccess() {
  return `
    <div class="screen auth-screen" id="reset-success-screen">
      <div class="auth-image-header">
        <img src="/images/farm-landscape.png" alt="Farm landscape" />
      </div>
      
      <div class="success-icon">
        <span class="material-symbols-outlined">check</span>
      </div>
      
      <div class="success-message">
        <h1>Success!</h1>
        <p>A password reset link has been sent to your email address. Please check your inbox.</p>
      </div>
      
      <div class="auth-form" style="background: transparent; box-shadow: none; padding: 0 16px;">
        <button class="btn-primary" id="back-login-btn">Back to Login</button>
        <div class="resend-timer" id="resend-timer">
          Didn't receive the email? Resend in <span id="timer-value">${state.resetTimer}s</span>
        </div>
      </div>
    </div>
  `;
}

// ============================================
// CONTROL SCREEN
// ============================================
function renderControl() {
  return `
    <div class="screen control-screen" id="control-screen">
      ${renderHeader('Rover Control')}
      <div class="main-content">
        <!-- Live Video Feed -->
        <div class="video-feed" id="video-feed">
          <img src="/images/rover-field.png" alt="Live rover feed" id="live-feed-img"
               onerror="this.src='/images/rover-field.png'" />
          <video id="live-feed-video" playsinline muted hidden></video>
          <!-- Detection boxes are drawn here, over the feed. Sized in CSS
               pixels and kept in sync with the feed's zoom transform. -->
          <canvas id="detection-overlay" class="detection-overlay"></canvas>
          <div class="video-overlay">
            <div class="rec-badge">
              <span class="rec-dot"></span>
              <span id="rec-timer">REC 00:00:00</span>
            </div>
            <div class="video-actions">
              <button class="video-action-btn" id="camera-toggle-btn" title="Use device camera">
                <span class="material-symbols-outlined">videocam</span>
              </button>
              <button class="video-action-btn" id="fullscreen-btn" title="Fullscreen">
                <span class="material-symbols-outlined">fullscreen</span>
              </button>
            </div>
          </div>
          <div class="feed-source-chip" id="feed-source-chip">Demo</div>
          <button class="capture-btn" id="capture-btn" title="Capture frame">
            <span class="material-symbols-outlined">photo_camera</span>
          </button>
        </div>

        <!-- Zoom Slider -->
        <div class="zoom-slider">
          <span class="material-symbols-outlined">zoom_out</span>
          <input type="range" id="zoom-slider" min="1" max="5" step="0.1" value="${state.zoom}" />
          <span class="material-symbols-outlined">zoom_in</span>
          <span class="zoom-value" id="zoom-value">${state.zoom.toFixed(1)}x</span>
        </div>

        <!-- Captures -->
        <div class="section-label">
          <span class="material-symbols-outlined">photo_library</span>
          CAPTURES
          <button class="link-btn" id="clear-captures-btn">Clear</button>
        </div>
        <div class="capture-strip" id="capture-strip">
          <div class="capture-empty">No captures yet — tap the camera button on the feed.</div>
        </div>
        
        <!-- AI Automation Button -->
        <button class="ai-btn ${state.aiActive ? 'active' : ''}" id="ai-btn">
          <span class="material-symbols-outlined">psychology</span>
          ${state.aiActive ? 'AI AUTOMATION ACTIVE' : 'ACTIVATE AI AUTOMATION'}
        </button>
        
        <!-- AI Action Log -->
        <div class="section-label">
          <span class="material-symbols-outlined">terminal</span>
          AI ACTION LOG
        </div>
        <div class="action-log" id="action-log">
          <div class="log-empty" id="log-empty">No activity yet.</div>
        </div>
        
        <!-- Manual Drive Section -->
        <div class="section-label">
          <span class="material-symbols-outlined">videogame_asset</span>
          MANUAL DRIVE
        </div>
        <div class="drive-section">
          <div class="joystick-container">
            <div class="joystick-area" id="joystick-area">
              <div class="joystick-knob" id="joystick-knob">
                <span class="material-symbols-outlined">control_camera</span>
              </div>
            </div>
            <div class="joystick-labels">
              <span>X: <span id="joy-x">0</span></span>
              <span>Y: <span id="joy-y">0</span></span>
              <span>V: <span id="joy-v">N: 0.0</span></span>
            </div>
          </div>
          
          <div class="controls-right">
            <div class="speed-control">
              <div class="speed-icon">
                <span class="material-symbols-outlined">speed</span>
              </div>
              <div class="speed-value" id="speed-value">${state.speed}%</div>
              <div class="speed-unit">RPM</div>
              <div class="speed-buttons">
                <button class="speed-btn" id="speed-down">−</button>
                <button class="speed-btn" id="speed-up">+</button>
              </div>
            </div>
            
            <button class="stop-btn" id="stop-btn">
              <span class="material-symbols-outlined">dangerous</span>
              <span>STOP</span>
            </button>
          </div>
        </div>
      </div>
      ${renderBottomNav('control')}
    </div>
  `;
}

// ============================================
// MAPS SCREEN
// ============================================
function renderMaps() {
  return `
    <div class="screen maps-screen" id="maps-screen">
      ${renderHeader('Field Mapping')}
      <div class="main-content">
        <div class="map-subtitle">
          <p>Real-time Sprout Rover tracking</p>
          <div class="live-badge">
            <span class="live-dot"></span>
            LIVE
          </div>
        </div>
        
        <!-- Map Container -->
        <div class="map-container" id="map-container">
          <div class="map-canvas" id="map-canvas"></div>
          <div class="map-chip">
            <span class="material-symbols-outlined">satellite_alt</span>
            OpenStreetMap
          </div>

          <!-- Map Controls -->
          <div class="map-controls">
            <button class="map-control-btn" id="map-zoom-in" title="Zoom in">
              <span class="material-symbols-outlined">add</span>
            </button>
            <button class="map-control-btn" id="map-zoom-out" title="Zoom out">
              <span class="material-symbols-outlined">remove</span>
            </button>
            <button class="map-control-btn" id="map-set-position" title="Set position manually">
              <span class="material-symbols-outlined">edit_location</span>
            </button>
          </div>

          <button class="map-center-btn" id="map-center" title="Centre on rover">
            <span class="material-symbols-outlined">my_location</span>
          </button>

          <!-- Shown only when there is no usable fix -->
          <div class="map-gps-banner" id="map-gps-banner" hidden>
            <span class="material-symbols-outlined">location_off</span>
            <div class="map-gps-text" id="map-gps-text">Waiting for GPS…</div>
            <div class="map-gps-actions">
              <button class="map-gps-btn" id="gps-retry">Retry</button>
              <button class="map-gps-btn" id="gps-manual">Set manually</button>
            </div>
          </div>
        </div>

        <!-- Rover Telemetry — from the rover's GPS via the Pi server -->
        <div class="telemetry-section">
          <div class="section-label">
            <span class="material-symbols-outlined">smart_toy</span>
            ROVER TELEMETRY
          </div>
          <div class="telemetry-grid">
            <div class="telemetry-card">
              <div class="telemetry-label">Latitude</div>
              <div class="telemetry-value" id="tel-lat">—</div>
            </div>
            <div class="telemetry-card">
              <div class="telemetry-label">Longitude</div>
              <div class="telemetry-value" id="tel-lon">—</div>
            </div>
            <div class="telemetry-card">
              <div class="telemetry-label">Heading</div>
              <div class="telemetry-value" id="tel-heading">—</div>
            </div>
            <div class="telemetry-card">
              <div class="telemetry-label">Velocity</div>
              <div class="telemetry-value" id="tel-speed">—</div>
            </div>
            <div class="telemetry-card full-width">
              <div>
                <div class="telemetry-label">Rover GPS</div>
                <div class="telemetry-value" id="tel-signal">Connecting to rover…</div>
              </div>
              <span class="material-symbols-outlined signal-icon" id="tel-signal-icon" style="font-size: 24px;">cell_tower</span>
            </div>
            <div class="telemetry-card full-width">
              <div>
                <div class="telemetry-label">Your Device</div>
                <div class="telemetry-value" id="tel-device">Locating…</div>
              </div>
              <span class="material-symbols-outlined" style="font-size: 24px; color: var(--blue);">my_location</span>
            </div>
          </div>
        </div>
      </div>
      ${renderBottomNav('maps')}
    </div>
  `;
}

// ============================================
// DIAGNOSTICS SCREEN
// ============================================
function renderDiagnostics() {
  return `
    <div class="screen diagnostics-screen" id="diagnostics-screen">
      ${renderHeader('Diagnostics')}
      <div class="main-content">
        <!-- Weather Card -->
        <div class="weather-card" id="weather-card">
          <div class="weather-header">
            <div>
              <div class="weather-location" id="weather-location">Locating…</div>
              <div class="weather-temp" id="weather-temp">—</div>
              <div class="weather-desc" id="weather-desc">Fetching conditions</div>
            </div>
            <div class="weather-icon">
              <span class="material-symbols-outlined filled" id="weather-icon">cloud</span>
            </div>
          </div>
          <div class="weather-details">
            <div class="weather-detail">
              <span class="material-symbols-outlined">air</span>
              <span id="weather-wind">—</span>
            </div>
            <div class="weather-detail">
              <span class="material-symbols-outlined">humidity_percentage</span>
              <span id="weather-humidity">—</span>
            </div>
          </div>
          <div class="spray-advice" id="spray-advice" hidden></div>
        </div>

        <!-- AI Inference Result -->
        <div class="section-label">
          <span class="material-symbols-outlined">psychology</span>
          AI INFERENCE RESULT
          <button class="link-btn" id="analyse-btn">Analyse</button>
        </div>
        <div id="inference-region">
          ${renderInferenceCard()}
        </div>

        <!-- Export Button -->
        <button class="btn-export" id="export-btn">
          <span class="material-symbols-outlined">picture_as_pdf</span>
          Export Report (PDF)
        </button>
      </div>
      ${renderBottomNav('diagnostics')}
    </div>
  `;
}

/**
 * Renders the inference panel for whatever state analysis is in: no frame
 * selected, a pending run, an error, or a result.
 */
function renderInferenceCard(): string {
    const r = diagState.result;
    // The annotated frame carries the boxes; fall back to the raw capture
    // before analysis has returned one.
    const img = r?.annotatedImage || diagState.imageDataUrl;

    if (diagState.status === 'running') {
        return `<div class="inference-placeholder">
            <span class="material-symbols-outlined spin">progress_activity</span>
            Analysing frame…
        </div>`;
    }

    if (diagState.status === 'error') {
        return `<div class="inference-placeholder error">
            <span class="material-symbols-outlined">error</span>
            <div>${esc(diagState.error || 'Analysis failed')}</div>
            <div class="inference-hint">Capture a frame on the Control screen, then tap Analyse.</div>
        </div>`;
    }

    if (!r) {
        return `<div class="inference-placeholder">
            <span class="material-symbols-outlined">photo_camera</span>
            <div>No analysis yet</div>
            <div class="inference-hint">Capture a frame on the Control screen, then tap Analyse.</div>
        </div>`;
    }

    const sev = severityMeta(r.severity);
    const pct = Math.round(r.confidence * 100);
    const t = r.treatment;

    return `
      <div class="inference-card">
        <div class="inference-header">
          <div class="inference-icon" style="background:${sev.color}1f;color:${sev.color}">
            <span class="material-symbols-outlined">${sev.level <= 0.1 ? 'verified' : 'bug_report'}</span>
          </div>
          <div class="inference-info">
            <div class="inference-crop">Crop: ${esc(r.crop)}</div>
            <div class="inference-disease">${esc(r.disease)}</div>
          </div>
          <div class="inference-confidence">
            <div class="confidence-label">Confidence</div>
            <div class="confidence-value">${pct}%</div>
          </div>
        </div>

        <div class="severity-section">
          <div class="severity-row">
            <span class="severity-label">Severity Level</span>
            <span class="severity-badge" style="background:${sev.color};color:#fff">${esc(sev.label)}</span>
          </div>
          <div class="severity-bar">
            <div class="severity-indicator" style="left:${(sev.level * 100).toFixed(0)}%;background:${sev.color}"></div>
          </div>
        </div>

        ${r.classifierUnavailable ? `
          <div class="inference-note">
            <span class="material-symbols-outlined">info</span>
            Disease classifier unavailable — detection results only.
          </div>` : ''}

        ${r.alternatives.length > 0 ? `
          <div class="alt-block">
            <div class="alt-title">Other possibilities</div>
            ${r.alternatives.map(a =>
              `<div class="detection-row">
                 <span>${esc(a.label.replace(/___/g, ' · ').replace(/_/g, ' ').trim())}</span>
                 <span class="detection-conf">${Math.round(a.confidence * 100)}%</span>
               </div>`
            ).join('')}
          </div>` : ''}

        ${r.detections.length > 0 ? `
          <div class="alt-block">
            <div class="alt-title">Detections (${r.detections.length})</div>
            ${r.detections.slice(0, 6).map(d =>
              `<div class="detection-row">
                 <span><span class="role-dot role-${esc(d.role)}"></span>${esc(d.label)}
                   <span class="detection-role">${esc(d.role)}</span></span>
                 <span class="detection-conf">${Math.round(d.confidence * 100)}%</span>
               </div>`
            ).join('')}
          </div>` : `
          <div class="inference-note">
            <span class="material-symbols-outlined">search_off</span>
            No objects detected in this frame.
          </div>`}

        ${r.inferenceTimeMs !== null
          ? `<div class="inference-meta">Inference ${r.inferenceTimeMs} ms</div>` : ''}
      </div>

      ${img ? `
        <div class="disease-image">
          <img src="${esc(img)}" alt="Analysed frame" />
          <span class="disease-image-badge">Analysed frame</span>
        </div>` : ''}

      ${t ? `
        <div class="section-label">
          <span class="material-symbols-outlined">vaccines</span>
          RECOMMENDED TREATMENT
        </div>
        <div class="treatment-card">
          ${t.product ? `
            <div class="treatment-product">
              <span class="material-symbols-outlined">inventory_2</span>
              <div class="treatment-product-info">
                <div class="treatment-product-label">Recommended Product</div>
                <div class="treatment-product-name">${esc(t.product)}</div>
              </div>
            </div>` : ''}
          <div class="treatment-details">
            ${t.activeIngredient ? `<div class="treatment-row">
              <span class="treatment-row-label">Active Ingredient</span>
              <span class="treatment-row-value">${esc(t.activeIngredient)}</span>
            </div>` : ''}
            ${t.dosage ? `<div class="treatment-row">
              <span class="treatment-row-label">Target Dosage</span>
              <span class="treatment-row-value">${esc(t.dosage)}</span>
            </div>` : ''}
            ${t.method ? `<div class="treatment-row">
              <span class="treatment-row-label">Application Method</span>
              <span class="treatment-row-value">${esc(t.method)}</span>
            </div>` : ''}
          </div>
        </div>` : ''}
    `;
}

// ============================================
// SETTINGS SCREEN
// ============================================
function renderSettings() {
  const p = state.userProfile;
  const profileName = p?.fullName || 'Operator';
  const profileEmail = p?.email || auth.currentUser?.email || '—';
  const profileOrg = p?.organization || '';
  const roverId = p?.roverConfig?.roverId || 'S-104';
  const operationMode = p?.roverConfig?.operationMode || 'Autonomous';
  const sprayRate = p?.roverConfig?.sprayRate || '120 ml/min';

  return `
    <div class="screen settings-screen" id="settings-screen">
      ${renderHeader('Settings')}
      <div class="main-content">
        <!-- Profile Section -->
        <div class="settings-section">
          <div class="settings-section-title">Profile</div>
          <div class="settings-card">
            <div class="profile-card" id="profile-card">
              <div class="profile-avatar">${esc(initialsOf(profileName))}</div>
              <div class="profile-info">
                <div class="profile-name">${esc(profileName)}</div>
                <div class="profile-email">${esc(profileEmail)}</div>
                ${profileOrg ? `<div class="profile-email">${esc(profileOrg)}</div>` : ''}
              </div>
              <span class="material-symbols-outlined" style="color: var(--text-muted);">chevron_right</span>
            </div>
          </div>
        </div>

        <!-- Connection Status -->
        <div class="settings-section">
          <div class="settings-section-title">Connection Status</div>
          <div class="settings-card">
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">cloud</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Firebase</div>
              </div>
              <div class="settings-item-right" id="status-firebase">
                <span class="status-dot ${state.isLoggedIn ? 'online' : ''}"></span>
                <span class="status-text ${state.isLoggedIn ? 'online' : ''}">${state.isLoggedIn ? 'Connected' : 'Signed out'}</span>
              </div>
            </div>
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">smart_toy</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">AI Server (${esc(roverId)})</div>
              </div>
              <div class="settings-item-right" id="status-server">
                <span class="status-dot"></span>
                <span class="status-text">Checking…</span>
              </div>
            </div>
          </div>
        </div>

        <!-- Configuration -->
        <div class="settings-section">
          <div class="settings-section-title">Configuration</div>
          <div class="settings-card">
            <div class="settings-item" id="cfg-roverId" data-field="roverId">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">tag</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Rover ID</div>
                <div class="settings-item-value">${esc(roverId)}</div>
              </div>
              <span class="material-symbols-outlined" style="color: var(--text-muted);">chevron_right</span>
            </div>
            <div class="settings-item" id="cfg-operationMode" data-field="operationMode">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">tune</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Operation Mode</div>
                <div class="settings-item-value">${esc(operationMode)}</div>
              </div>
              <span class="material-symbols-outlined" style="color: var(--text-muted);">chevron_right</span>
            </div>
            <div class="settings-item" id="cfg-sprayRate" data-field="sprayRate">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">water_drop</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Spray Rate</div>
                <div class="settings-item-value">${esc(sprayRate)}</div>
              </div>
              <span class="material-symbols-outlined" style="color: var(--text-muted);">chevron_right</span>
            </div>
          </div>
        </div>
        
        <!-- App Preferences -->
        <div class="settings-section">
          <div class="settings-section-title">App Preferences</div>
          <div class="settings-card">
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">dark_mode</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Dark Mode</div>
              </div>
              <label class="toggle-switch" id="dark-mode-toggle">
                <input type="checkbox" ${state.darkMode ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">notifications</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Notifications</div>
              </div>
              <label class="toggle-switch" id="notifications-toggle">
                <input type="checkbox" ${state.notifications ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
        </div>
        
        <!-- Logout -->
        <button class="logout-btn" id="logout-btn">
          <span class="material-symbols-outlined">logout</span>
          Log Out
        </button>
        
        <!-- Footer -->
        <div class="settings-footer">
          Sprout v2.4.12 • Built for Sustainable Farming
        </div>
      </div>
      ${renderBottomNav('settings')}
    </div>
  `;
}

// ============================================
// RENDER ENGINE
// ============================================

/** Releases resources held by the screen being replaced. */
function teardownScreen() {
  if (recInterval) {
    clearInterval(recInterval);
    recInterval = 0;
  }
  // The AI loop samples the live preview, so it has to stop before the camera
  // it reads from is released.
  stopAutomation();
  state.aiActive = false;
  if (feedState.source === 'device') {
    stopDeviceCamera();
    feedState.source = 'demo';
  }
  destroyMap();
}

const APP_SCREENS = ['control', 'maps', 'diagnostics', 'settings'];

function render() {
  const app = document.getElementById('app')!;

  // Verification gate for direct navigation (typed hash, refresh, back
  // button): the auth listener only fires on auth *changes*, so an unverified
  // session deep-linking into an app screen has to be caught here.
  if (
    APP_SCREENS.includes(state.currentScreen) &&
    auth.currentUser &&
    !auth.currentUser.emailVerified &&
    !state.otpVerified &&
    !state.devBypass
  ) {
    navigate('verify-email');
    return;
  }

  // Tear down anything the outgoing screen owns. innerHTML replacement drops
  // the elements but not a live MediaStream, a running interval, or the
  // Leaflet map instance — those leak (and keep the camera light on) unless
  // released explicitly.
  teardownScreen();

  switch (state.currentScreen) {
    case 'login':
      app.innerHTML = renderLogin();
      setupLoginEvents();
      break;
    case 'signup':
      app.innerHTML = renderSignUp();
      setupSignUpEvents();
      break;
    case 'verify-email':
      // Needs a signed-in user to verify; direct hits without one go to login.
      if (!auth.currentUser) {
        navigate('login');
        return;
      }
      app.innerHTML = renderVerifyEmail();
      setupVerifyEmailEvents();
      break;
    case 'forgot-password':
      app.innerHTML = renderForgotPassword();
      setupForgotPasswordEvents();
      break;
    case 'reset-success':
      app.innerHTML = renderResetSuccess();
      setupResetSuccessEvents();
      break;
    case 'control':
      app.innerHTML = renderControl();
      setupControlEvents();
      break;
    case 'maps':
      app.innerHTML = renderMaps();
      setupMapsEvents();
      break;
    case 'diagnostics':
      app.innerHTML = renderDiagnostics();
      setupDiagnosticsEvents();
      break;
    case 'settings':
      app.innerHTML = renderSettings();
      setupSettingsEvents();
      break;
    default:
      app.innerHTML = renderLogin();
      setupLoginEvents();
  }

  // Setup bottom nav events for main app screens
  if (['control', 'maps', 'diagnostics', 'settings'].includes(state.currentScreen)) {
    setupBottomNavEvents();
  }
}

// ============================================
// EVENT HANDLERS
// ============================================

function setupBottomNavEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const target = (e.currentTarget as HTMLElement).dataset.nav;
      if (target) navigate(target);
    });
  });
}

function setupLoginEvents() {
  const loginBtn = document.getElementById('login-btn');
  loginBtn?.addEventListener('click', async () => {
    clearFieldErrors();
    const email = (document.getElementById('login-email') as HTMLInputElement)?.value || '';
    const password = (document.getElementById('login-password') as HTMLInputElement)?.value || '';

    // Client-side validation
    const validation = validateLoginInput(email, password);
    if (!validation.isValid) {
      if (validation.errors.email) showFieldError('login-email', validation.errors.email);
      if (validation.errors.password) showFieldError('login-password', validation.errors.password);
      return;
    }

    // Firebase login
    setButtonLoading('login-btn', true, 'Login');
    try {
      const { user, profile } = await loginUser(email, password);

      // Verification gate: credentials are valid, but the app stays closed
      // until the emailed link has been clicked.
      // Firebase's own emailVerified flag stays false: verification runs
      // through our emailed code instead of its link. A session that has not
      // cleared the code this run gets sent to the verify screen.
      if (!user.emailVerified && !state.otpVerified) {
        state.pendingVerifyEmail = (user.email || email).trim().toLowerCase();
        sessionStorage.setItem('sprout.pendingEmail', state.pendingVerifyEmail);
        try {
          const result = await sendOtp(state.pendingVerifyEmail);
          showToast(result.devCode
            ? `Verification needed. Dev code: ${result.devCode}`
            : '📧 We sent a verification code to your email');
        } catch (mailErr: any) {
          showToast('⚠️ Could not send the code: ' + (mailErr?.message || ''));
        }
        navigate('verify-email');
        return;
      }

      state.isLoggedIn = true;
      state.userProfile = profile;
      showToast(`Welcome back${profile?.fullName ? ', ' + profile.fullName : ''}! 🌱`);
      navigate('control');
    } catch (err: any) {
      const code = err?.code || '';
      const message = getFirebaseErrorMessage(code) || err.message;
      showToast('❌ ' + message);
    } finally {
      setButtonLoading('login-btn', false, 'Login');
    }
  });

  // Dev shortcut: signs in with the dev account and stands the verification
  // gate down for this session. Real Firebase session, so profile reads and
  // writes behave normally under test-mode rules.
  document.getElementById('dev-skip-login')?.addEventListener('click', async () => {
    setButtonLoading('dev-skip-login', true, '🛠 Dev: Skip login');
    state.devBypass = true;
    sessionStorage.setItem('sprout.devBypass', '1');
    try {
      const { profile } = await loginUser(DEV_LOGIN_EMAIL, DEV_LOGIN_PASSWORD);
      state.userProfile = profile;
    } catch (err: any) {
      // Account missing or offline — proceed with a UI-only session so the
      // screens are still reachable; saves that need a user will just fail.
      state.userProfile = null;
      showToast('⚠️ Dev session without Firebase user: ' + (err?.message || 'sign-in failed'));
    } finally {
      setButtonLoading('dev-skip-login', false, '🛠 Dev: Skip login');
    }
    state.isLoggedIn = true;
    showToast('🛠 Dev login — verification skipped');
    navigate('control');
  });

  // Toggle password visibility
  const togglePw = document.getElementById('toggle-login-pw');
  togglePw?.addEventListener('click', () => {
    const input = document.getElementById('login-password') as HTMLInputElement;
    const icon = togglePw.querySelector('.material-symbols-outlined')!;
    if (input.type === 'password') {
      input.type = 'text';
      icon.textContent = 'visibility_off';
    } else {
      input.type = 'password';
      icon.textContent = 'visibility';
    }
  });
}

function setupVerifyEmailEvents() {
  const email = auth.currentUser?.email || state.pendingVerifyEmail || '';
  const digits = Array.from({ length: 6 }, (_, i) =>
    document.getElementById(`otp-${i}`) as HTMLInputElement | null);
  const messageEl = document.getElementById('otp-message');

  const setMessage = (text: string, kind: 'error' | 'info' = 'error') => {
    if (!messageEl) return;
    messageEl.textContent = text;
    messageEl.className = `otp-message ${kind}`;
  };

  const readCode = () => digits.map(d => d?.value ?? '').join('');

  const focusFirstEmpty = () => {
    (digits.find(d => d && !d.value) ?? digits[digits.length - 1])?.focus();
  };

  // --- digit box behaviour: auto-advance, backspace, paste ---
  digits.forEach((input, i) => {
    input?.addEventListener('input', () => {
      // Strip anything non-numeric so a stray character cannot sit in the box.
      input.value = input.value.replace(/\D/g, '').slice(0, 1);
      if (input.value && i < digits.length - 1) digits[i + 1]?.focus();
      if (readCode().length === 6) void submit();
    });

    input?.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1]?.focus();
      } else if (e.key === 'ArrowLeft' && i > 0) {
        e.preventDefault();
        digits[i - 1]?.focus();
      } else if (e.key === 'ArrowRight' && i < digits.length - 1) {
        e.preventDefault();
        digits[i + 1]?.focus();
      } else if (e.key === 'Enter') {
        void submit();
      }
    });

    // Pasting the whole code (or an SMS/email autofill) must fill every box,
    // not just the one that received the paste.
    input?.addEventListener('paste', e => {
      const text = e.clipboardData?.getData('text')?.replace(/\D/g, '') ?? '';
      if (!text) return;
      e.preventDefault();
      text.slice(0, 6).split('').forEach((ch, idx) => {
        const box = digits[idx];
        if (box) box.value = ch;
      });
      focusFirstEmpty();
      if (readCode().length === 6) void submit();
    });
  });

  digits[0]?.focus();

  // --- verify ---
  let submitting = false;
  const submit = async () => {
    const code = readCode();
    if (code.length !== 6) {
      setMessage('Enter all 6 digits');
      return;
    }
    if (submitting) return;
    submitting = true;
    setButtonLoading('otp-verify-btn', true, 'Verify');
    setMessage('');

    try {
      await verifyOtp(email, code);

      // The code proves the address is real; Firebase still owns the account,
      // so the session continues from here as a normal signed-in user.
      state.otpVerified = true;
      sessionStorage.setItem('sprout.otpVerified', '1');
      sessionStorage.removeItem('sprout.pendingEmail');
      state.isLoggedIn = true;
      const user = auth.currentUser;
      if (user) {
        try {
          state.userProfile = await ensureUserProfile(user);
        } catch {
          state.userProfile = null;
        }
      }
      showToast('✅ Email verified');
      navigate('control');
    } catch (err: any) {
      const remaining = err?.attemptsRemaining;
      setMessage(
        remaining !== undefined
          ? `${err.message} — ${remaining} attempt${remaining === 1 ? '' : 's'} left`
          : err?.message || 'Could not verify that code'
      );
      digits.forEach(d => { if (d) d.value = ''; });
      digits[0]?.focus();
    } finally {
      submitting = false;
      setButtonLoading('otp-verify-btn', false, 'Verify');
    }
  };

  document.getElementById('otp-verify-btn')?.addEventListener('click', () => void submit());

  // --- resend, with a cooldown so the button cannot outpace the rate limit ---
  const resendBtn = document.getElementById('otp-resend-btn') as HTMLButtonElement | null;
  const startCooldown = (seconds: number) => {
    if (!resendBtn) return;
    let left = seconds;
    resendBtn.disabled = true;
    const label = 'Resend code';
    const tick = () => {
      resendBtn.textContent = left > 0 ? `${label} (${left}s)` : label;
      if (left <= 0) {
        resendBtn.disabled = false;
        clearInterval(timer);
      }
      left -= 1;
    };
    tick();
    const timer = setInterval(tick, 1000);
  };

  resendBtn?.addEventListener('click', async () => {
    if (resendBtn.disabled) return;
    resendBtn.disabled = true;
    try {
      const result = await sendOtp(email);
      setMessage(
        result.devCode
          ? `Dev mode — no email configured. Code: ${result.devCode}`
          : 'A new code is on its way',
        'info'
      );
      startCooldown(60);
    } catch (err: any) {
      setMessage(err?.message || 'Could not send a new code');
      startCooldown(err?.retryAfterS ?? 30);
    }
  });

  // --- switch account ---
  document.getElementById('verify-logout')?.addEventListener('click', async e => {
    e.preventDefault();
    await logoutUser().catch(() => {});
    state.isLoggedIn = false;
    state.userProfile = null;
    state.otpVerified = false;
    state.pendingVerifyEmail = null;
    sessionStorage.removeItem('sprout.otpVerified');
    sessionStorage.removeItem('sprout.pendingEmail');
    navigate('login');
  });
}

function setupSignUpEvents() {
  const signupBtn = document.getElementById('signup-btn');
  signupBtn?.addEventListener('click', async () => {
    clearFieldErrors();
    const fullName = (document.getElementById('signup-name') as HTMLInputElement)?.value || '';
    const email = (document.getElementById('signup-email') as HTMLInputElement)?.value || '';
    const organization = (document.getElementById('signup-org') as HTMLInputElement)?.value || '';
    const password = (document.getElementById('signup-password') as HTMLInputElement)?.value || '';
    const agreedToTerms = (document.getElementById('agree-terms') as HTMLInputElement)?.checked || false;

    // Client-side validation with inline errors
    const validation = validateSignUpInput(fullName, email, organization, password, agreedToTerms);
    if (!validation.isValid) {
      if (validation.errors.fullName) showFieldError('signup-name', validation.errors.fullName);
      if (validation.errors.email) showFieldError('signup-email', validation.errors.email);
      if (validation.errors.organization) showFieldError('signup-org', validation.errors.organization);
      if (validation.errors.password) showFieldError('signup-password', validation.errors.password);
      if (validation.errors.terms) showToast('⚠️ ' + validation.errors.terms);
      return;
    }

    // Firebase sign up + Firestore profile save
    setButtonLoading('signup-btn', true, 'Create Account');
    try {
      await signUpUser(fullName, email, organization, password, agreedToTerms);
      state.pendingVerifyEmail = email.trim().toLowerCase();
      state.otpVerified = false;
      sessionStorage.setItem('sprout.pendingEmail', state.pendingVerifyEmail);
      sessionStorage.removeItem('sprout.otpVerified');

      // The account exists; the emailed code is what unlocks the app.
      try {
        const result = await sendOtp(state.pendingVerifyEmail);
        showToast(result.devCode
          ? `Account created. Dev code: ${result.devCode}`
          : 'Account created! 🎉 Check your inbox for the code.');
      } catch (mailErr: any) {
        // The account is real either way — the verify screen can resend.
        showToast('⚠️ Account created, but the code could not be sent: ' + (mailErr?.message || ''));
      }
      navigate('verify-email');
    } catch (err: any) {
      const code = err?.code || '';
      const message = getFirebaseErrorMessage(code) || err.message;
      showToast('❌ ' + message);
    } finally {
      setButtonLoading('signup-btn', false, 'Create Account');
    }
  });

  const togglePw = document.getElementById('toggle-signup-pw');
  togglePw?.addEventListener('click', () => {
    const input = document.getElementById('signup-password') as HTMLInputElement;
    const icon = togglePw.querySelector('.material-symbols-outlined')!;
    if (input.type === 'password') {
      input.type = 'text';
      icon.textContent = 'visibility_off';
    } else {
      input.type = 'password';
      icon.textContent = 'visibility';
    }
  });
}

function setupForgotPasswordEvents() {
  const sendBtn = document.getElementById('send-reset-btn');
  sendBtn?.addEventListener('click', async () => {
    clearFieldErrors();
    const email = (document.getElementById('reset-email') as HTMLInputElement)?.value || '';
    if (!email.trim()) {
      showFieldError('reset-email', 'Email address is required');
      return;
    }

    setButtonLoading('send-reset-btn', true, 'Send Reset Link');
    try {
      await resetPassword(email);
      state.resetTimer = 60;
      showToast('Reset link sent! 📧');
      navigate('reset-success');
    } catch (err: any) {
      const code = err?.code || '';
      const message = getFirebaseErrorMessage(code) || err.message;
      showToast('❌ ' + message);
    } finally {
      setButtonLoading('send-reset-btn', false, 'Send Reset Link');
    }
  });
}

function setupResetSuccessEvents() {
  const backBtn = document.getElementById('back-login-btn');
  backBtn?.addEventListener('click', () => navigate('login'));

  // Countdown timer
  state.resetTimer = 60;
  const timerInterval = setInterval(() => {
    state.resetTimer--;
    const timerEl = document.getElementById('timer-value');
    if (timerEl) {
      if (state.resetTimer <= 0) {
        clearInterval(timerInterval);
        const timerContainer = document.getElementById('resend-timer');
        if (timerContainer) {
          timerContainer.innerHTML = `Didn't receive the email? <a href="#" id="resend-btn" style="color: var(--primary); font-weight: 600;">Resend Now</a>`;
          const resendBtn = document.getElementById('resend-btn');
          resendBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            showToast('Email resent! 📧');
            state.resetTimer = 60;
            navigate('reset-success');
          });
        }
      } else {
        timerEl.textContent = `${state.resetTimer}s`;
      }
    } else {
      clearInterval(timerInterval);
    }
  }, 1000);
}

function setupControlEvents() {
  const feedImg = document.getElementById('live-feed-img') as HTMLImageElement | null;
  const feedVideo = document.getElementById('live-feed-video') as HTMLVideoElement | null;
  const sourceChip = document.getElementById('feed-source-chip');

  const setSourceChip = (label: string) => {
    if (sourceChip) sourceChip.textContent = label;
  };

  // Prefer the rover's MJPEG stream when the AI server is reachable; the
  // bundled still stays up until then so the panel is never blank.
  if (feedImg) {
    connectLiveStream(feedImg).then(connected => {
      if (connected && feedState.source !== 'device') {
        feedState.source = 'server';
        setSourceChip('Rover');
        showToast('📡 Live stream connected');
      }
    });
  }

  setSourceChip(feedState.source === 'device' ? 'Device' : feedState.source === 'server' ? 'Rover' : 'Demo');

  // --- Applies zoom to whichever element is currently visible ---
  const applyZoom = () => {
    const target = feedState.source === 'device' ? feedVideo : feedImg;
    if (target) target.style.transform = `scale(${state.zoom})`;
    // The overlay carries the same transform so boxes scale with the picture
    // instead of drifting away from what they mark.
    const overlay = document.getElementById('detection-overlay');
    if (overlay) overlay.style.transform = `scale(${state.zoom})`;
  };
  applyZoom();

  // --- Device camera toggle ---
  document.getElementById('camera-toggle-btn')?.addEventListener('click', async () => {
    if (feedState.source === 'device') {
      stopDeviceCamera();
      feedState.source = 'server';
      if (feedVideo) feedVideo.hidden = true;
      if (feedImg) feedImg.hidden = false;
      setSourceChip('Demo');
      applyZoom();
      showToast('Device camera stopped');
      return;
    }

    if (!feedVideo) return;

    // WKWebView and Android's WebView both support getUserMedia, so the inline
    // preview works on native as well as web — and it is what the AI loop and
    // the capture button sample from. The platform's modal capture UI is only
    // a fallback for devices where the inline stream will not start.
    try {
      await startDeviceCamera(feedVideo);
      feedState.source = 'device';
      feedVideo.hidden = false;
      if (feedImg) feedImg.hidden = true;
      setSourceChip('Device');
      applyZoom();
      showToast('📹 Device camera live');
      return;
    } catch (err: any) {
      if (!isNative()) {
        return showToast('❌ ' + (err?.message || 'Could not start camera'));
      }
      addLogEntry(`Inline camera unavailable (${err?.message || 'unknown'}) — using system camera`);
    }

    try {
      const capture = await captureNative();
      await refreshCaptureStrip();
      showCaptureAsFeed(capture);
      state.lastCaptureId = capture.id;
      showToast('📸 Captured');
    } catch (err: any) {
      showToast('❌ ' + (err?.message || 'Camera unavailable'));
    }
  });

  // --- Fullscreen ---
  document.getElementById('fullscreen-btn')?.addEventListener('click', () => {
    const el = document.getElementById('video-feed');
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      // iOS Safari does not implement the Fullscreen API on arbitrary elements.
      el.requestFullscreen?.().catch(() => showToast('Fullscreen not supported here'));
    }
  });

  // --- Recording timer: counts from when this screen mounted ---
  const recTimer = document.getElementById('rec-timer');
  if (recTimer) {
    const tick = () => {
      const secs = Math.floor((Date.now() - feedState.sessionStart) / 1000);
      const hh = String(Math.floor(secs / 3600)).padStart(2, '0');
      const mm = String(Math.floor((secs % 3600) / 60)).padStart(2, '0');
      const ss = String(secs % 60).padStart(2, '0');
      recTimer.textContent = `REC ${hh}:${mm}:${ss}`;
    };
    tick();
    clearInterval(recInterval);
    recInterval = window.setInterval(tick, 1000);
  }

  // --- Capture strip ---
  refreshCaptureStrip();
  document.getElementById('clear-captures-btn')?.addEventListener('click', async () => {
    await clearCaptures();
    await refreshCaptureStrip();
    showToast('Captures cleared');
  });

  // AI Button
  const aiBtn = document.getElementById('ai-btn');

  const setAiButton = (active: boolean, label?: string) => {
    if (!aiBtn) return;
    aiBtn.classList.toggle('active', active);
    aiBtn.innerHTML =
      `<span class="material-symbols-outlined">psychology</span> ${
        label ?? (active ? 'AI AUTOMATION ACTIVE' : 'ACTIVATE AI AUTOMATION')
      }`;
  };

  const stopAi = (reason?: string) => {
    stopAutomation();
    state.aiActive = false;
    setAiButton(false);
    const overlay = document.getElementById('detection-overlay') as HTMLCanvasElement | null;
    if (overlay) clearBoxes(overlay);
    if (reason) addLogEntry(reason, 'error');
  };

  aiBtn?.addEventListener('click', async () => {
    if (state.aiActive) {
      stopAi();
      showToast('AI Automation deactivated');
      addLogEntry('AI Automation disabled');
      return;
    }

    if (!feedVideo) return;

    // The loop reads frames from the live preview, so the camera has to be on
    // before inference can start.
    if (feedState.source !== 'device') {
      setAiButton(false, 'STARTING CAMERA…');
      try {
        await startDeviceCamera(feedVideo);
        feedState.source = 'device';
        feedVideo.hidden = false;
        if (feedImg) feedImg.hidden = true;
        setSourceChip('Device');
        applyZoom();
        addLogEntry('Camera activated for AI scanning');
      } catch (err: any) {
        setAiButton(false);
        // The loop samples the inline preview; without it there is nothing to
        // read frames from, and the modal camera cannot substitute because it
        // would reopen on every cycle.
        showToast('❌ ' + (err?.message || 'Could not start camera')
          + ' — tap the camera button to analyse single shots instead');
        return;
      }
    }

    state.aiActive = true;
    setAiButton(true);
    showToast('AI Automation activated 🤖');
    addLogEntry('AI Automation enabled — scanning field');

    startAutomation(feedVideo, {
      onFrame: frame => {
        const overlay = document.getElementById('detection-overlay') as HTMLCanvasElement | null;
        if (overlay && feedVideo) {
          drawBoxes(overlay, feedVideo, frame.detections, frame.frameWidth, frame.frameHeight);
        }

        // The server's own summary already names what each model found.
        addLogEntry(
          `${frame.summary} · ${frame.inferenceTimeMs.toFixed(0)} ms`,
          frame.detections.length ? 'detection' : 'info'
        );

        if (frame.classification) {
          const c = frame.classification;
          addLogEntry(
            `Classified ${c.crop}: ${c.disease} (${(c.confidence * 100).toFixed(0)}%)`,
            'detection'
          );
        } else if (frame.frameNumber === 1 && frame.classificationUnavailable) {
          // Report the missing classifier once, not on every frame.
          addLogEntry('Disease classifier unavailable — detection only', 'error');
        }

        if (frame.frameNumber === 1 && frame.modelsRun === 0) {
          addLogEntry('No models loaded on the server — check server/weights/', 'error');
        }
      },
      onError: (message, fatal) => {
        addLogEntry(fatal ? `AI stopped: ${message}` : `Scan failed: ${message}`, 'error');
        if (fatal) showToast('❌ AI Automation stopped — ' + message);
      },
      onStopped: () => {
        state.aiActive = false;
        setAiButton(false);
      },
    });
  });

  // Zoom slider — now actually scales the feed, not just the label
  const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
  const zoomValue = document.getElementById('zoom-value');
  zoomSlider?.addEventListener('input', () => {
    state.zoom = parseFloat(zoomSlider.value);
    if (zoomValue) zoomValue.textContent = `${state.zoom.toFixed(1)}x`;
    applyZoom();
  });

  // Speed controls
  const speedUp = document.getElementById('speed-up');
  const speedDown = document.getElementById('speed-down');
  const speedValue = document.getElementById('speed-value');

  speedUp?.addEventListener('click', () => {
    state.speed = Math.min(100, state.speed + 5);
    if (speedValue) speedValue.textContent = `${state.speed}%`;
  });

  speedDown?.addEventListener('click', () => {
    state.speed = Math.max(0, state.speed - 5);
    if (speedValue) speedValue.textContent = `${state.speed}%`;
  });

  // Stop button
  const stopBtn = document.getElementById('stop-btn');
  stopBtn?.addEventListener('click', () => {
    state.speed = 0;
    if (speedValue) speedValue.textContent = '0%';

    // An emergency stop has to halt the autonomy too, not just the wheels —
    // leaving the AI running and issuing spray decisions after the operator
    // hit STOP is the opposite of what the button promises.
    if (state.aiActive) {
      stopAi();
      addLogEntry('AI Automation halted by emergency stop', 'error');
    }

    showToast('🛑 Emergency stop! Rover halted.');
    addLogEntry('EMERGENCY STOP — Rover halted', 'error');
  });

  // Capture button — writes a real frame, not a toast
  const captureBtn = document.getElementById('capture-btn');
  captureBtn?.addEventListener('click', async () => {
    try {
      let capture;
      // The live preview is the source of truth when it is running, on native
      // too — opening the modal camera would discard the framing the user has
      // already lined up on screen.
      if (feedState.source === 'device' && feedVideo) {
        capture = await captureFromElement(feedVideo, 'device');
      } else if (isNative()) {
        capture = await captureNative();
      } else if (feedImg) {
        capture = await captureFromElement(feedImg, feedState.source);
      } else {
        return showToast('❌ No feed to capture');
      }

      state.lastCaptureId = capture.id;
      await refreshCaptureStrip();
      addLogEntry(`Frame captured from ${capture.source} feed`);

      // A capture is a request for a diagnosis, so run it and show the report
      // rather than leaving the user to find the Diagnostics tab and press
      // Analyse. Reset first: a stale result from the previous frame rendering
      // under the new photo would be actively misleading.
      diagState.result = null;
      diagState.error = null;
      diagState.status = 'idle';
      showToast('📸 Captured — analysing…');
      navigate('diagnostics');
      void runAnalysis();
    } catch (err: any) {
      showToast('❌ ' + (err?.message || 'Capture failed'));
    }
  });

  // Joystick
  setupJoystick();
}

/** Swaps the feed panel to show a still capture (used after a native capture). */
function showCaptureAsFeed(capture: { id: string; thumb: string }) {
  const img = document.getElementById('live-feed-img') as HTMLImageElement | null;
  const video = document.getElementById('live-feed-video') as HTMLVideoElement | null;
  if (!img) return;
  img.src = getCaptureImage(capture as any);
  img.hidden = false;
  if (video) video.hidden = true;
  state.lastCaptureId = capture.id;
}

/** Re-renders the capture thumbnail strip from storage. */
async function refreshCaptureStrip() {
  const strip = document.getElementById('capture-strip');
  if (!strip) return;

  const captures = await listCaptures();
  if (captures.length === 0) {
    strip.innerHTML = '<div class="capture-empty">No captures yet — tap the camera button on the feed.</div>';
    return;
  }

  strip.innerHTML = captures
    .map(c => {
      const time = new Date(c.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `
        <button class="capture-thumb" data-capture-id="${esc(c.id)}" title="Analyse this frame">
          <img src="${esc(c.thumb)}" alt="Capture at ${esc(time)}" />
          <span class="capture-thumb-time">${esc(time)}</span>
        </button>`;
    })
    .join('');

  // Tapping a capture sends it to Diagnostics for inference.
  strip.querySelectorAll('.capture-thumb').forEach(el => {
    el.addEventListener('click', () => {
      const id = (el as HTMLElement).dataset.captureId;
      if (!id) return;
      state.lastCaptureId = id;
      navigate('diagnostics');
    });
  });
}

/** Prepends an entry to the AI action log on the Control screen. */
type LogKind = 'info' | 'detection' | 'error';

/** Entries kept in the action log; the AI loop appends indefinitely. */
const MAX_LOG_ENTRIES = 50;

function addLogEntry(text: string, kind: LogKind | boolean = 'info') {
  const log = document.getElementById('action-log');
  if (!log) return;
  document.getElementById('log-empty')?.remove();

  // Historic callers pass a boolean "isAlert".
  const resolved: LogKind = typeof kind === 'boolean' ? (kind ? 'error' : 'info') : kind;
  const dotColor =
    resolved === 'error' ? 'var(--red)'
    : resolved === 'detection' ? 'var(--purple)'
    : 'var(--primary)';
  const textStyle = resolved === 'error'
    ? ' style="color: var(--red); font-weight: 600;"'
    : '';

  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <div class="log-dot" style="background: ${dotColor};"></div>
    <span class="log-text"${textStyle}>${esc(text)}</span>
    <span class="log-time">${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
  `;
  log.prepend(entry);

  // Trim from the bottom — a scan every few seconds would otherwise grow the
  // DOM without limit for as long as automation runs.
  while (log.children.length > MAX_LOG_ENTRIES) {
    log.lastElementChild?.remove();
  }
}

function setupJoystick() {
  const area = document.getElementById('joystick-area');
  const knob = document.getElementById('joystick-knob');
  if (!area || !knob) return;

  let isDragging = false;
  const areaRect = () => area.getBoundingClientRect();
  const maxRadius = 46; // max distance from center

  function moveKnob(clientX: number, clientY: number) {
    const rect = areaRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    let dx = clientX - centerX;
    let dy = clientY - centerY;

    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > maxRadius) {
      dx = (dx / dist) * maxRadius;
      dy = (dy / dist) * maxRadius;
    }

    if (knob) knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;

    // Update values
    const joyX = document.getElementById('joy-x');
    const joyY = document.getElementById('joy-y');
    const joyV = document.getElementById('joy-v');
    if (joyX) joyX.textContent = Math.round(dx).toString();
    if (joyY) joyY.textContent = Math.round(-dy).toString();
    if (joyV) joyV.textContent = `N: ${(dist / maxRadius).toFixed(1)}`;
  }

  function resetKnob() {
    if (knob) knob.style.transform = 'translate(-50%, -50%)';
    const joyX = document.getElementById('joy-x');
    const joyY = document.getElementById('joy-y');
    const joyV = document.getElementById('joy-v');
    if (joyX) joyX.textContent = '0';
    if (joyY) joyY.textContent = '0';
    if (joyV) joyV.textContent = 'N: 0.0';
  }

  // Mouse events
  knob.addEventListener('mousedown', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (isDragging) moveKnob(e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      resetKnob();
    }
  });

  // Touch events
  knob.addEventListener('touchstart', (e) => {
    isDragging = true;
    e.preventDefault();
  });

  document.addEventListener('touchmove', (e) => {
    if (isDragging) {
      const touch = e.touches[0];
      moveKnob(touch.clientX, touch.clientY);
    }
  });

  document.addEventListener('touchend', () => {
    if (isDragging) {
      isDragging = false;
      resetKnob();
    }
  });
}

function setupMapsEvents() {
  const canvas = document.getElementById('map-canvas');
  if (!canvas) return;

  initMap(canvas);

  document.getElementById('map-zoom-in')?.addEventListener('click', () => zoomBy(1));
  document.getElementById('map-zoom-out')?.addEventListener('click', () => zoomBy(-1));
  document.getElementById('map-center')?.addEventListener('click', () => {
    if (!centerOnRover()) showToast('No position yet — waiting for rover or device fix');
  });

  const banner = document.getElementById('map-gps-banner');
  const bannerText = document.getElementById('map-gps-text');
  const showBanner = (text: string) => {
    if (bannerText) bannerText.textContent = text;
    if (banner) banner.hidden = false;
  };
  const hideBanner = () => { if (banner) banner.hidden = true; };

  // ---------- DEVICE POSITION (this phone/laptop) ----------
  let hasDeviceFix = false;

  // Paint the previous session's position immediately so the map is not
  // stranded on the world view while the first fix resolves.
  loadLastPosition().then(last => {
    if (last && isMapReady() && !hasDeviceFix) {
      const t: Telemetry = { ...last, heading: null, speed: 0, accuracy: 0, timestamp: Date.now() };
      applyPosition(t, true);
      updateDeviceRow(t, 'last known');
    }
  });

  const onDeviceFix = (t: Telemetry, isFirstFix: boolean) => {
    hasDeviceFix = true;
    hideBanner();
    updateDeviceRow(t, 'GPS');
    if (isFirstFix) showToast('📍 Device location acquired');
  };

  const onDeviceError = async (message: string, denied: boolean) => {
    if (hasDeviceFix) return;

    // GPS is unavailable — fall back to a city-level fix from the network
    // address so the map still opens somewhere meaningful. Desktop browsers
    // (no GPS hardware, OS-level denials) land here routinely.
    const approx = await getApproxPositionFromIP();
    if (approx && !hasDeviceFix) {
      hasDeviceFix = true;
      hideBanner();
      applyPosition(approx, true);
      updateDeviceRow(approx, approx.city ? `approx — ${approx.city}` : 'approx (IP)');
      showToast('📍 Using approximate location — tap the pin button to set it exactly');
      return;
    }

    const el = document.getElementById('tel-device');
    if (el) el.textContent = message;
    const sentence = message.replace(/\s*\.?\s*$/, '.');
    showBanner(denied
      ? `${sentence} You can still set a position manually.`
      : message);
  };

  showBanner('Locating this device…');
  startTracking(onDeviceFix, onDeviceError);

  document.getElementById('gps-retry')?.addEventListener('click', () => {
    showBanner('Locating this device…');
    startTracking(onDeviceFix, onDeviceError);
  });

  // ---------- ROVER POSITION (GPS chip → Arduino → Pi server) ----------
  startRoverPolling((status, isFirstFix) => {
    const setSignal = (text: string, icon: string, color: string) => {
      const el = document.getElementById('tel-signal');
      if (el) el.textContent = text;
      const ic = document.getElementById('tel-signal-icon');
      if (ic) { ic.textContent = icon; (ic as HTMLElement).style.color = color; }
    };

    if (status.state === 'fix') {
      updateRoverTelemetry(status.fix);
      if (isFirstFix) showToast('🛰 Rover GPS connected');
      return;
    }

    if (status.state === 'no_fix') {
      setSignal(
        status.sats !== null
          ? `Acquiring satellites… (${status.sats} in view)`
          : 'Rover GPS acquiring satellites…',
        'satellite_alt', 'var(--orange)'
      );
      return;
    }

    // Offline: only overwrite the cards when the rover has never reported —
    // a brief server drop should not blank real last-seen data.
    setSignal('Rover offline — start the Pi server', 'cloud_off', 'var(--text-muted)');
  });

  // Manual device position — reachable both from the no-fix banner and from
  // the always-visible map control, so it can be corrected after being set.
  const promptForPosition = async () => {
    const entered = await showPrompt({
      title: 'Set device position',
      label: 'Latitude, longitude',
      placeholder: 'e.g. 12.9716, 77.5946',
    });
    if (entered === null) return;

    const parts = entered.split(',').map(v => Number(v.trim()));
    const [lat, lon] = parts;
    if (parts.length !== 2 || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return showToast('❌ Enter as "latitude, longitude"');
    }
    if (lat < -90 || lat > 90) return showToast('❌ Latitude must be between -90 and 90');
    if (lon < -180 || lon > 180) return showToast('❌ Longitude must be between -180 and 180');

    const t = setManualPosition(lat, lon);
    hasDeviceFix = true;
    hideBanner();
    updateDeviceRow(t, 'manual');
    showToast('📍 Device position set');
  };

  document.getElementById('gps-manual')?.addEventListener('click', promptForPosition);
  document.getElementById('map-set-position')?.addEventListener('click', promptForPosition);
}

/** Writes a rover fix into the telemetry cards. */
function updateRoverTelemetry(t: RoverFix) {
  const set = (id: string, html: string) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };

  const latHem = t.lat >= 0 ? 'N' : 'S';
  const lonHem = t.lon >= 0 ? 'E' : 'W';
  set('tel-lat', `${Math.abs(t.lat).toFixed(5)}° <span class="unit">${latHem}</span>`);
  set('tel-lon', `${Math.abs(t.lon).toFixed(5)}° <span class="unit">${lonHem}</span>`);
  set(
    'tel-heading',
    t.heading === null
      ? '—'
      : `${Math.round(t.heading)}° <span class="material-symbols-outlined" style="color: var(--orange); font-size: 16px; transform: rotate(${Math.round(t.heading)}deg);">navigation</span>`
  );
  set(
    'tel-speed',
    `${t.speed.toFixed(1)} <span class="unit">m/s</span> <span class="material-symbols-outlined" style="color: var(--green-success); font-size: 16px;">speed</span>`
  );

  const distance = getTrailLength();
  const travelled = distance >= 1000
    ? `${(distance / 1000).toFixed(2)} km`
    : `${Math.round(distance)} m`;
  const sats = t.sats !== null ? `${t.sats} sats · ` : '';
  set('tel-signal', `3D fix — ${sats}${travelled} tracked`);
  const ic = document.getElementById('tel-signal-icon');
  if (ic) { ic.textContent = 'satellite_alt'; (ic as HTMLElement).style.color = 'var(--green-success)'; }
}

/** Writes the device's own position into its row. */
function updateDeviceRow(t: Telemetry, source: string) {
  const el = document.getElementById('tel-device');
  if (!el) return;
  const latHem = t.lat >= 0 ? 'N' : 'S';
  const lonHem = t.lon >= 0 ? 'E' : 'W';
  const acc = t.accuracy > 0 && t.accuracy < 4999 ? ` · ±${Math.round(t.accuracy)} m` : '';
  el.textContent =
    `${Math.abs(t.lat).toFixed(4)}° ${latHem}, ${Math.abs(t.lon).toFixed(4)}° ${lonHem}${acc} (${source})`;
}

function setupDiagnosticsEvents() {
  loadWeather();

  document.getElementById('analyse-btn')?.addEventListener('click', runAnalysis);
  document.getElementById('export-btn')?.addEventListener('click', exportReport);

  // Arriving here by tapping a capture thumbnail runs the analysis straight
  // away — that tap already expressed the intent.
  if (state.lastCaptureId && !diagState.result && diagState.status === 'idle') {
    runAnalysis();
  }
}

/** Fetches weather for the last known position. */
async function loadWeather() {
  const set = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  const pos = await loadLastPosition();
  if (!pos) {
    set('weather-location', 'Location unavailable');
    set('weather-desc', 'Open Maps to acquire a GPS fix');
    set('weather-temp', '—');
    return;
  }

  set('weather-location', `${pos.lat.toFixed(3)}°, ${pos.lon.toFixed(3)}°`);

  try {
    const w = await fetchWeather(pos.lat, pos.lon);
    set('weather-temp', `${Math.round(w.temperatureC)}°C`);
    set('weather-desc', w.description);
    set('weather-wind', `${Math.round(w.windKph)}km/h Wind`);
    set('weather-humidity', `${Math.round(w.humidityPct)}% Humidity`);
    const icon = document.getElementById('weather-icon');
    if (icon) icon.textContent = w.icon;

    const advice = sprayAdvice(w);
    const adviceEl = document.getElementById('spray-advice');
    if (adviceEl) {
      adviceEl.hidden = false;
      adviceEl.className = `spray-advice ${advice.ok ? 'ok' : 'warn'}`;
      adviceEl.textContent = `${advice.ok ? '✓' : '⚠'} ${advice.reason}`;
    }
  } catch (err: any) {
    set('weather-desc', err?.message || 'Weather unavailable');
    set('weather-temp', '—');
  }
}

/** Sends the selected capture to the model endpoints. */
async function runAnalysis() {
  const region = document.getElementById('inference-region');
  const captures = await listCaptures();
  const capture = state.lastCaptureId
    ? captures.find(c => c.id === state.lastCaptureId) ?? captures[0]
    : captures[0];

  if (!capture) {
    diagState.status = 'error';
    diagState.error = 'No captured frame to analyse';
    if (region) region.innerHTML = renderInferenceCard();
    return showToast('❌ Capture a frame on the Control screen first');
  }

  const image = getCaptureImage(capture);
  diagState.status = 'running';
  diagState.imageDataUrl = image;
  if (region) region.innerHTML = renderInferenceCard();

  try {
    const result = await analyseCapture(image);
    diagState.result = result;
    diagState.status = 'done';
    diagState.error = null;
    showToast(`🔬 ${result.disease} — ${Math.round(result.confidence * 100)}%`);
  } catch (err: any) {
    diagState.status = 'error';
    diagState.error = err?.message || 'Analysis failed';
    diagState.result = null;
    showToast('❌ ' + diagState.error);
  }

  const after = document.getElementById('inference-region');
  if (after) after.innerHTML = renderInferenceCard();
}

/** Generates a real PDF of the current diagnosis. */
async function exportReport() {
  const r = diagState.result;
  if (!r) return showToast('❌ Nothing to export — run an analysis first');

  try {
    // Loaded on demand so jsPDF stays out of the initial bundle.
    const { jsPDF } = await import('jspdf');
    const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
    const margin = 48;
    let y = margin;

    const profile = state.userProfile;
    const sev = severityMeta(r.severity);

    pdf.setFontSize(20).setFont('helvetica', 'bold');
    pdf.text('Sprout — Field Diagnosis Report', margin, y);
    y += 26;

    pdf.setFontSize(10).setFont('helvetica', 'normal').setTextColor(110);
    pdf.text(new Date(r.timestamp).toLocaleString(), margin, y);
    y += 14;
    if (profile) {
      pdf.text(`Operator: ${profile.fullName}${profile.organization ? ` · ${profile.organization}` : ''}`, margin, y);
      y += 14;
      pdf.text(`Rover: ${profile.roverConfig?.roverId ?? '—'} · ${profile.roverConfig?.operationMode ?? '—'}`, margin, y);
      y += 14;
    }

    y += 12;
    pdf.setTextColor(0).setFontSize(13).setFont('helvetica', 'bold');
    pdf.text('Diagnosis', margin, y);
    y += 18;

    pdf.setFontSize(11).setFont('helvetica', 'normal');
    const rows: Array<[string, string]> = [
      ['Crop', r.crop],
      ['Condition', r.disease],
      ['Confidence', `${Math.round(r.confidence * 100)}%`],
      ['Severity', sev.label],
    ];
    if (r.inferenceTimeMs !== null) rows.push(['Inference time', `${r.inferenceTimeMs} ms`]);

    for (const [label, value] of rows) {
      pdf.setTextColor(110).text(label, margin, y);
      pdf.setTextColor(0).text(String(value), margin + 130, y);
      y += 17;
    }

    if (r.treatment) {
      y += 14;
      pdf.setFontSize(13).setFont('helvetica', 'bold').setTextColor(0);
      pdf.text('Recommended Treatment', margin, y);
      y += 18;
      pdf.setFontSize(11).setFont('helvetica', 'normal');
      const t = r.treatment;
      const tRows: Array<[string, string | undefined]> = [
        ['Product', t.product],
        ['Active ingredient', t.activeIngredient],
        ['Dosage', t.dosage],
        ['Method', t.method],
      ];
      for (const [label, value] of tRows) {
        if (!value) continue;
        pdf.setTextColor(110).text(label, margin, y);
        pdf.setTextColor(0).text(String(value), margin + 130, y);
        y += 17;
      }
    }

    if (r.detections.length > 0) {
      y += 14;
      pdf.setFontSize(13).setFont('helvetica', 'bold');
      pdf.text('Detections', margin, y);
      y += 18;
      pdf.setFontSize(11).setFont('helvetica', 'normal');
      for (const d of r.detections.slice(0, 12)) {
        pdf.setTextColor(110).text(d.label, margin, y);
        pdf.setTextColor(0).text(`${Math.round(d.confidence * 100)}%`, margin + 130, y);
        y += 17;
      }
    }

    if (diagState.imageDataUrl) {
      y += 16;
      const pageH = pdf.internal.pageSize.getHeight();
      if (y > pageH - 220) {
        pdf.addPage();
        y = margin;
      }
      pdf.setFontSize(13).setFont('helvetica', 'bold').setTextColor(0);
      pdf.text('Analysed Frame', margin, y);
      y += 14;
      // Fixed width, proportional height — the frame is 4:3 or 16:9.
      pdf.addImage(diagState.imageDataUrl, 'JPEG', margin, y, 320, 240, undefined, 'FAST');
    }

    const filename = `sprout-report-${new Date(r.timestamp).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.pdf`;
    pdf.save(filename);
    showToast('📄 Report exported');
  } catch (err: any) {
    showToast('❌ ' + (err?.message || 'Could not generate PDF'));
  }
}

function setupSettingsEvents() {
  // --- Dark mode: applies immediately, persists locally, mirrors to profile ---
  const darkToggle = document.getElementById('dark-mode-toggle')?.querySelector('input');
  darkToggle?.addEventListener('change', async e => {
    state.darkMode = (e.target as HTMLInputElement).checked;
    await setDarkMode(state.darkMode);
    showToast(state.darkMode ? '🌙 Dark mode enabled' : '☀️ Light mode enabled');
    // Profile sync is best-effort: the theme has already applied locally, so a
    // failed write should not surface as an error the user has to act on.
    const uid = auth.currentUser?.uid;
    if (uid) updateUserPreferences(uid, { darkMode: state.darkMode }).catch(() => {});
  });

  // --- Notifications ---
  const notifToggle = document.getElementById('notifications-toggle')?.querySelector('input');
  notifToggle?.addEventListener('change', async e => {
    state.notifications = (e.target as HTMLInputElement).checked;
    await setPref(KEYS.notifications, state.notifications);
    showToast(state.notifications ? '🔔 Notifications enabled' : '🔕 Notifications disabled');
    const uid = auth.currentUser?.uid;
    if (uid) updateUserPreferences(uid, { notifications: state.notifications }).catch(() => {});
  });

  // --- Logout ---
  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    try {
      await logoutUser();
      state.isLoggedIn = false;
      state.userProfile = null;
      state.devBypass = false;
      sessionStorage.removeItem('sprout.devBypass');
      showToast('Logged out successfully');
      navigate('login');
    } catch (err: any) {
      showToast('❌ Error logging out: ' + err.message);
    }
  });

  // --- Profile editing ---
  const profileCard = document.getElementById('profile-card');
  (profileCard as HTMLElement | null)?.style.setProperty('cursor', 'pointer');
  profileCard?.addEventListener('click', async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;

    const name = await showPrompt({
      title: 'Edit profile',
      label: 'Full name',
      value: state.userProfile?.fullName || '',
      placeholder: 'Your name',
    });
    if (name === null) return;
    if (name.length < 2) return showToast('❌ Name must be at least 2 characters');

    const org = await showPrompt({
      title: 'Edit profile',
      label: 'Organization',
      value: state.userProfile?.organization || '',
      placeholder: 'Farm or company',
    });
    if (org === null) return;

    try {
      await updateProfileFields(uid, { fullName: name, organization: org });
      state.userProfile = await getUserProfile(uid);
      showToast('✅ Profile updated');
      render();
    } catch (err: any) {
      showToast('❌ ' + (err?.message || 'Could not save profile'));
    }
  });

  // --- Rover configuration: each row edits one field ---
  const configFields: Record<string, { title: string; options?: string[]; placeholder?: string }> = {
    roverId: { title: 'Rover ID', placeholder: 'e.g. S-104' },
    operationMode: { title: 'Operation Mode', options: ['Autonomous', 'Manual', 'Hybrid'] },
    sprayRate: { title: 'Spray Rate', placeholder: 'e.g. 120 ml/min' },
  };

  for (const [field, cfg] of Object.entries(configFields)) {
    const item = document.getElementById(`cfg-${field}`);
    if (!item) continue;
    (item as HTMLElement).style.cursor = 'pointer';

    item.addEventListener('click', async () => {
      const uid = auth.currentUser?.uid;
      if (!uid) return showToast('❌ Not signed in');

      const current = state.userProfile?.roverConfig?.[field as keyof UserProfile['roverConfig']] || '';
      const value = await showPrompt({
        title: cfg.title,
        label: `Set ${cfg.title.toLowerCase()}`,
        value: String(current),
        options: cfg.options,
        placeholder: cfg.placeholder,
      });
      if (value === null || value === String(current)) return;
      if (!value) return showToast('❌ Value cannot be empty');

      try {
        await updateRoverConfig(uid, { [field]: value });
        state.userProfile = await getUserProfile(uid);
        showToast(`✅ ${cfg.title} updated`);
        render();
      } catch (err: any) {
        showToast('❌ ' + (err?.message || 'Could not save'));
      }
    });
  }

  // --- Live AI server status ---
  refreshServerStatus();
}

/** Pings the AI server and updates the Settings status row in place. */
async function refreshServerStatus() {
  const row = document.getElementById('status-server');
  if (!row) return;

  const online = await checkServerHealth();
  // The screen may have been navigated away from during the request.
  const current = document.getElementById('status-server');
  if (!current) return;

  const dot = current.querySelector('.status-dot');
  const text = current.querySelector('.status-text');
  dot?.classList.toggle('online', online);
  text?.classList.toggle('online', online);
  if (text) text.textContent = online ? 'Online' : 'Offline';
}

// ============================================
// AUTH STATE LISTENER
// ============================================
onAuthChange(async (user) => {
  // An unverified session may exist (mid-sign-up, or a login bounced to the
  // verify screen) but never counts as logged in, and an app screen reached
  // with one gets redirected to the verification gate.
  if (user && !user.emailVerified && !state.otpVerified && !state.devBypass) {
    state.isLoggedIn = false;
    state.userProfile = null;
    if (APP_SCREENS.includes(state.currentScreen)) {
      navigate('verify-email');
    }
    return;
  }

  if (user) {
    state.isLoggedIn = true;
    try {
      // ensureUserProfile rather than getUserProfile: accounts made outside
      // the sign-up flow have no Firestore document, and every profile read
      // and write downstream assumes one exists.
      state.userProfile = await ensureUserProfile(user);

      // A profile's stored theme wins over the device default, so the setting
      // follows the account across devices.
      const remoteDark = state.userProfile?.preferences?.darkMode;
      if (typeof remoteDark === 'boolean' && remoteDark !== state.darkMode) {
        state.darkMode = remoteDark;
        await setDarkMode(remoteDark);
      }
    } catch {
      // Offline, or rules deny the read — stay signed in with a null profile
      // and let the screens fall back to their defaults.
      state.userProfile = null;
    }
  } else {
    state.isLoggedIn = false;
    state.userProfile = null;
    // Once Firebase settles on "no session", an app screen reached by direct
    // navigation has nothing to show — send it to login. (This fires after
    // session restoration, so a signed-in refresh is unaffected. Dev bypass
    // sessions may run without a Firebase user at all.)
    if (APP_SCREENS.includes(state.currentScreen) && !state.devBypass) {
      navigate('login');
      return;
    }
  }

  // Settings renders profile data, so refresh it once the profile lands.
  if (state.currentScreen === 'settings') render();
});

// ============================================
// INIT
// ============================================
async function init() {
  // Theme first, before the first render, so the app never flashes light and
  // then swaps to dark.
  state.darkMode = await initTheme();
  state.notifications = await getPref<boolean>(KEYS.notifications, true);
  initRouter();
}

init();
