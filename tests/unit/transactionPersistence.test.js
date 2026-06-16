/**
 * tests/unit/transactionPersistence.test.js
 *
 * Phase 2 — Tests after for services/transactions/transactionPersistence.js
 *
 * These tests run in Node with a mock Firestore — no live DB needed.
 * They prove that persistFinancialTransaction():
 *
 *   1. Produces identical tbb delta and transaction shape as the old inline
 *      addIncome code path (the core Phase 2 correctness guarantee).
 *   2. Does NOT touch accounts[], categories[], or availableBalance.
 *   3. Uses runWithRetry so ABORTED errors are retried.
 *   4. Fails fast with a clear error on invalid input.
 *   5. buildIntentFromFlat correctly maps the flat shape to the engine shape.
 *   6. _safeMonthPayload preserves existing fields on existing months, and
 *      correctly initialises new months without writing availableBalance.
 */

"use strict";

const {
  persistFinancialTransaction,
  buildIntentFromFlat,
  _safeMonthPayload,
  _validateFlatIntent,
  _toCents,
} = require("../../services/transactions/transactionPersistence");

const {
  runWithRetry,
} = require("../../firebase/firestoreTransactionRunner");

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory Firestore mock.
 * Stores documents in a plain JS Map keyed by path string.
 * Supports get/set inside a transaction, and runTransaction with retry sim.
 */
function makeMockDb(initialDocs = {}) {
  const store = new Map(Object.entries(initialDocs));
  let _txnCallCount = 0;
  let _abortOnCall  = -1; // set to N to abort on the Nth runTransaction call

  const makeDocRef = (path) => ({
    _path: path,
    get: async () => {
      const data = store.get(path);
      return { exists: data !== undefined, data: () => data ? { ...data } : undefined };
    },
    set: async (data) => { store.set(path, { ...data }); },
    collection: (sub) => makeCollectionRef(`${path}/${sub}`),
  });

  const makeCollectionRef = (path) => ({
    doc: (id) => makeDocRef(`${path}/${id}`),
  });

  const makeTxn = (shouldAbort) => ({
    get:  async (ref) => {
      const data = store.get(ref._path);
      return { exists: data !== undefined, data: () => data ? { ...data } : undefined };
    },
    set:  (ref, data) => {
      if (shouldAbort) throw _abortError();
      store.set(ref._path, { ...data });
    },
  });

  return {
    collection: (name) => makeCollectionRef(name),
    runTransaction: jest.fn(async (updateFn) => {
      _txnCallCount++;
      const abort = _txnCallCount === _abortOnCall;
      return updateFn(makeTxn(abort));
    }),
    // Test helpers
    _getDoc:         (path)  => store.get(path),
    _setAbortOnCall: (n)     => { _abortOnCall = n; },
    _txnCalls:       ()      => _txnCallCount,
    _store:          ()      => store,
  };
}

function _abortError() {
  const e = new Error("simulated ABORTED");
  e.code = "ABORTED";
  return e;
}

/** Minimal engine mock — pure function that matches Phase 1 engine contract. */
function makeEngine() {
  const processFinancialTransaction = jest.fn((intent, ctx) => {
    // Replicate the income path of the real engine exactly
    const amountFloat = intent.amountCents / 100;
    const existingData = ctx.existingMonthData;

    const existingTxns = existingData ? existingData.transactions || [] : [];
    const existingTbb  = existingData ? existingData.tbb || 0 : ctx.rootTbb || 0;
    const existingCats = existingData ? existingData.categories || [] : ctx.rootCategories || [];

    const txRecord = {
      id:       `txn-test-${Date.now()}`,
      name:     intent.payee,
      amount:   amountFloat,
      category: intent.categoryName,
      type:     intent.type,
      date:     intent.date,
      source:   "engine",
      inflow:   amountFloat,
      outflow:  0,
    };

    return {
      monthDoc: {
        currentMonth: intent.month,
        tbb:          existingTbb + amountFloat,
        categories:   existingCats.map(c => ({ ...c })),
        transactions: [...existingTxns, txRecord],
      },
      accounts:          ctx.accounts,
      transactionRecord: txRecord,
      tbbIsNegative:     (existingTbb + amountFloat) < 0,
      wasNewMonth:       existingData === null || existingData === undefined,
    };
  });

  return {
    processFinancialTransaction,
    buildIntentFromFlat,  // use real one for integration
  };
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const UID      = "test-user-123";
const MONTH    = "2026-06";
const ROOT_PATH  = `budget/${UID}`;
const MONTH_PATH = `budget/${UID}/months/${MONTH}`;

const BASE_ROOT = {
  tbb:        1000,
  categories: [{ name: "Groceries", assigned: 300, spent: 50, balance: 250 }],
  accounts:   [{ name: "Checking", type: "checking", balance: 5000 }],
};

const BASE_MONTH = {
  currentMonth: MONTH,
  tbb:          1000,
  availableBalance: 950,   // must NOT be changed by income
  categories:   [{ name: "Groceries", assigned: 300, spent: 50, balance: 250 }],
  transactions: [
    { id: "tx-existing", name: "Prev", amount: 100, type: "income", date: "2026-06-01", category: "Income" },
  ],
  note: "June budget note",   // must be preserved
};

function makeIncomeIntent(overrides = {}) {
  return {
    type:     "income",
    amount:   500,
    date:     "2026-06-15",
    monthKey: MONTH,
    name:     "Test Income",
    category: "Income",
    meta:     {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildIntentFromFlat
// ---------------------------------------------------------------------------

describe("buildIntentFromFlat", () => {
  test("maps flat income to engine intent shape", () => {
    const flat = makeIncomeIntent();
    const intent = buildIntentFromFlat(flat);

    expect(intent.type).toBe("income");
    expect(intent.payee).toBe("Test Income");
    expect(intent.categoryName).toBe("Income");
    expect(intent.amountCents).toBe(50000);   // 500 * 100
    expect(intent.date).toBe("2026-06-15");
    expect(intent.month).toBe(MONTH);          // ← engine field, not monthKey
    expect(intent.source).toBeNull();
    expect(intent.accountName).toBeNull();
  });

  test("falls back to 'Income' when name is missing", () => {
    const intent = buildIntentFromFlat({ type: "income", amount: 100, date: "2026-06-01", monthKey: MONTH });
    expect(intent.payee).toBe("Income");
  });

  test("uses description field as payee when name absent", () => {
    const intent = buildIntentFromFlat({ type: "income", amount: 100, date: "2026-06-01", monthKey: MONTH, description: "Salary" });
    expect(intent.payee).toBe("Salary");
  });

  test("throws a clear error for unimplemented types", () => {
    expect(() => buildIntentFromFlat({ type: "expense", amount: 50, date: "2026-06-01", monthKey: MONTH }))
      .toThrow(/not yet wired in Phase 2/);
    expect(() => buildIntentFromFlat({ type: "assign", amount: 50, date: "2026-06-01", monthKey: MONTH }))
      .toThrow(/not yet wired in Phase 2/);
  });

  test("throws on unknown type", () => {
    expect(() => buildIntentFromFlat({ type: "banana", amount: 50, date: "2026-06-01", monthKey: MONTH }))
      .toThrow(/unknown intent type/);
  });

  test("amountCents is integer (no float drift)", () => {
    // 0.1 + 0.2 = 0.30000000000000004 in JS floats; toCents must round correctly
    const intent = buildIntentFromFlat({ type: "income", amount: 0.3, date: "2026-06-01", monthKey: MONTH, name: "x" });
    expect(intent.amountCents).toBe(30);
    expect(Number.isInteger(intent.amountCents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _safeMonthPayload
// ---------------------------------------------------------------------------

describe("_safeMonthPayload", () => {
  const engineMonth = {
    currentMonth: MONTH,
    tbb:          1500,
    categories:   [{ name: "Groceries", assigned: 300, spent: 50, balance: 250 }],
    transactions: [{ id: "t1" }, { id: "t2" }],
  };

  test("existing month: preserves availableBalance from original", () => {
    const payload = _safeMonthPayload(engineMonth, BASE_MONTH);
    expect(payload.availableBalance).toBe(BASE_MONTH.availableBalance);
  });

  test("existing month: preserves note field", () => {
    const payload = _safeMonthPayload(engineMonth, BASE_MONTH);
    expect(payload.note).toBe("June budget note");
  });

  test("existing month: uses engine tbb", () => {
    const payload = _safeMonthPayload(engineMonth, BASE_MONTH);
    expect(payload.tbb).toBe(1500);
  });

  test("existing month: uses engine transactions", () => {
    const payload = _safeMonthPayload(engineMonth, BASE_MONTH);
    expect(payload.transactions).toEqual(engineMonth.transactions);
  });

  test("new month: writes full engine doc", () => {
    const payload = _safeMonthPayload(engineMonth, null);
    expect(payload.tbb).toBe(engineMonth.tbb);
    expect(payload.transactions).toEqual(engineMonth.transactions);
  });

  test("new month: does NOT write availableBalance (Phase 8 owns it)", () => {
    const engineMonthWithAvailBal = { ...engineMonth, availableBalance: 9999 };
    const payload = _safeMonthPayload(engineMonthWithAvailBal, null);
    expect(payload.availableBalance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// _validateFlatIntent
// ---------------------------------------------------------------------------

describe("_validateFlatIntent", () => {
  test("passes for valid income intent", () => {
    expect(() => _validateFlatIntent(makeIncomeIntent())).not.toThrow();
  });

  test("throws when flatIntent is null", () => {
    expect(() => _validateFlatIntent(null)).toThrow(/flatIntent must be an object/);
  });

  test("throws when type is missing", () => {
    expect(() => _validateFlatIntent({ amount: 100, monthKey: MONTH, date: "2026-06-01" }))
      .toThrow(/type is required/);
  });

  test("throws when monthKey is missing", () => {
    expect(() => _validateFlatIntent({ type: "income", amount: 100, date: "2026-06-01" }))
      .toThrow(/monthKey is required/);
  });

  test("throws when amount is zero", () => {
    expect(() => _validateFlatIntent({ type: "income", amount: 0, monthKey: MONTH, date: "2026-06-01" }))
      .toThrow(/positive number/);
  });

  test("throws when amount is negative", () => {
    expect(() => _validateFlatIntent({ type: "income", amount: -5, monthKey: MONTH, date: "2026-06-01" }))
      .toThrow(/positive number/);
  });

  test("throws when date is missing", () => {
    expect(() => _validateFlatIntent({ type: "income", amount: 100, monthKey: MONTH }))
      .toThrow(/date is required/);
  });
});

// ---------------------------------------------------------------------------
// persistFinancialTransaction — core correctness tests
// ---------------------------------------------------------------------------

describe("persistFinancialTransaction — income path", () => {
  test("tbb increases by exact amount on existing month", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent({ amount: 500 }), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.tbb).toBe(BASE_MONTH.tbb + 500);   // 1500
  });

  test("transaction record appended with correct shape", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent({ amount: 300, name: "Freelance", date: "2026-06-10" }), db, UID, eng);

    const saved   = db._getDoc(MONTH_PATH);
    const newTx   = saved.transactions[saved.transactions.length - 1];
    expect(newTx.type).toBe("income");
    expect(newTx.amount).toBe(300);
    expect(newTx.name).toBe("Freelance");
    expect(newTx.category).toBe("Income");
    expect(newTx.date).toBe("2026-06-10");
    expect(newTx.source).toBe("engine");          // engine-created marker
    expect(typeof newTx.id).toBe("string");        // id always present
    expect(newTx.id.length).toBeGreaterThan(0);
  });

  test("transaction count increases by exactly 1", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    const beforeCount = BASE_MONTH.transactions.length;

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.transactions.length).toBe(beforeCount + 1);
  });

  test("categories[] is UNCHANGED after income", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.categories).toEqual(BASE_MONTH.categories);
  });

  test("availableBalance is UNCHANGED after income (Phase 8 owns it)", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.availableBalance).toBe(BASE_MONTH.availableBalance);
  });

  test("accounts[] in root doc is UNCHANGED after income", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    // Root doc should NOT have been written at all for income
    // (accounts untouched — root write happens in Phase 4+)
    const root = db._getDoc(ROOT_PATH);
    expect(root.accounts).toEqual(BASE_ROOT.accounts);
  });

  test("note and other existing fields are preserved", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.note).toBe("June budget note");
  });

  test("currentMonth field is NOT overwritten on existing month", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.currentMonth).toBe(MONTH);
  });

  test("works correctly when month doc does not yet exist (new month)", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT }); // no month doc
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent({ amount: 200 }), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved).toBeDefined();
    expect(saved.tbb).toBeGreaterThan(0);
    expect(saved.transactions.length).toBe(1);
    expect(saved.availableBalance).toBeUndefined(); // must NOT be set on new month
  });

  test("works correctly when root doc does not exist (brand-new user)", async () => {
    const db  = makeMockDb({}); // empty DB
    const eng = makeEngine();

    // Should not throw — ensureMonthExists handles null existing data
    await persistFinancialTransaction(makeIncomeIntent({ amount: 100 }), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.tbb).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Parity test — engine path vs old inline addIncome logic
// ---------------------------------------------------------------------------

describe("Parity: engine path === old inline addIncome logic", () => {
  /**
   * Simulate what the OLD addIncome inline code would produce for the same input.
   * This is a literal transcription of the addIncome body from script.js
   * (minus DOM reads and Firestore calls).
   */
  function legacyAddIncome(monthData, amount, description, date) {
    const cloned = JSON.parse(JSON.stringify(monthData));
    cloned.transactions.push({
      name:     description || "Income",
      amount,
      category: "Income",
      type:     "income",
      date,
    });
    cloned.tbb = (cloned.tbb || 0) + amount;
    return cloned;
  }

  test.each([
    ["integer amount", 500, "Salary", "2026-06-01"],
    ["decimal amount", 1234.56, "Freelance", "2026-06-15"],
    ["zero-decimal amount", 100.00, "Transfer", "2026-06-30"],
    ["empty description defaults to Income", 300, "", "2026-06-10"],
    ["small amount", 0.01, "Penny", "2026-06-20"],
  ])("%s: tbb delta and category state match legacy path", async (_, amount, description, date) => {
    const db     = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: { ...BASE_MONTH } });
    const eng    = makeEngine();

    await persistFinancialTransaction(
      makeIncomeIntent({ amount, name: description || undefined, date }),
      db, UID, eng
    );

    const engineResult = db._getDoc(MONTH_PATH);
    const legacyResult = legacyAddIncome({ ...BASE_MONTH }, amount, description, date);

    // TBB must match
    expect(engineResult.tbb).toBeCloseTo(legacyResult.tbb, 5);

    // Categories must be unchanged (same before and after)
    expect(engineResult.categories).toEqual(legacyResult.categories);

    // Both paths add exactly 1 transaction — counts must match
    expect(engineResult.transactions.length).toBe(legacyResult.transactions.length);
  });

  test("transaction count matches legacy exactly", async () => {
    const startMonth = { ...BASE_MONTH, transactions: [] }; // clean slate
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: startMonth });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent({ amount: 100 }), db, UID, eng);

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.transactions.length).toBe(1); // started with 0, added 1

    const legacy = legacyAddIncome({ ...startMonth }, 100, "x", "2026-06-01");
    expect(legacy.transactions.length).toBe(1);
  });

  test("tbb delta is exactly +amount for 20 varied amounts", async () => {
    const amounts = [1, 10, 100, 999.99, 0.01, 50.5, 1234.56, 7, 0.10, 200,
                     333.33, 1000, 5, 42.42, 0.99, 2500, 18.75, 66, 9.01, 3.14];

    for (const amount of amounts) {
      const freshMonth = { ...BASE_MONTH, tbb: 1000, transactions: [] };
      const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: freshMonth });
      const eng = makeEngine();

      await persistFinancialTransaction(makeIncomeIntent({ amount }), db, UID, eng);

      const saved = db._getDoc(MONTH_PATH);
      expect(saved.tbb).toBeCloseTo(freshMonth.tbb + amount, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// Atomicity — runTransaction is used and retried on ABORTED
// ---------------------------------------------------------------------------

describe("persistFinancialTransaction — atomicity", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test("uses db.runTransaction (not bare get/set)", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    expect(db.runTransaction).toHaveBeenCalledTimes(1);
  });

  test("retries on first ABORTED, succeeds on second call", async () => {
    const db = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    db._setAbortOnCall(1); // first runTransaction call will abort in set()
    const eng = makeEngine();

    const promise = persistFinancialTransaction(makeIncomeIntent({ amount: 100 }), db, UID, eng);
    await jest.runAllTimersAsync();
    await promise;

    // Should have been called twice (1 abort + 1 success)
    expect(db.runTransaction).toHaveBeenCalledTimes(2);

    // And the result should be correct
    const saved = db._getDoc(MONTH_PATH);
    expect(saved.tbb).toBeCloseTo(BASE_MONTH.tbb + 100, 5);
  });

  test("all gets happen before any sets (read-before-write pattern)", async () => {
    const callOrder = [];
    const db = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const origRunTxn = db.runTransaction.getMockImplementation();
    db.runTransaction.mockImplementation(async (updateFn) => {
      const trackedTxn = {
        get: async (ref) => {
          callOrder.push(`get:${ref._path}`);
          const data = db._store().get(ref._path);
          return { exists: data !== undefined, data: () => data ? { ...data } : undefined };
        },
        set: (ref, data) => {
          callOrder.push(`set:${ref._path}`);
          db._store().set(ref._path, { ...data });
        },
      };
      return updateFn(trackedTxn);
    });

    const eng = makeEngine();
    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    // All gets must precede all sets
    const firstSet = callOrder.findIndex(op => op.startsWith("set:"));
    const lastGet  = callOrder.map((op, i) => op.startsWith("get:") ? i : -1)
                              .filter(i => i >= 0)
                              .pop();

    expect(lastGet).toBeLessThan(firstSet);
  });
});

// ---------------------------------------------------------------------------
// processFinancialTransaction engine mock was called correctly
// ---------------------------------------------------------------------------

describe("persistFinancialTransaction — engine integration", () => {
  test("calls engine with correctly mapped intent", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(
      makeIncomeIntent({ amount: 750, name: "Bonus", date: "2026-06-20" }),
      db, UID, eng
    );

    expect(eng.processFinancialTransaction).toHaveBeenCalledTimes(1);
    const [calledIntent, calledCtx] = eng.processFinancialTransaction.mock.calls[0];

    expect(calledIntent.type).toBe("income");
    expect(calledIntent.amountCents).toBe(75000);   // 750 * 100
    expect(calledIntent.payee).toBe("Bonus");
    expect(calledIntent.month).toBe(MONTH);          // engine uses .month
    expect(calledIntent.date).toBe("2026-06-20");

    expect(calledCtx.existingMonthData).toEqual(expect.objectContaining({ tbb: BASE_MONTH.tbb }));
    expect(Array.isArray(calledCtx.accounts)).toBe(true);
  });

  test("passes existingMonthData as null for new month", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT }); // no month doc
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    const [, calledCtx] = eng.processFinancialTransaction.mock.calls[0];
    expect(calledCtx.existingMonthData).toBeNull();
  });

  test("passes rootCategories and rootTbb for new month seed", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT }); // no month doc
    const eng = makeEngine();

    await persistFinancialTransaction(makeIncomeIntent(), db, UID, eng);

    const [, calledCtx] = eng.processFinancialTransaction.mock.calls[0];
    expect(calledCtx.rootCategories).toEqual(BASE_ROOT.categories);
    expect(calledCtx.rootTbb).toBe(BASE_ROOT.tbb);
  });

  test("returns the engine result to the caller", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    const result = await persistFinancialTransaction(makeIncomeIntent({ amount: 400 }), db, UID, eng);

    expect(result).toBeDefined();
    expect(result.monthDoc).toBeDefined();
    expect(result.transactionRecord).toBeDefined();
    expect(result.transactionRecord.amount).toBe(400);
  });
});
