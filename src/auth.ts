// ============================================
// AUTH & USER PROFILE FUNCTIONS
// ============================================
// Sign Up: Validate → Firebase Auth → Firestore Profile
// Login: Firebase Auth → Navigate to Control
// Logout: Firebase Sign Out → Navigate to Login
// Reset: Firebase Password Reset Email
// ============================================

import {
    createUserWithEmailAndPassword,
    signInWithEmailAndPassword,
    signOut,
    sendPasswordResetEmail,
    onAuthStateChanged,
    type User,
} from 'firebase/auth';
import {
    doc,
    setDoc,
    getDoc,
    serverTimestamp,
} from 'firebase/firestore';
import { auth, db } from './firebase';

// ============================================
// TYPES
// ============================================
export interface UserProfile {
    uid: string;
    fullName: string;
    email: string;
    organization: string;
    createdAt: unknown;
    updatedAt: unknown;
    role: string;
    preferences: {
        darkMode: boolean;
        notifications: boolean;
    };
    roverConfig: {
        roverId: string;
        operationMode: string;
        sprayRate: string;
    };
}

export interface ValidationResult {
    isValid: boolean;
    errors: Record<string, string>;
}

// ============================================
// VALIDATION
// ============================================

/**
 * Validates sign-up form input.
 * Returns { isValid, errors } where errors is a map of field name → error message.
 */
export function validateSignUpInput(
    fullName: string,
    email: string,
    organization: string,
    password: string,
    agreedToTerms: boolean
): ValidationResult {
    const errors: Record<string, string> = {};

    // Full Name
    if (!fullName || fullName.trim().length === 0) {
        errors.fullName = 'Full name is required';
    } else if (fullName.trim().length < 2) {
        errors.fullName = 'Name must be at least 2 characters';
    } else if (fullName.trim().length > 100) {
        errors.fullName = 'Name must be 100 characters or less';
    }

    // Email
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!email || email.trim().length === 0) {
        errors.email = 'Email address is required';
    } else if (!emailRegex.test(email.trim())) {
        errors.email = 'Please enter a valid email address';
    }

    // Organization
    if (!organization || organization.trim().length === 0) {
        errors.organization = 'Organization is required';
    }

    // Password
    if (!password || password.length === 0) {
        errors.password = 'Password is required';
    } else if (password.length < 8) {
        errors.password = 'Password must be at least 8 characters';
    } else if (!/[A-Z]/.test(password)) {
        errors.password = 'Password must include an uppercase letter';
    } else if (!/[0-9]/.test(password)) {
        errors.password = 'Password must include a number';
    }

    // Terms
    if (!agreedToTerms) {
        errors.terms = 'You must agree to the Terms of Service';
    }

    return {
        isValid: Object.keys(errors).length === 0,
        errors,
    };
}

/**
 * Validates login form input.
 */
export function validateLoginInput(
    email: string,
    password: string
): ValidationResult {
    const errors: Record<string, string> = {};

    if (!email || email.trim().length === 0) {
        errors.email = 'Email address is required';
    }
    if (!password || password.length === 0) {
        errors.password = 'Password is required';
    }

    return {
        isValid: Object.keys(errors).length === 0,
        errors,
    };
}

// ============================================
// SIGN UP — Create user + save profile
// ============================================

/**
 * Creates a Firebase Auth user and saves their profile to Firestore.
 * 
 * Flow:
 * 1. Validate all inputs
 * 2. Create Firebase Auth user with email/password
 * 3. Create Firestore document at users/{uid}
 * 4. Return the user object
 * 
 * Throws on validation failure or Firebase errors.
 */
export async function signUpUser(
    fullName: string,
    email: string,
    organization: string,
    password: string,
    agreedToTerms: boolean
): Promise<{ user: User; profile: UserProfile }> {
    // Step 1: Validate
    const validation = validateSignUpInput(fullName, email, organization, password, agreedToTerms);
    if (!validation.isValid) {
        const firstError = Object.values(validation.errors)[0];
        throw new Error(firstError);
    }

    // Step 2: Create Firebase Auth user
    const userCredential = await createUserWithEmailAndPassword(
        auth,
        email.trim(),
        password
    );
    const user = userCredential.user;

    // Step 3: Save profile to Firestore
    const profile: UserProfile = {
        uid: user.uid,
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        organization: organization.trim(),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
        role: 'operator',
        preferences: {
            darkMode: false,
            notifications: true,
        },
        roverConfig: {
            roverId: 'S-104',
            operationMode: 'Autonomous',
            sprayRate: '120 ml/min',
        },
    };

    await setDoc(doc(db, 'users', user.uid), profile);

    return { user, profile };
}

// ============================================
// LOGIN
// ============================================

/**
 * Signs in with email and password.
 * Returns the user profile from Firestore.
 */
export async function loginUser(
    email: string,
    password: string
): Promise<{ user: User; profile: UserProfile | null }> {
    // Validate
    const validation = validateLoginInput(email, password);
    if (!validation.isValid) {
        const firstError = Object.values(validation.errors)[0];
        throw new Error(firstError);
    }

    // Sign in
    const userCredential = await signInWithEmailAndPassword(auth, email.trim(), password);
    const user = userCredential.user;

    // Fetch profile
    const profileDoc = await getDoc(doc(db, 'users', user.uid));
    const profile = profileDoc.exists() ? (profileDoc.data() as UserProfile) : null;

    return { user, profile };
}

// ============================================
// LOGOUT
// ============================================
export async function logoutUser(): Promise<void> {
    await signOut(auth);
}

// ============================================
// PASSWORD RESET
// ============================================
export async function resetPassword(email: string): Promise<void> {
    if (!email || email.trim().length === 0) {
        throw new Error('Email address is required');
    }
    await sendPasswordResetEmail(auth, email.trim());
}

// ============================================
// AUTH STATE OBSERVER
// ============================================

/**
 * Listen for auth state changes.
 * Returns unsubscribe function.
 */
export function onAuthChange(callback: (user: User | null) => void) {
    return onAuthStateChanged(auth, callback);
}

// ============================================
// GET USER PROFILE
// ============================================
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
    const profileDoc = await getDoc(doc(db, 'users', uid));
    return profileDoc.exists() ? (profileDoc.data() as UserProfile) : null;
}

// ============================================
// FIREBASE ERROR MESSAGE MAPPING
// ============================================
export function getFirebaseErrorMessage(errorCode: string): string {
    const messages: Record<string, string> = {
        'auth/email-already-in-use': 'This email is already registered. Try logging in.',
        'auth/invalid-email': 'Please enter a valid email address.',
        'auth/weak-password': 'Password is too weak. Use at least 8 characters.',
        'auth/user-not-found': 'No account found with this email.',
        'auth/wrong-password': 'Incorrect password. Please try again.',
        'auth/too-many-requests': 'Too many attempts. Please try again later.',
        'auth/network-request-failed': 'Network error. Check your connection.',
        'auth/invalid-credential': 'Invalid email or password.',
    };
    return messages[errorCode] || 'An unexpected error occurred. Please try again.';
}
