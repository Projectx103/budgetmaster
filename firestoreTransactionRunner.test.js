/**
 * tests/unit/firestoreTransactionRunner.test.js
 *
 * Phase 0 — "Tests after" for firebase/firestoreTransactionRunner.js.
 *
 * Spec (REFACTOR_PLAN.md Phase 0):
 *   "firestoreTransactionRunner.js: unit test that runTransaction retries
 *    on ABORTED and surfaces other errors unchanged."
 *
 * All tests use a mock `db` object — no real Firestore connection needed.
 */

"use strict";

const {
  runWithRetry,
  _isAbortedError,
  _sleep,
  MAX_RETRIES,
  ABORTED_CODE,
} = require("../../firebase/firestoreTransactionRunner");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an error object that looks like a Firestore ABORTED error. */
function abortedError(codeVariant = "ABORTED") {
  const err = new Error("Transaction contention");
  err.code  = codeVariant;
  return err;
}

/** Create a mock db whose runTransaction resolves/rejects on a schedule. */
function makeMockDb(schedule) {
  // schedule: array of 'resolve' | Error
  // Each call to runTransaction pops the next entry.
  let callCount = 0;
  return {
    runTransaction: jest.fn(async (updateFn) => {
      const entry = schedule[callCount] ?? schedule[schedule.length - 1];
      callCount++;
      if (entry instanceof Error) throw entry;
      // Simulate Firestore calling the updateFunction and returning.
      return updateFn({ _mockTxn: true });
    }),
    _getCallCount: () => callCount,
  };
}

// ---------------------------------------------------------------------------
// _isAbortedError
// ---------------------------------------------------------------------------
describe("_isAbortedError", () => {
  test("returns true for err.code === 'ABORTED' (uppercase)", () => {
    expect(_isAbortedError(abortedError("ABORTED"))).toBe(true);
  });

  test("returns true for err.code === 'aborted' (lowercase — Firebase compat SDK)", () => {
    expect(_isAbortedError(abortedError("aborted"))).toBe(true);
  });

  test("returns true for err.code === '10' (gRPC numeric)", () => {
    expect(_isAbortedError(abortedError("10"))).toBe(true);
  });

  test("returns true for err.code === 10 (gRPC numeric as number)", () => {
    expect(_isAbortedError(abortedError(10))).toBe(true);
  });

  test("returns false for PERMISSION_DENIED", () => {
    expect(_isAbortedError(abortedError("PERMISSION_DENIED"))).toBe(false);
  });

  test("returns false for UNAVAILABLE", () => {
    expect(_isAbortedError(abortedError("UNAVAILABLE"))).toBe(false);
  });

  test("returns false for null/undefined", () => {
    expect(_isAbortedError(null)).toBe(false);
    expect(_isAbortedError(undefined)).toBe(false);
  });

  test("returns false for plain Error with no code", () => {
    expect(_isAbortedError(new Error("oops"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runWithRetry — success paths
// ---------------------------------------------------------------------------
describe("runWithRetry — success paths", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("resolves on first try when updateFunction succeeds immediately", async () => {
    const db = makeMockDb(["resolve"]);
    const updateFn = jest.fn().mockResolvedValue("payload");

    const result = await runWithRetry(db, updateFn);

    expect(db.runTransaction).toHaveBeenCalledTimes(1);
    expect(result).toBe("payload");
  });

  test("resolves after 1 ABORTED retry", async () => {
    const db = makeMockDb([abortedError(), "resolve"]);
    const updateFn = jest.fn().mockResolvedValue("ok");

    const promise = runWithRetry(db, updateFn, { maxRetries: 3 });
    // Advance timers past the first back-off (2^0 * 50 = 50 ms)
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(db.runTransaction).toHaveBeenCalledTimes(2);
    expect(result).toBe("ok");
  });

  test("resolves after multiple ABORTED retries up to MAX_RETRIES", async () => {
    // 3 ABORTED, then success
    const schedule = [
      abortedError(), abortedError(), abortedError(), "resolve",
    ];
    const db = makeMockDb(schedule);
    const updateFn = jest.fn().mockResolvedValue("eventual-ok");

    const promise = runWithRetry(db, updateFn, { maxRetries: 5 });
    await jest.runAllTimersAsync();
    const result = await promise;

    expect(db.runTransaction).toHaveBeenCalledTimes(4); // 3 failures + 1 success
    expect(result).toBe("eventual-ok");
  });

  test("passes the Firestore transaction object to updateFunction", async () => {
    const db = makeMockDb(["resolve"]);
    let receivedTxn;
    const updateFn = jest.fn(async (txn) => {
      receivedTxn = txn;
      return "done";
    });

    await runWithRetry(db, updateFn);
    expect(receivedTxn).toEqual({ _mockTxn: true });
  });
});

// ---------------------------------------------------------------------------
// runWithRetry — error / retry-exhaustion paths
// ---------------------------------------------------------------------------
describe("runWithRetry — error paths", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("throws ABORTED after exhausting all retries", async () => {
    const err = abortedError("ABORTED");
    // Always aborts — never succeeds
    const db = makeMockDb(Array(MAX_RETRIES + 2).fill(err));

    // Run timers concurrently with the assertion so back-off sleeps are flushed
    // while the rejection is still being awaited.
    await expect(
      Promise.all([
        runWithRetry(db, jest.fn(), { maxRetries: MAX_RETRIES }),
        jest.runAllTimersAsync(),
      ])
    ).rejects.toThrow("Transaction contention");

    expect(db.runTransaction).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });

  test("throws PERMISSION_DENIED immediately (no retry)", async () => {
    const permErr = new Error("Missing permissions");
    permErr.code  = "PERMISSION_DENIED";
    const db = makeMockDb([permErr]);

    await expect(runWithRetry(db, jest.fn())).rejects.toThrow("Missing permissions");
    expect(db.runTransaction).toHaveBeenCalledTimes(1); // no retry
  });

  test("throws NOT_FOUND immediately (no retry)", async () => {
    const notFound = new Error("Document not found");
    notFound.code  = "NOT_FOUND";
    const db = makeMockDb([notFound]);

    await expect(runWithRetry(db, jest.fn())).rejects.toThrow("Document not found");
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
  });

  test("preserves the original error object (not a wrapped copy)", async () => {
    const originalErr = new Error("Custom error");
    originalErr.code  = "INTERNAL";
    originalErr.extra = "metadata";
    const db = makeMockDb([originalErr]);

    try {
      await runWithRetry(db, jest.fn());
      fail("should have thrown");
    } catch (err) {
      expect(err).toBe(originalErr); // same reference
      expect(err.extra).toBe("metadata");
    }
  });

  test("ABORTED error after non-ABORTED error is NOT retried (first error wins)", async () => {
    // First call throws PERMISSION_DENIED — that should abort immediately,
    // even if subsequent calls would have been ABORTED.
    const permErr = new Error("denied");
    permErr.code  = "PERMISSION_DENIED";
    const db = makeMockDb([permErr, abortedError(), "resolve"]);

    await expect(runWithRetry(db, jest.fn(), { maxRetries: 5 })).rejects.toThrow("denied");
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// onRetry callback
// ---------------------------------------------------------------------------
describe("runWithRetry — onRetry callback", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("calls onRetry with (attempt, error) on each ABORTED retry", async () => {
    const err      = abortedError();
    const db       = makeMockDb([err, err, "resolve"]);
    const onRetry  = jest.fn();
    const updateFn = jest.fn().mockResolvedValue("ok");

    const promise = runWithRetry(db, updateFn, { maxRetries: 5, onRetry });
    await jest.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, err); // attempt 1
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, err); // attempt 2
  });

  test("does NOT call onRetry on a non-retryable error", async () => {
    const permErr = new Error("no");
    permErr.code  = "UNAVAILABLE";
    const db      = makeMockDb([permErr]);
    const onRetry = jest.fn();

    await expect(runWithRetry(db, jest.fn(), { onRetry })).rejects.toThrow("no");
    expect(onRetry).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// maxRetries option
// ---------------------------------------------------------------------------
describe("runWithRetry — maxRetries option", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("respects maxRetries: 0 (no retries at all)", async () => {
    const db = makeMockDb([abortedError(), "resolve"]);

    await expect(
      Promise.all([
        runWithRetry(db, jest.fn(), { maxRetries: 0 }),
        jest.runAllTimersAsync(),
      ])
    ).rejects.toThrow();

    expect(db.runTransaction).toHaveBeenCalledTimes(1); // only the initial attempt
  });

  test("respects maxRetries: 1 (one retry)", async () => {
    const db = makeMockDb([abortedError(), abortedError(), "resolve"]);

    await expect(
      Promise.all([
        runWithRetry(db, jest.fn(), { maxRetries: 1 }),
        jest.runAllTimersAsync(),
      ])
    ).rejects.toThrow();

    // 1st attempt: ABORTED → retry
    // 2nd attempt: ABORTED → exhausted (maxRetries=1 means 1 retry)
    expect(db.runTransaction).toHaveBeenCalledTimes(2);
  });

  test("uses MAX_RETRIES constant as default", async () => {
    const err = abortedError();
    const db  = makeMockDb(Array(MAX_RETRIES + 10).fill(err));

    await expect(
      Promise.all([
        runWithRetry(db, jest.fn()),
        jest.runAllTimersAsync(),
      ])
    ).rejects.toThrow();

    expect(db.runTransaction).toHaveBeenCalledTimes(MAX_RETRIES + 1);
  });
});

// ---------------------------------------------------------------------------
// Back-off timing (informational — not a hard contract, but good to document)
// ---------------------------------------------------------------------------
describe("runWithRetry — back-off timing", () => {
  test("_sleep returns a promise that resolves after the given ms", async () => {
    jest.useFakeTimers();
    let resolved = false;
    const p = _sleep(100).then(() => { resolved = true; });
    expect(resolved).toBe(false);
    jest.advanceTimersByTime(100);
    await p;
    expect(resolved).toBe(true);
    jest.useRealTimers();
  });
});
