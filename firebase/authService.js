// ════════════════════════════════════════════════════════════════════════════
// firebase/authService.js
// Pure auth logic — NO DOM access, NO direct error display.
// Returns a typed result so DOM-wiring code can decide how to present it.
//
// Design principles:
//   - One generic credential-failure message to prevent email enumeration.
//     We do NOT distinguish "wrong email" from "wrong password" anywhere.
//   - All Firebase auth error codes are mapped to our own result codes.
//     No raw Firebase strings ever reach the UI.
//   - This file can be loaded in Node for unit tests (it does not touch
//     window or document at the top level).
//
// SECURITY POSTURE — what this file does and does NOT protect against:
//   ✅ Email enumeration — generic message for all credential failures
//   ✅ Layered approval check — JS checks `approved == true` AND
//      Firestore rules also enforce it (defense in depth)
//   ❌ NOT a custom failed-attempts lockout — that requires a Cloud
//      Function to enforce server-side and is out of scope.
//      We rely on Firebase Auth's built-in IP-based rate limiting
//      (auth/too-many-requests) which fires after ~5 attempts/IP/min.
//
// Result shape:
//   { ok: true,  user }                       // success
//   { ok: false, code: "<kebab-case>" }       // failure
//
// Possible failure codes:
//   "missing_fields"      — caller didn't supply email or password
//   "invalid_credentials" — wrong email, wrong password, user not found,
//                           or any other credential failure (intentionally
//                           merged to prevent email enumeration)
//   "invalid_email"       — malformed email syntax (safe to distinguish —
//                           this is a format error, not a credential signal)
//   "rate_limited"        — Firebase Auth blocked us (too many attempts)
//   "user_not_found_in_db"— Auth succeeded but no Firestore user doc
//   "not_approved"        — User exists but admin hasn't approved them
//   "network"             — network/offline error
//   "unknown"             — anything else
// ════════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ── Map Firebase auth error codes → our result codes ─────────────────────
  // Intentionally merging "user-not-found" + "wrong-password" + "invalid-credential"
  // into one code so the UI cannot distinguish them (prevents email enumeration).
  function _mapFirebaseError(err) {
    const code = (err && err.code) || "";
    switch (code) {
      // ── All credential failures merge into one ──
      case "auth/user-not-found":
      case "auth/wrong-password":
      case "auth/invalid-credential":
      case "auth/invalid-login-credentials":
        return "invalid_credentials";

      // ── These are NOT credential signals, safe to distinguish ──
      case "auth/invalid-email":
        return "invalid_email";
      case "auth/too-many-requests":
        return "rate_limited";
      case "auth/network-request-failed":
        return "network";

      default:
        return "unknown";
    }
  }

  /**
   * Attempt to sign a user in.
   *
   * @param {Object} deps
   * @param {Object} deps.auth   Firebase auth instance
   * @param {Object} deps.db     Firestore instance
   * @param {string} email
   * @param {string} password
   * @returns {Promise<{ok: boolean, user?: any, code?: string}>}
   */
  async function login(deps, email, password) {
    const { auth, db } = deps || {};

    // Defensive: caller should have validated, but never trust the caller
    if (!email || !password) {
      return { ok: false, code: "missing_fields" };
    }

    let cred;
    try {
      cred = await auth.signInWithEmailAndPassword(email, password);
    } catch (err) {
      return { ok: false, code: _mapFirebaseError(err) };
    }

    const user = cred && cred.user;
    if (!user) {
      // Should never happen but guard against the SDK changing shape
      return { ok: false, code: "unknown" };
    }

    // ── Approval gate ──
    // Layered with Firestore rules. If rules are stricter than this check
    // (they are — `isApproved` blocks all budget reads), the JS check is
    // belt-and-braces UX (shows a friendly message) and the rules are the
    // actual security boundary.
    let userDoc;
    try {
      userDoc = await db.collection("users").doc(user.uid).get();
    } catch (err) {
      // Sign the user out — they're in a weird state
      try { await auth.signOut(); } catch (_) {}
      return { ok: false, code: "network" };
    }

    if (!userDoc.exists) {
      try { await auth.signOut(); } catch (_) {}
      return { ok: false, code: "user_not_found_in_db" };
    }

    const data = userDoc.data() || {};
    if (data.approved !== true) {
      try { await auth.signOut(); } catch (_) {}
      return { ok: false, code: "not_approved" };
    }

    return { ok: true, user };
  }

  /**
   * Convert a failure code into a user-facing string.
   * Kept in this file so the mapping lives next to the codes themselves.
   * UI code calls this and never sees the raw Firebase error.
   */
  function messageFor(code) {
    switch (code) {
      case "missing_fields":
        return "Please enter your email and password.";

      // Critical: same message for all credential failures
      case "invalid_credentials":
        return "Incorrect email or password.";

      case "invalid_email":
        return "Please enter a valid email address.";

      case "rate_limited":
        return "Too many attempts. Please wait a moment and try again.";

      case "user_not_found_in_db":
        return "Account record not found. Please contact support.";

      case "not_approved":
        return "Your account is pending approval. Please contact the admin.";

      case "network":
        return "Network error. Please check your connection and try again.";

      default:
        return "Something went wrong. Please try again.";
    }
  }

  // ── Export pattern — works in browser AND Node (for unit tests) ─────────
  const api = { login, messageFor, _mapFirebaseError };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else if (typeof window !== "undefined") {
    window.authService = api;
  }
})();
