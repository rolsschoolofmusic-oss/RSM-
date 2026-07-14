// ─── ONE-TIME SEED SCRIPT ─────────────────────────────────────────
// Run once from the project root:  node seed-admin.mjs
// Delete this file after running.
// ──────────────────────────────────────────────────────────────────
import { initializeApp } from "firebase/app";
import { getFirestore, doc, setDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey:            "AIzaSyC8xqD1VmYPPHL0WnSzJ5cy-xEXkWuJIEo",
  authDomain:        "rol-s-school-of-music.firebaseapp.com",
  projectId:         "rol-s-school-of-music",
  storageBucket:     "rol-s-school-of-music.firebasestorage.app",
  messagingSenderId: "401832287977",
  appId:             "1:401832287977:web:fc18b579d4149232729a78",
};

const app = initializeApp(firebaseConfig);
const db  = getFirestore(app);

// Auth user already exists in Firebase — only create the Firestore document
const UID   = "oAoSVWKaOwUBoT4EErIJjeopWW03";
const EMAIL = "bensonksunny@gmail.com";
const NOW   = new Date().toISOString();

try {
  await setDoc(doc(db, "users", UID), {
    uid:          UID,
    email:        EMAIL,
    displayName:  "Benson K Sunny",
    role:         "super_admin",
    status:       "active",
    lastActivity: NOW,
    createdAt:    NOW,
    updatedAt:    NOW,
  });

  console.log("✅ Firestore user document created");
  console.log("   UID:  ", UID);
  console.log("   Email:", EMAIL);
} catch (err) {
  console.error("❌ Error:", err.message);
}

process.exit(0);
