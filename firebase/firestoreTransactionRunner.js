/**
 * firebase/firestoreTransactionRunner.js
 *
 * A thin, testable wrapper around Firestore's db.runTransaction() that:
 *
 *   1.  Retries automatically when Firestore returns an ABORTED error
 *       (optimistic-lock conflict — safe to retry, the updateFunction is pure).
 *   2.  Surfaces all other errors unchanged so callers can handle them.
 *   3.  Enforces a maximum retry ceiling so we never spin forever.
 *   4.  Is fully injectable in tests: pass a `db`-like object whose
 *       `runTransaction` method can be replaced with a jest.fn() mock.
 *
 * Background: every write in script.js currently follows the pattern
 *
 *   const snap = await docRef.get();
 *   const data = snap.data();   // mutate …
 *   await docRef.set(data);     // no atomicity — concurrent writes race
 *
 * Phases 2-7 migrate these writes inside runTransaction() calls routed
 * through this module, giving the first true atomicity guarantee in the app.
 *
 * Usage
 * -----
 *   const { runWithRetry } = require('./firebase/firestoreTransactionRunner');
 *
 *   await runWithRetry(db, async (txn) => {
 *     const snap = await txn.get(monthRef);
 *     const data = snap.data();
 *     data.tbb += amount;
 *     txn.set(monthRef, data);
 *   });
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Firestore gRPC / REST error code for optimistic-lock conflict. */
const ABORTED_CODE = "ABORTED";

/** Maximum number of automatic retries on ABORTED before giving up. */
const MAX_RETRIES = 5;

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Run a Firestore transaction, retrying up to MAX_RETRIES times on ABORTED.
 *
 * @param {object}   db               - Firestore database instance (firebase.firestore()).
 * @param {Function} updateFunction   - Async function receiving a Firestore Transaction object.
 *                                      Must be idempotent: Firestore may call it more than once.
 * @param {object}   [options]
 * @param {number}   [options.maxRetries=MAX_RETRIES]  - Override the retry ceiling.
 * @param {Function} [options.onRetry]                 - Called with (attempt, error) on each retry.
 *                                                       Useful for logging / test assertions.
 * @returns {Promise<*>} - Resolves with the return value of updateFunction on success.
 * @throws  {Error}      - Rethrows the error when retries are exhausted or error is not ABORTED.
 */
async function runWithRetry(db, updateFunction, options = {}) {
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const onRetry    = options.onRetry    ?? (() => {});

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await db.runTransaction(updateFunction);
    } catch (err) {
      const isAborted = _isAbortedError(err);

      if (!isAborted || attempt === maxRetries) {
        // Not retryable, or we've exhausted retries — surface unchanged.
        throw err;
      }

      lastError = err;
      onRetry(attempt + 1, err);
      // Brief back-off: 2^attempt * 50 ms (50, 100, 200, 400, 800 ms).
      // This is optional but reduces thundering-herd on high-contention docs.
      await _sleep(Math.pow(2, attempt) * 50);
    }
  }

  // Unreachable in practice (loop always throws or returns), but keeps TS happy.
  throw lastError;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a Firestore error is an optimistic-lock conflict that is
 * safe to retry.
 *
 * Firestore surfaces ABORTED in multiple ways depending on the SDK version:
 *   - Firebase JS SDK compat (9.x compat): err.code === "aborted"
 *   - Firebase Admin SDK (Node):           err.code === "ABORTED" or err.code === 10
 *   - gRPC raw:                            err.code === 10
 *
 * We normalise to uppercase to handle both.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function _isAbortedError(err) {
  if (!err) return false;
  const code = (err.code ?? "").toString().toUpperCase();
  return code === ABORTED_CODE || code === "10";
}

/**
 * Promise-based sleep for back-off between retries.
 * @param {number} ms
 */
function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    runWithRetry,
    // Exported for tests only — internal helpers should not be called by app code.
    _isAbortedError,
    _sleep,
    MAX_RETRIES,
    ABORTED_CODE,
  };
}
