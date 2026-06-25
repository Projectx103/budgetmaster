// ════════════════════════════════════════════════════════════════════════════
// firebase/firebaseConfig.js
// Single source of truth for the Firebase config object.
//
// IMPORTANT — security note on apiKey:
//   The "apiKey" below is NOT a secret. It is a public identifier that
//   Google requires in client-side Firebase SDKs to route requests to the
//   correct project. The actual security boundary is Firestore Security
//   Rules + Firebase Auth — both of which are in place.
//   See: https://firebase.google.com/docs/projects/api-keys
//
// USAGE — script tag pattern (no bundler):
//   <script src="firebase/firebaseConfig.js"></script>
//   window.firebaseConfig is then available.
//
// Whenever you change the Firebase project (e.g. staging vs prod), this is
// the ONLY file that needs to change. All other code reads window.firebaseConfig.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  const firebaseConfig = {
    apiKey:             "AIzaSyA1txE-ewGSTwVrNk7gVz3z8yLeYTdwYwk",
    authDomain:         "budget-monitoringv2.firebaseapp.com",
    projectId:          "budget-monitoringv2",
    storageBucket:      "budget-monitoringv2.firebasestorage.app",
    messagingSenderId:  "539949688092",
    appId:              "1:539949688092:web:0655e0318504c6a4e946d9",
    measurementId:      "G-M8DLXRV0DW",
  };

  // Expose on window so plain <script> tags (no bundler) can access it
  window.firebaseConfig = firebaseConfig;

  // Convenience init helper — call once per page. Idempotent: safe to call
  // multiple times because firebase.apps already tracks the default app.
  window.initFirebase = function initFirebase() {
    if (typeof firebase === "undefined") {
      throw new Error(
        "[firebaseConfig] firebase global not found. " +
        "Make sure firebase-app-compat.js is loaded BEFORE firebaseConfig.js."
      );
    }
    if (firebase.apps && firebase.apps.length === 0) {
      firebase.initializeApp(firebaseConfig);
    }
    return {
      auth: firebase.auth(),
      db:   firebase.firestore(),
    };
  };
})();
