import { initializeApp, getApps, getApp } from "firebase/app";
import { initializeAuth, browserLocalPersistence, getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey:            process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain:        process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId:         process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();

// ─── Auth with persistence set at init time (synchronous, no race) ───────────
// Using initializeAuth + browserLocalPersistence instead of getAuth +
// setPersistence(). The async setPersistence() IIFE raced with AuthContext's
// onAuthStateChanged subscription on mobile — Firebase fired an extra null
// auth state when persistence changed mid-flight, causing the login loop.
// initializeAuth sets persistence synchronously before any subscriber attaches.
//
// Guard: initializeAuth throws if called twice on the same app (HMR / double-
// import). We catch and fall back to getAuth() which returns the existing
// Auth instance. On SSR (no window), getAuth is used directly since
// browserLocalPersistence requires a DOM.
function buildAuth() {
  if (typeof window === "undefined") {
    // Server-side: no IndexedDB/localStorage — use default in-memory auth.
    return getAuth(app);
  }
  try {
    return initializeAuth(app, { persistence: browserLocalPersistence });
  } catch {
    // Auth was already initialized (HMR double-module-eval) — reuse it.
    return getAuth(app);
  }
}

export const auth = buildAuth();
export const db   = getFirestore(app);

export default app;
