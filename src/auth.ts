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
    sendEmailVerification,
    onAuthStateChanged,
    type User,
} from 'firebase/auth';
import { auth } from './firebase';
import { getDocument, setDocument, updateDocument } from './firestore-rest';

// Firebase Auth's SDK calls have no timeout of their own. On a WebView with no
// route to the network they neither resolve nor reject, which surfaced as a
// login button stuck on "Please wait…" forever. Bounding them turns that into
// an error the UI can actually show.
const AUTH_TIMEOUT_MS = 20000;

function withAuthTimeout<T>(op: Promise<T>, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(
                `${what} timed out after ${AUTH_TIMEOUT_MS / 1000}s — check the device's network connection.`
            )),
            AUTH_TIMEOUT_MS
        );
        op.then(
            v => { clearTimeout(timer); resolve(v); },
            e => { clearTimeout(timer); reject(e); }
        );
    });
}

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
    const userCredential = await withAuthTimeout(
        createUserWithEmailAndPassword(auth, email.trim(), password),
        'Account creation'
    );
    const user = userCredential.user;

    // Step 3: Save profile to Firestore (over REST — see firestore-rest.ts)
    const now = new Date().toISOString();
    const profile: UserProfile = {
        uid: user.uid,
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        organization: organization.trim(),
        createdAt: now,
        updatedAt: now,
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

    // The Auth account already exists by this point, so a failure here leaves
    // an account with no profile. ensureUserProfile() repairs that on the next
    // sign-in rather than blocking the user from proceeding.
    await setDocument(`users/${user.uid}`, profile as unknown as Record<string, unknown>);

    // Step 4: Send the verification email. Best-effort — the verify screen
    // has a resend button, so a transient failure here must not undo an
    // otherwise successful sign-up.
    try {
        await sendEmailVerification(user);
    } catch {
        // Surfaced on the verify screen via resend.
    }

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
    const userCredential = await withAuthTimeout(
        signInWithEmailAndPassword(auth, email.trim(), password),
        'Sign-in'
    );
    const user = userCredential.user;

    // Sign-in has already succeeded, so a slow or failed profile read should
    // not strand the user on the login screen — proceed with a null profile
    // and let the screens fall back to their defaults.
    let profile: UserProfile | null = null;
    try {
        profile = (await getDocument(`users/${user.uid}`)) as UserProfile | null;
    } catch {
        profile = null;
    }

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
// EMAIL VERIFICATION
// ============================================

/** Re-sends the verification email to the signed-in user. */
export async function resendVerificationEmail(): Promise<void> {
    const user = auth.currentUser;
    if (!user) throw new Error('Not signed in — log in first.');
    await sendEmailVerification(user);
}

/**
 * Re-reads the account from the server and reports whether the email is now
 * verified. Clicking the emailed link updates the server record only; the
 * local user object stays stale until reloaded.
 */
export async function reloadAndCheckVerified(): Promise<boolean> {
    const user = auth.currentUser;
    if (!user) return false;
    await user.reload();
    if (auth.currentUser?.emailVerified) {
        // Refresh the ID token so email_verified is true inside it — security
        // rules that check the claim would otherwise still see the old token.
        await auth.currentUser.getIdToken(true).catch(() => {});
        return true;
    }
    return false;
}

// ============================================
// GET USER PROFILE
// ============================================
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
    return (await getDocument(`users/${uid}`)) as UserProfile | null;
}

// ============================================
// PROFILE UPDATES
// ============================================

/**
 * Ensures users/{uid} exists. Accounts created outside the sign-up flow
 * (Firebase Console, REST API) have an Auth record but no profile document,
 * which would make every later update fail on a missing doc.
 */
export async function ensureUserProfile(user: User): Promise<UserProfile> {
    const existing = await getUserProfile(user.uid);
    if (existing) return existing;

    const now = new Date().toISOString();
    const profile: UserProfile = {
        uid: user.uid,
        fullName: user.displayName || user.email?.split('@')[0] || 'Operator',
        email: (user.email || '').toLowerCase(),
        organization: '',
        createdAt: now,
        updatedAt: now,
        role: 'operator',
        preferences: { darkMode: false, notifications: true },
        roverConfig: {
            roverId: 'S-104',
            operationMode: 'Autonomous',
            sprayRate: '120 ml/min',
        },
    };
    await setDocument(`users/${user.uid}`, profile as unknown as Record<string, unknown>);
    return profile;
}

/**
 * Patches rover configuration on the caller's own profile.
 * Field-scoped so it can't clobber concurrent edits to other parts of the doc.
 */
export async function updateRoverConfig(
    uid: string,
    config: Partial<UserProfile['roverConfig']>
): Promise<void> {
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [key, value] of Object.entries(config)) {
        patch[`roverConfig.${key}`] = value;
    }
    await updateDocument(`users/${uid}`, patch);
}

/** Patches app preferences (theme, notifications) on the caller's profile. */
export async function updateUserPreferences(
    uid: string,
    prefs: Partial<UserProfile['preferences']>
): Promise<void> {
    const patch: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    for (const [key, value] of Object.entries(prefs)) {
        patch[`preferences.${key}`] = value;
    }
    await updateDocument(`users/${uid}`, patch);
}

/** Updates the editable identity fields on the caller's profile. */
export async function updateProfileFields(
    uid: string,
    fields: { fullName?: string; organization?: string }
): Promise<void> {
    await updateDocument(`users/${uid}`, {
        ...fields,
        updatedAt: new Date().toISOString(),
    });
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
