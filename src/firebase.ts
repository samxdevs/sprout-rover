// ============================================
// FIREBASE CONFIGURATION
// ============================================
// Config is read from .env (see .env.example).
// Create a .env file in the project root and fill in the values
// from Firebase Console > Project Settings > Your apps > Web app.
//
// Note: Firebase web API keys are safe to expose publicly — access is
// controlled by Firestore security rules and Auth settings, not key
// secrecy. They live in .env so dev/prod can point at different
// projects, not because they are credentials.
// ============================================

import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

// Fail loudly at startup rather than with a cryptic auth/invalid-api-key
// error on the first login attempt.
const missing = Object.entries(firebaseConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);

if (missing.length > 0) {
    throw new Error(
        `Firebase is not configured — missing: ${missing.join(', ')}.\n` +
        `Copy .env.example to .env and fill in the values from the Firebase Console, ` +
        `then restart the dev server (Vite only reads .env at startup).`
    );
}

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Auth instance
export const auth = getAuth(app);

// NOTE: there is deliberately no Firestore SDK instance here. Its realtime
// transport cannot establish inside Capacitor's WKWebView (verified on the
// iOS simulator: reads hung >12s even with experimentalForceLongPolling,
// and SDK writes never reject on transport failure — they hang forever).
// All Firestore access goes through firestore-rest.ts instead, which uses
// the plain REST API over the same simple HTTPS that Firebase Auth uses.

export default app;
