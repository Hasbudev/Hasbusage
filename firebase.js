// firebase.js (ESM)
// 1) Create Firebase project
// 2) Enable Firestore Database
// 3) Paste your config below

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,        
  setDoc,
  deleteDoc,
  collection,
  addDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";


const firebaseConfig = {
  apiKey: "AIzaSyCaRYIh08y6FUZyFqG4LaBzCae16yfQ0nY",
  authDomain: "hasbusage.firebaseapp.com",
  projectId: "hasbusage",
  storageBucket: "hasbusage.firebasestorage.app",
  messagingSenderId: "762175181949",
  appId: "1:762175181949:web:61c40ce604cdc1798fcd14",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);

// Convenience exports
export {
  doc,
  getDoc,
  getDocs,       
  setDoc,
  deleteDoc,
  collection,
  addDoc,
  serverTimestamp
};

