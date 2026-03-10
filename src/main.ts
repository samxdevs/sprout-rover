import './styles.css';

// ============================================
// APP STATE
// ============================================
const state = {
  currentScreen: 'login',
  isLoggedIn: false,
  aiActive: false,
  speed: 65,
  zoom: 2.4,
  resetTimer: 60,
  darkMode: false,
  notifications: true,
};

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
        <div class="battery-indicator">
          <span class="material-symbols-outlined filled">battery_4_bar</span>
          <span>${state.speed}%</span>
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
      ${renderHeader('Diagnostics')}
      <div class="main-content">
        <!-- Live Video Feed -->
        <div class="video-feed" id="video-feed">
          <img src="/images/rover-field.png" alt="Live rover feed" />
          <div class="video-overlay">
            <div class="rec-badge">
              <span class="rec-dot"></span>
              REC 00:42:16
            </div>
            <div class="video-actions">
              <button class="video-action-btn" id="fullscreen-btn">
                <span class="material-symbols-outlined">fullscreen</span>
              </button>
            </div>
          </div>
          <button class="capture-btn" id="capture-btn">
            <span class="material-symbols-outlined">photo_camera</span>
          </button>
        </div>
        
        <!-- Zoom Slider -->
        <div class="zoom-slider">
          <span class="material-symbols-outlined">zoom_out</span>
          <input type="range" id="zoom-slider" min="1" max="5" step="0.1" value="${state.zoom}" />
          <span class="material-symbols-outlined">zoom_in</span>
          <span class="zoom-value" id="zoom-value">${state.zoom}x</span>
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
          <div class="log-entry">
            <div class="log-dot"></div>
            <span class="log-text">Sprayed weed at [34.0522° N, 118.2437° W]</span>
            <span class="log-time">14:30</span>
          </div>
          <div class="log-entry">
            <div class="log-dot"></div>
            <span class="log-text">Analyzing crop health...</span>
            <span class="log-time">14:29</span>
          </div>
          <div class="log-entry">
            <div class="log-dot"></div>
            <span class="log-text">Path adjusted for obstacle at Row 14</span>
            <span class="log-time">14:28</span>
          </div>
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
          <img src="/images/satellite-farm.png" alt="Satellite farm view" />
          <div class="map-chip">
            <span class="material-symbols-outlined">satellite_alt</span>
            Satellite View
          </div>
          
          <!-- Rover Path SVG -->
          <svg class="rover-path" viewBox="0 0 400 300" preserveAspectRatio="none">
            <path d="M 80,250 Q 120,200 140,180 T 180,140 Q 200,120 220,100 T 280,80 Q 320,70 350,60" 
                  stroke="#2c5926" stroke-width="3" fill="none" stroke-dasharray="8,4" opacity="0.8"/>
          </svg>
          
          <!-- Rover Marker -->
          <div class="rover-marker" style="top: 18%; right: 15%;"></div>
          
          <!-- Map Controls -->
          <div class="map-controls">
            <button class="map-control-btn" id="map-zoom-in">
              <span class="material-symbols-outlined">add</span>
            </button>
            <button class="map-control-btn" id="map-zoom-out">
              <span class="material-symbols-outlined">remove</span>
            </button>
          </div>
          
          <button class="map-center-btn" id="map-center">
            <span class="material-symbols-outlined">my_location</span>
          </button>
        </div>
        
        <!-- Rover Telemetry -->
        <div class="telemetry-section">
          <div class="section-label">
            <span class="material-symbols-outlined">satellite_alt</span>
            ROVER TELEMETRY
          </div>
          <div class="telemetry-grid">
            <div class="telemetry-card">
              <div class="telemetry-label">Latitude</div>
              <div class="telemetry-value">34.0522° <span class="unit">N</span></div>
            </div>
            <div class="telemetry-card">
              <div class="telemetry-label">Longitude</div>
              <div class="telemetry-value">118.2437° <span class="unit">W</span></div>
            </div>
            <div class="telemetry-card">
              <div class="telemetry-label">Heading</div>
              <div class="telemetry-value">42° <span class="material-symbols-outlined" style="color: var(--orange); font-size: 16px;">navigation</span></div>
            </div>
            <div class="telemetry-card">
              <div class="telemetry-label">Velocity</div>
              <div class="telemetry-value">1.2 <span class="unit">m/s</span> <span class="material-symbols-outlined" style="color: var(--green-success); font-size: 16px;">speed</span></div>
            </div>
            <div class="telemetry-card full-width">
              <div>
                <div class="telemetry-label">Signal Status</div>
                <div class="telemetry-value">RTK Fixed — High Precision</div>
              </div>
              <span class="material-symbols-outlined signal-icon" style="font-size: 24px;">cell_tower</span>
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
        <div class="weather-card">
          <div class="weather-header">
            <div>
              <div class="weather-location">Current Location</div>
              <div class="weather-temp">28°C</div>
              <div class="weather-desc">Partly Cloudy</div>
            </div>
            <div class="weather-icon">
              <span class="material-symbols-outlined filled">partly_cloudy_day</span>
            </div>
          </div>
          <div class="weather-details">
            <div class="weather-detail">
              <span class="material-symbols-outlined">air</span>
              12km/h Wind
            </div>
            <div class="weather-detail">
              <span class="material-symbols-outlined">humidity_percentage</span>
              65% Humidity
            </div>
          </div>
        </div>
        
        <!-- AI Inference Result -->
        <div class="section-label">
          <span class="material-symbols-outlined">psychology</span>
          AI INFERENCE RESULT
        </div>
        <div class="inference-card">
          <div class="inference-header">
            <div class="inference-icon">
              <span class="material-symbols-outlined">bug_report</span>
            </div>
            <div class="inference-info">
              <div class="inference-crop">Crop: Rice</div>
              <div class="inference-disease">Rice Blast Detected</div>
            </div>
            <div class="inference-confidence">
              <div class="confidence-label">Confidence</div>
              <div class="confidence-value">94%</div>
            </div>
          </div>
          
          <!-- Severity Bar -->
          <div class="severity-section">
            <div class="severity-row">
              <span class="severity-label">Severity Level</span>
              <span class="severity-badge">HIGH RISK</span>
            </div>
            <div class="severity-bar">
              <div class="severity-indicator"></div>
            </div>
          </div>
        </div>
        
        <!-- Disease Image -->
        <div class="disease-image">
          <img src="/images/rice-blast.png" alt="Rice blast disease on leaf" />
          <span class="disease-image-badge">Rover Cam 04</span>
        </div>
        
        <!-- Recommended Treatment -->
        <div class="section-label">
          <span class="material-symbols-outlined">vaccines</span>
          RECOMMENDED TREATMENT
        </div>
        <div class="treatment-card">
          <div class="treatment-product">
            <span class="material-symbols-outlined">inventory_2</span>
            <div class="treatment-product-info">
              <div class="treatment-product-label">Recommended Product</div>
              <div class="treatment-product-name">Nativo</div>
            </div>
          </div>
          <div class="treatment-details">
            <div class="treatment-row">
              <span class="treatment-row-label">Active Ingredient</span>
              <span class="treatment-row-value">Trifloxystrobin + Tebuconazole</span>
            </div>
            <div class="treatment-row">
              <span class="treatment-row-label">Target Dosage</span>
              <span class="treatment-row-value">120 g/acre</span>
            </div>
            <div class="treatment-row">
              <span class="treatment-row-label">Application Method</span>
              <span class="treatment-row-value">Rover Spray Arm B</span>
            </div>
          </div>
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

// ============================================
// SETTINGS SCREEN
// ============================================
function renderSettings() {
  return `
    <div class="screen settings-screen" id="settings-screen">
      ${renderHeader('Settings')}
      <div class="main-content">
        <!-- Profile Section -->
        <div class="settings-section">
          <div class="settings-section-title">Profile</div>
          <div class="settings-card">
            <div class="profile-card">
              <div class="profile-avatar">JF</div>
              <div class="profile-info">
                <div class="profile-name">John Farmer</div>
                <div class="profile-email">john@sprout.com</div>
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
                <div class="settings-item-label">Backend</div>
              </div>
              <div class="settings-item-right">
                <span class="status-dot online"></span>
                <span class="status-text online">Online</span>
              </div>
            </div>
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">smart_toy</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Rover (S-104)</div>
              </div>
              <div class="settings-item-right">
                <span class="status-dot online"></span>
                <span class="status-text online">Online</span>
              </div>
            </div>
          </div>
        </div>
        
        <!-- Configuration -->
        <div class="settings-section">
          <div class="settings-section-title">Configuration</div>
          <div class="settings-card">
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">tag</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Rover ID</div>
                <div class="settings-item-value">S-104</div>
              </div>
              <span class="material-symbols-outlined" style="color: var(--text-muted);">chevron_right</span>
            </div>
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">tune</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Operation Mode</div>
                <div class="settings-item-value">Autonomous</div>
              </div>
              <span class="material-symbols-outlined" style="color: var(--text-muted);">chevron_right</span>
            </div>
            <div class="settings-item">
              <div class="settings-item-icon">
                <span class="material-symbols-outlined">water_drop</span>
              </div>
              <div class="settings-item-content">
                <div class="settings-item-label">Spray Rate</div>
                <div class="settings-item-value">120 ml/min</div>
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
function render() {
  const app = document.getElementById('app')!;
  
  switch (state.currentScreen) {
    case 'login':
      app.innerHTML = renderLogin();
      setupLoginEvents();
      break;
    case 'signup':
      app.innerHTML = renderSignUp();
      setupSignUpEvents();
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
  loginBtn?.addEventListener('click', () => {
    state.isLoggedIn = true;
    showToast('Welcome back, farmer! 🌱');
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

function setupSignUpEvents() {
  const signupBtn = document.getElementById('signup-btn');
  signupBtn?.addEventListener('click', () => {
    showToast('Account created successfully! 🎉');
    navigate('login');
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
  sendBtn?.addEventListener('click', () => {
    state.resetTimer = 60;
    showToast('Reset link sent! 📧');
    navigate('reset-success');
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
  // AI Button
  const aiBtn = document.getElementById('ai-btn');
  aiBtn?.addEventListener('click', () => {
    state.aiActive = !state.aiActive;
    if (state.aiActive) {
      aiBtn.classList.add('active');
      aiBtn.innerHTML = '<span class="material-symbols-outlined">psychology</span> AI AUTOMATION ACTIVE';
      showToast('AI Automation activated! 🤖');
      // Add log entry
      const log = document.getElementById('action-log');
      if (log) {
        const entry = document.createElement('div');
        entry.className = 'log-entry';
        entry.innerHTML = `
          <div class="log-dot"></div>
          <span class="log-text">AI Automation enabled — scanning field...</span>
          <span class="log-time">${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
        `;
        log.prepend(entry);
      }
    } else {
      aiBtn.classList.remove('active');
      aiBtn.innerHTML = '<span class="material-symbols-outlined">psychology</span> ACTIVATE AI AUTOMATION';
      showToast('AI Automation deactivated');
    }
  });

  // Zoom slider
  const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
  const zoomValue = document.getElementById('zoom-value');
  zoomSlider?.addEventListener('input', () => {
    state.zoom = parseFloat(zoomSlider.value);
    if (zoomValue) zoomValue.textContent = `${state.zoom.toFixed(1)}x`;
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
    showToast('🛑 Emergency stop! Rover halted.');
    const log = document.getElementById('action-log');
    if (log) {
      const entry = document.createElement('div');
      entry.className = 'log-entry';
      entry.innerHTML = `
        <div class="log-dot" style="background: var(--red);"></div>
        <span class="log-text" style="color: var(--red); font-weight: 600;">EMERGENCY STOP — Rover halted</span>
        <span class="log-time">${new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
      `;
      log.prepend(entry);
    }
  });

  // Capture button
  const captureBtn = document.getElementById('capture-btn');
  captureBtn?.addEventListener('click', () => {
    showToast('📸 Screenshot captured!');
  });

  // Joystick
  setupJoystick();
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
    
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    
    // Update values
    const joyX = document.getElementById('joy-x');
    const joyY = document.getElementById('joy-y');
    const joyV = document.getElementById('joy-v');
    if (joyX) joyX.textContent = Math.round(dx).toString();
    if (joyY) joyY.textContent = Math.round(-dy).toString();
    if (joyV) joyV.textContent = `N: ${(dist / maxRadius).toFixed(1)}`;
  }

  function resetKnob() {
    knob.style.transform = 'translate(-50%, -50%)';
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
  const zoomIn = document.getElementById('map-zoom-in');
  const zoomOut = document.getElementById('map-zoom-out');
  const centerBtn = document.getElementById('map-center');
  const mapImg = document.querySelector('.map-container img') as HTMLImageElement;
  let mapScale = 1;

  zoomIn?.addEventListener('click', () => {
    mapScale = Math.min(3, mapScale + 0.2);
    if (mapImg) mapImg.style.transform = `scale(${mapScale})`;
    showToast(`Zoom: ${mapScale.toFixed(1)}x`);
  });

  zoomOut?.addEventListener('click', () => {
    mapScale = Math.max(0.5, mapScale - 0.2);
    if (mapImg) mapImg.style.transform = `scale(${mapScale})`;
    showToast(`Zoom: ${mapScale.toFixed(1)}x`);
  });

  centerBtn?.addEventListener('click', () => {
    mapScale = 1;
    if (mapImg) mapImg.style.transform = 'scale(1)';
    showToast('Centered on rover 📍');
  });
}

function setupDiagnosticsEvents() {
  const exportBtn = document.getElementById('export-btn');
  exportBtn?.addEventListener('click', () => {
    showToast('📄 Report exported as PDF!');
  });
}

function setupSettingsEvents() {
  // Dark mode toggle
  const darkToggle = document.getElementById('dark-mode-toggle');
  darkToggle?.addEventListener('change', (e) => {
    state.darkMode = (e.target as HTMLInputElement).checked;
    showToast(state.darkMode ? '🌙 Dark mode enabled' : '☀️ Light mode enabled');
  });

  // Notifications toggle
  const notifToggle = document.getElementById('notifications-toggle');
  notifToggle?.addEventListener('change', (e) => {
    state.notifications = (e.target as HTMLInputElement).checked;
    showToast(state.notifications ? '🔔 Notifications enabled' : '🔕 Notifications disabled');
  });

  // Logout
  const logoutBtn = document.getElementById('logout-btn');
  logoutBtn?.addEventListener('click', () => {
    state.isLoggedIn = false;
    showToast('Logged out successfully');
    navigate('login');
  });

  // Profile click
  const profileCard = document.querySelector('.profile-card');
  profileCard?.addEventListener('click', () => {
    showToast('Profile editor coming soon!');
  });

  // Configuration items
  document.querySelectorAll('.settings-section:nth-child(3) .settings-item').forEach(item => {
    item.addEventListener('click', () => {
      const label = item.querySelector('.settings-item-label')?.textContent;
      showToast(`${label} settings opening...`);
    });
    (item as HTMLElement).style.cursor = 'pointer';
  });
}

// ============================================
// INIT
// ============================================
initRouter();
