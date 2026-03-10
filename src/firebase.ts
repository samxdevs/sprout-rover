// ============================================
// FIREBASE CONFIGURATION
// ============================================
// Instructions:
// 1. Go to https://console.firebase.google.com
// 2. Create a new project (or use existing)
// 3. Add a Web App in Project Settings
// 4. Enable Authentication > Email/Password
// 5. Enable Cloud Firestore
// 6. Copy your config values below
// ============================================

import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT_ID.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Auth instance
export const auth = getAuth(app);

// Firestore instance
export const db = getFirestore(app);

export default app;
