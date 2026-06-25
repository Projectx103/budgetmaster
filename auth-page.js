// ════════════════════════════════════════════════════════════════════════════
// auth-page.js
// DOM wiring for auth.html only. Reads form fields, calls authService, updates
// UI, handles bfcache resets. Knows nothing about Firebase internals.
//
// Why this lives in its own file instead of script.js:
//   - script.js is ~8,600 lines and only runs on the main app. Loading it
//     on the login page would ship ~270KB of unused code.
//   - Keeps a clean separation: auth-flow concerns vs. main-app concerns.
//   - sign_auth.html can later use the same authService with its own
//     auth-page-signup.js wiring file.
// ════════════════════════════════════════════════════════════════════════════

(function () {
  "use strict";

  // ── DOM refs ────────────────────────────────────────────────────────────
  let emailEl;
  let passwordEl;
  let errorEl;
  let loginBtn;

  // ── Firebase deps (set in init) ─────────────────────────────────────────
  let firebaseDeps = null;

  // ── UI helpers ──────────────────────────────────────────────────────────
  function showError(msg) {
    if (errorEl) errorEl.textContent = msg || "";
  }

  function setLoading(on) {
    if (!loginBtn) return;
    loginBtn.textContent = on ? "Signing in…" : "Sign in";
    loginBtn.classList.toggle("loading", on);
    loginBtn.disabled = !!on;
  }

  // ── Main login handler ──────────────────────────────────────────────────
  async function handleLogin() {
    showError("");

    const email    = (emailEl && emailEl.value || "").trim();
    const password = (passwordEl && passwordEl.value) || "";

    if (!email || !password) {
      showError(window.authService.messageFor("missing_fields"));
      return;
    }

    setLoading(true);

    const result = await window.authService.login(firebaseDeps, email, password);

    if (result.ok) {
      // Don't reset loading state — user is being redirected
      window.location.href = "index.html";
      return;
    }

    setLoading(false);
    showError(window.authService.messageFor(result.code));
  }

  // ── bfcache reset ───────────────────────────────────────────────────────
  // Without this, hitting browser back after a failed login can show the page
  // exactly as it was — fields filled, button stuck on "Signing in…"
  function resetForm() {
    if (emailEl)    emailEl.value = "";
    if (passwordEl) passwordEl.value = "";
    showError("");
    setLoading(false);
  }

  function redirectToSignup() {
    window.location.href = "sign_auth.html";
  }

  // ── Init ────────────────────────────────────────────────────────────────
  function init() {
    // Resolve DOM refs once
    emailEl    = document.getElementById("email");
    passwordEl = document.getElementById("password");
    errorEl    = document.getElementById("error-msg");
    loginBtn   = document.getElementById("login-btn");

    // Initialise Firebase via the shared config
    firebaseDeps = window.initFirebase();

    // Wire events — no inline handlers in HTML
    if (loginBtn) loginBtn.addEventListener("click", handleLogin);

    // Enter key submits from anywhere on the page
    document.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleLogin();
    });

    // Sign-up redirect button (replaces inline onclick)
    document.querySelectorAll("[data-action='signup']").forEach(el => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        redirectToSignup();
      });
    });

    // bfcache restore: some browsers don't reliably set event.persisted,
    // so reset unconditionally — it's a no-op if the form was already clean.
    window.addEventListener("pageshow", resetForm);
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
