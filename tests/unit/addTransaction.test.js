/**
 * tests/unit/addTransaction.test.js
 *
 * Phase 4 — Tests for wiring addTransaction() (dashboard expenses) through
 * the engine.
 *
 * Covers:
 *   1. buildIntentFromFlat — expense branch
 *   2. computeBudgetDelta  — expense path (category.spent increases, TBB unchanged)
 *   3. persistFinancialTransaction — expense end-to-end with mock engine
 *   4. Parity — engine output matches legacy inline addTransaction logic
 */

"use strict";

const { buildIntentFromFlat, persistFinancialTransaction, _safeMonthPayload } =
  require("../../services/transactions/transactionPersistence");

const { computeBudgetDelta, applyBudgetDeltaToMonth } =
  require("./_budgetServiceCJS");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UID        = "test-uid-phase4";
const MONTH      = "2026-06";
const ROOT_PATH  = `budget/${UID}`;
const MONTH_PATH = `budget/${UID}/months/${MONTH}`;
const TODAY      = "2026-06-18";

const BASE_CATEGORIES = [
  { name: "Groceries", assigned: 500, spent: 100, balance: 400 },
  { name: "Rent",      assigned: 800, spent: 800, balance: 0   },
];

const BASE_MONTH = {
  currentMonth:     MONTH,
  tbb:              200,
  availableBalance: 1000,
  categories:       BASE_CATEGORIES.map(c => ({ ...c })),
  transactions:     [
    { id: "tx-existing", type: "income", amount: 1000, category: "Income", date: "2026-06-01" },
  ],
  note: "June",
};

const BASE_ROOT = {
  tbb:        200,
  categories: BASE_CATEGORIES.map(c => ({ ...c })),
  accounts:   [],
};

function makeExpenseIntent(overrides = {}) {
  return {
    type:     "expense",
    amount:   50,
    date:     TODAY,
    monthKey: MONTH,
    name:     "Supermarket",
    category: "Groceries",
    source:   "available",
    meta:     {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock DB (same pattern as Phase 2 & 3)
// ---------------------------------------------------------------------------

function makeMockDb(initialDocs = {}) {
  const store = new Map(
    Object.entries(initialDocs).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
  );
  const makeDocRef = (p) => ({
    _path: p,
    get:   async () => {
      const d = store.get(p);
      return { exists: d !== undefined, data: () => d ? JSON.parse(JSON.stringify(d)) : undefined };
    },
    collection: (sub) => makeCollRef(`${p}/${sub}`),
  });
  const makeCollRef = (p) => ({ doc: (id) => makeDocRef(`${p}/${id}`) });

  return {
    collection: (n) => makeCollRef(n),
    runTransaction: jest.fn(async (fn) => fn({
      get: async (ref) => {
        const d = store.get(ref._path);
        return { exists: d !== undefined, data: () => d ? JSON.parse(JSON.stringify(d)) : undefined };
      },
      set: (ref, data) => { store.set(ref._path, JSON.parse(JSON.stringify(data))); },
    })),
    _getDoc: (p) => store.get(p),
    _store:  () => store,
  };
}

function makeEngine() {
  const processFinancialTransaction = jest.fn((intent, ctx) => {
    const existingData = ctx.existingMonthData;
    const monthDoc = existingData
      ? JSON.parse(JSON.stringify(existingData))
      : { currentMonth: intent.month, tbb: ctx.rootTbb || 0, categories: JSON.parse(JSON.stringify(ctx.rootCategories || [])), transactions: [] };

    const delta   = computeBudgetDelta(intent);
    const updated = applyBudgetDeltaToMonth(monthDoc, delta);

    const amount = intent.amountCents / 100;
    const txRecord = {
      id:      `txn-${Date.now()}-test`,
      name:    intent.payee,
      amount,
      category: intent.categoryName,
      type:    "expense",
      date:    intent.date,
      source:  "engine",
      inflow:  0,
      outflow: amount,
    };

    return {
      monthDoc: {
        ...updated,
        transactions: [...(updated.transactions || []), txRecord],
      },
      accounts:          ctx.accounts,
      transactionRecord: txRecord,
      tbbIsNegative:     updated.tbb < 0,
      wasNewMonth:       !existingData,
    };
  });
  return { processFinancialTransaction, buildIntentFromFlat };
}

// ===========================================================================
// 1. buildIntentFromFlat — expense branch
// ===========================================================================

describe("buildIntentFromFlat — expense", () => {
  test("maps flat expense to engine intent shape", () => {
    const intent = buildIntentFromFlat(makeExpenseIntent());
    expect(intent.type).toBe("expense");
    expect(intent.payee).toBe("Supermarket");
    expect(intent.categoryName).toBe("Groceries");
    expect(intent.amountCents).toBe(5000);
    expect(intent.source).toBe("available");
    expect(intent.month).toBe(MONTH);
    expect(intent.date).toBe(TODAY);
    expect(intent.accountName).toBeNull();
  });

  test("amountCents is integer (no float drift)", () => {
    const intent = buildIntentFromFlat(makeExpenseIntent({ amount: 19.99 }));
    expect(Number.isInteger(intent.amountCents)).toBe(true);
    expect(intent.amountCents).toBe(1999);
  });

  test("defaults source to 'available' when not provided", () => {
    const flat = makeExpenseIntent();
    delete flat.source;
    const intent = buildIntentFromFlat(flat);
    expect(intent.source).toBe("available");
  });

  test("accepts categoryName field as fallback for category", () => {
    const flat = { ...makeExpenseIntent(), category: undefined, categoryName: "Rent" };
    const intent = buildIntentFromFlat(flat);
    expect(intent.categoryName).toBe("Rent");
  });

  test("trims whitespace from payee", () => {
    const intent = buildIntentFromFlat(makeExpenseIntent({ name: "  Coffee  " }));
    expect(intent.payee).toBe("Coffee");
  });
});

// ===========================================================================
// 2. computeBudgetDelta — expense (available balance)
// ===========================================================================

describe("computeBudgetDelta — expense from available balance", () => {
  const intent = {
    type:         "expense",
    amountCents:  5000,
    categoryName: "Groceries",
    source:       "available",
  };

  test("tbbDeltaCents is ZERO (TBB unchanged for expenses)", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.tbbDeltaCents).toBe(0);
  });

  test("categorySpentDelta equals amountCents", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.categorySpentDelta).toBe(5000);
  });

  test("categoryName is set correctly", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.categoryName).toBe("Groceries");
  });

  test("assignedDelta is zero (expenses don't change assigned)", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.assignedDelta ?? 0).toBe(0);
  });
});

// ===========================================================================
// 3. applyBudgetDeltaToMonth — expense
// ===========================================================================

describe("applyBudgetDeltaToMonth — expense", () => {
  test("increases category.spent by the expense amount", () => {
    const month = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = computeBudgetDelta({
      type: "expense", amountCents: 5000, categoryName: "Groceries", source: "available",
    });
    const result = applyBudgetDeltaToMonth(month, delta);
    const cat = result.categories.find(c => c.name === "Groceries");
    expect(cat.spent).toBeCloseTo(100 + 50, 5);
  });

  test("decreases category.balance by the expense amount", () => {
    const month = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = computeBudgetDelta({
      type: "expense", amountCents: 5000, categoryName: "Groceries", source: "available",
    });
    const result = applyBudgetDeltaToMonth(month, delta);
    const cat = result.categories.find(c => c.name === "Groceries");
    expect(cat.balance).toBeCloseTo(400 - 50, 5);
  });

  test("TBB is UNCHANGED after an expense", () => {
    const month = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = computeBudgetDelta({
      type: "expense", amountCents: 5000, categoryName: "Groceries", source: "available",
    });
    const result = applyBudgetDeltaToMonth(month, delta);
    expect(result.tbb).toBe(BASE_MONTH.tbb);
  });

  test("category.assigned is UNCHANGED after an expense", () => {
    const month = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = computeBudgetDelta({
      type: "expense", amountCents: 5000, categoryName: "Groceries", source: "available",
    });
    const result = applyBudgetDeltaToMonth(month, delta);
    const cat = result.categories.find(c => c.name === "Groceries");
    expect(cat.assigned).toBe(500);
  });

  test("other categories are UNCHANGED", () => {
    const month = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = computeBudgetDelta({
      type: "expense", amountCents: 5000, categoryName: "Groceries", source: "available",
    });
    const result = applyBudgetDeltaToMonth(month, delta);
    const rent = result.categories.find(c => c.name === "Rent");
    expect(rent).toEqual(BASE_CATEGORIES.find(c => c.name === "Rent"));
  });

  test("does not mutate the original monthDoc", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const before = JSON.parse(JSON.stringify(month));
    const delta  = computeBudgetDelta({
      type: "expense", amountCents: 5000, categoryName: "Groceries", source: "available",
    });
    applyBudgetDeltaToMonth(month, delta);
    expect(month).toEqual(before);
  });
});

// ===========================================================================
// 4. persistFinancialTransaction — expense end-to-end
// ===========================================================================

describe("persistFinancialTransaction — expense", () => {
  test("category.spent increases by expense amount", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent({ amount: 75 }), db, UID, eng);
    const saved = db._getDoc(MONTH_PATH);
    const cat   = saved.categories.find(c => c.name === "Groceries");
    expect(cat.spent).toBeCloseTo(100 + 75, 5);
  });

  test("category.balance decreases by expense amount", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent({ amount: 75 }), db, UID, eng);
    const saved = db._getDoc(MONTH_PATH);
    const cat   = saved.categories.find(c => c.name === "Groceries");
    expect(cat.balance).toBeCloseTo(400 - 75, 5);
  });

  test("TBB is UNCHANGED after expense", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent({ amount: 50 }), db, UID, eng);
    const saved = db._getDoc(MONTH_PATH);
    expect(saved.tbb).toBe(BASE_MONTH.tbb);
  });

  test("transaction record is appended with correct shape", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      makeExpenseIntent({ amount: 30, name: "Coffee", date: "2026-06-18" }),
      db, UID, eng
    );
    const saved = db._getDoc(MONTH_PATH);
    const tx    = saved.transactions[saved.transactions.length - 1];
    expect(tx.type).toBe("expense");
    expect(tx.amount).toBe(30);
    expect(tx.name).toBe("Coffee");
    expect(tx.category).toBe("Groceries");
    expect(tx.date).toBe("2026-06-18");
    expect(tx.source).toBe("engine");
    expect(tx.outflow).toBe(30);
    expect(tx.inflow).toBe(0);
    expect(typeof tx.id).toBe("string");
    expect(tx.id.length).toBeGreaterThan(0);
  });

  test("transaction count increases by exactly 1", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    const before = BASE_MONTH.transactions.length;
    await persistFinancialTransaction(makeExpenseIntent(), db, UID, eng);
    const saved = db._getDoc(MONTH_PATH);
    expect(saved.transactions.length).toBe(before + 1);
  });

  test("availableBalance is computed and written by engine (Phase 8)", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent(), db, UID, eng);
    const saved = db._getDoc(MONTH_PATH);
    expect(typeof saved.availableBalance).toBe("number");
  });

  test("accounts[] in root doc is UNCHANGED", async () => {
    const rootWithAccounts = { ...BASE_ROOT, accounts: [{ name: "Checking", balance: 5000 }] };
    const db  = makeMockDb({ [ROOT_PATH]: rootWithAccounts, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent(), db, UID, eng);
    expect(db._getDoc(ROOT_PATH).accounts).toEqual(rootWithAccounts.accounts);
  });

  test("note and other existing fields are preserved", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent(), db, UID, eng);
    expect(db._getDoc(MONTH_PATH).note).toBe("June");
  });

  test("uses db.runTransaction for atomicity", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent(), db, UID, eng);
    expect(db.runTransaction).toHaveBeenCalledTimes(1);
  });

  test("works when month doc does not yet exist", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT }); // no month doc
    const eng = makeEngine();
    await persistFinancialTransaction(makeExpenseIntent({ amount: 50 }), db, UID, eng);
    const saved = db._getDoc(MONTH_PATH);
    expect(saved).toBeDefined();
    expect(saved.transactions.length).toBe(1);
    expect(saved.transactions[0].type).toBe("expense");
  });

  test("engine called with correct intent fields", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      makeExpenseIntent({ amount: 99, name: "Dinner", category: "Groceries" }),
      db, UID, eng
    );
    const [calledIntent] = eng.processFinancialTransaction.mock.calls[0];
    expect(calledIntent.type).toBe("expense");
    expect(calledIntent.amountCents).toBe(9900);
    expect(calledIntent.payee).toBe("Dinner");
    expect(calledIntent.categoryName).toBe("Groceries");
    expect(calledIntent.source).toBe("available");
    expect(calledIntent.month).toBe(MONTH);
  });
});

// ===========================================================================
// 5. Parity — engine path matches legacy inline addTransaction logic
// ===========================================================================

describe("Parity: engine expense === legacy addTransaction inline logic", () => {
  function legacyAddTransaction(monthData, name, amount, category, date) {
    const cloned = JSON.parse(JSON.stringify(monthData));

    // Mirror of the original inline logic exactly
    const catIndex = cloned.categories.findIndex(c => c.name === category);
    if (catIndex !== -1) {
      cloned.categories[catIndex].spent  += amount;
      cloned.categories[catIndex].balance =
        cloned.categories[catIndex].assigned - cloned.categories[catIndex].spent;
    }

    const transactionId = Date.now().toString();
    cloned.transactions.push({
      id:       transactionId,
      name,
      amount,
      category,
      type:     "expense",
      date,
      source:   "dashboard",
    });

    return cloned;
  }

  test.each([
    ["small amount",   20,     "Groceries", "2026-06-01"],
    ["large amount",   499.99, "Groceries", "2026-06-15"],
    ["decimal amount", 12.34,  "Groceries", "2026-06-30"],
    ["exact balance",  400,    "Groceries", "2026-06-10"],
  ])("%s — category spent/balance and tbb match legacy", async (_, amount, category, date) => {
    const freshMonth = JSON.parse(JSON.stringify(BASE_MONTH));
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: freshMonth });
    const eng = makeEngine();

    await persistFinancialTransaction(
      makeExpenseIntent({ amount, category, date, name: "Test" }),
      db, UID, eng
    );

    const engineResult = db._getDoc(MONTH_PATH);
    const legacyResult = legacyAddTransaction(freshMonth, "Test", amount, category, date);

    // TBB must match (both unchanged)
    expect(engineResult.tbb).toBeCloseTo(legacyResult.tbb, 5);

    // Category must match
    const engCat    = engineResult.categories.find(c => c.name === category);
    const legacyCat = legacyResult.categories.find(c => c.name === category);
    expect(engCat.spent).toBeCloseTo(legacyCat.spent, 5);
    expect(engCat.balance).toBeCloseTo(legacyCat.balance, 5);
    expect(engCat.assigned).toBeCloseTo(legacyCat.assigned, 5);

    // Transaction count matches
    expect(engineResult.transactions.length).toBe(legacyResult.transactions.length);
  });

  test("category not found: no crash, tbb still unchanged", async () => {
    const freshMonth = JSON.parse(JSON.stringify(BASE_MONTH));
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: freshMonth });
    const eng = makeEngine();

    // "NonExistent" category doesn't exist — legacy silently skips the update
    await persistFinancialTransaction(
      makeExpenseIntent({ category: "NonExistent", amount: 50 }),
      db, UID, eng
    );

    const saved = db._getDoc(MONTH_PATH);
    // TBB unchanged (expense never touches TBB)
    expect(saved.tbb).toBe(BASE_MONTH.tbb);
    // Transaction still recorded
    expect(saved.transactions.length).toBe(BASE_MONTH.transactions.length + 1);
  });

  test("tbb parity across 5 sequential expenses", async () => {
    const amounts   = [50, 25.99, 100, 7.5, 200];
    let currentMonth = JSON.parse(JSON.stringify(BASE_MONTH));
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: currentMonth });
    const eng = makeEngine();

    let expectedSpent = BASE_CATEGORIES.find(c => c.name === "Groceries").spent;

    for (const amount of amounts) {
      expectedSpent += amount;
      await persistFinancialTransaction(
        makeExpenseIntent({ amount }),
        db, UID, eng
      );
      currentMonth = db._getDoc(MONTH_PATH);
      db._store().set(MONTH_PATH, JSON.parse(JSON.stringify(currentMonth)));
    }

    const final    = db._getDoc(MONTH_PATH);
    const finalCat = final.categories.find(c => c.name === "Groceries");

    // TBB never changes for expenses
    expect(final.tbb).toBe(BASE_MONTH.tbb);
    // Spent accumulates correctly
    expect(finalCat.spent).toBeCloseTo(expectedSpent, 4);
    // Balance = assigned - spent
    expect(finalCat.balance).toBeCloseTo(500 - expectedSpent, 4);
    // 5 new transactions added
    expect(final.transactions.length).toBe(BASE_MONTH.transactions.length + 5);
  });
});
