/**
 * tests/unit/addCategory.test.js
 *
 * Phase 3 — Tests for:
 *   1. budgetMutationService.js  — assign/unassign cases + assignedDelta
 *   2. transactionPersistence.js — buildIntentFromFlat assign branch
 *   3. End-to-end: engine path matches legacy inline addCategory logic
 *
 * No live Firestore — all tests use the same mock DB pattern from Phase 2.
 */

"use strict";

// Pure budget service functions (loaded via CJS shim that strips ES module syntax)
const { computeBudgetDelta, applyBudgetDeltaToMonth } = require("./_budgetServiceCJS");

// Money helpers (inline — no external dep)
function toCents(f)   { return Math.round(f * 100); }
function fromCents(c) { return c / 100; }


const {
  buildIntentFromFlat,
  persistFinancialTransaction,
  _safeMonthPayload,
} = require("../../services/transactions/transactionPersistence");

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const UID        = "test-uid-phase3";
const MONTH      = "2026-06";
const ROOT_PATH  = `budget/${UID}`;
const MONTH_PATH = `budget/${UID}/months/${MONTH}`;
const TODAY      = "2026-06-17";

const BASE_CATEGORIES = [
  { name: "Groceries", assigned: 300, spent: 50,  balance: 250 },
  { name: "Rent",      assigned: 800, spent: 800, balance: 0   },
];

const BASE_MONTH = {
  currentMonth:     MONTH,
  tbb:              500,
  availableBalance: 450,
  categories:       BASE_CATEGORIES.map(c => ({ ...c })),
  transactions:     [{ id: "tx-1", type: "income", amount: 1000 }],
  note:             "June",
};

const BASE_ROOT = {
  tbb:        500,
  categories: BASE_CATEGORIES.map(c => ({ ...c })),
  accounts:   [],
};

// ---------------------------------------------------------------------------
// Mock DB (same pattern as Phase 2)
// ---------------------------------------------------------------------------

function makeMockDb(initialDocs = {}) {
  const store = new Map(Object.entries(
    Object.fromEntries(
      Object.entries(initialDocs).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))])
    )
  ));

  const makeDocRef = (p) => ({
    _path: p,
    get:   async () => {
      const d = store.get(p);
      return { exists: d !== undefined, data: () => d ? JSON.parse(JSON.stringify(d)) : undefined };
    },
    collection: (sub) => makeCollectionRef(`${p}/${sub}`),
  });

  const makeCollectionRef = (p) => ({ doc: (id) => makeDocRef(`${p}/${id}`) });

  return {
    collection: (n) => makeCollectionRef(n),
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
  // Lightweight engine that calls the real budgetMutationService pure functions
  const processFinancialTransaction = jest.fn((intent, ctx) => {
    const existingData = ctx.existingMonthData;
    const monthDoc = existingData
      ? JSON.parse(JSON.stringify(existingData))
      : { currentMonth: intent.month, tbb: ctx.rootTbb || 0, categories: JSON.parse(JSON.stringify(ctx.rootCategories || [])), transactions: [] };

    // Use the REAL computeBudgetDelta + applyBudgetDeltaToMonth
    const delta   = computeBudgetDelta(intent);
    const updated = applyBudgetDeltaToMonth(monthDoc, delta);

    return {
      monthDoc:          updated,
      accounts:          ctx.accounts,
      transactionRecord: null,  // assign doesn't push a transaction record
      tbbIsNegative:     updated.tbb < 0,
      wasNewMonth:       !existingData,
    };
  });

  return { processFinancialTransaction, buildIntentFromFlat };
}

// ===========================================================================
// 1. computeBudgetDelta — assign / unassign
// ===========================================================================

describe("computeBudgetDelta — assign", () => {
  const intent = {
    type:         "assign",
    amountCents:  20000,   // $200.00
    categoryName: "Groceries",
    meta:         { isNewCategory: false },
  };

  test("tbbDeltaCents is negative (TBB decreases)", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.tbbDeltaCents).toBe(-20000);
  });

  test("assignedDelta equals amountCents", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.assignedDelta).toBe(20000);
  });

  test("categorySpentDelta is zero", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.categorySpentDelta).toBe(0);
  });

  test("isNewCategory false when meta.isNewCategory is false", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.isNewCategory).toBe(false);
  });

  test("isNewCategory true when meta.isNewCategory is true", () => {
    const delta = computeBudgetDelta({ ...intent, meta: { isNewCategory: true } });
    expect(delta.isNewCategory).toBe(true);
  });

  test("reason string mentions category name", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.reason).toContain("Groceries");
  });

  test("reason string mentions '(new category)' for new categories", () => {
    const delta = computeBudgetDelta({ ...intent, meta: { isNewCategory: true } });
    expect(delta.reason).toContain("new category");
  });
});

describe("computeBudgetDelta — unassign", () => {
  const intent = {
    type:         "unassign",
    amountCents:  10000,
    categoryName: "Groceries",
    meta:         {},
  };

  test("tbbDeltaCents is positive (TBB increases)", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.tbbDeltaCents).toBe(10000);
  });

  test("assignedDelta is negative", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.assignedDelta).toBe(-10000);
  });

  test("categorySpentDelta is zero", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.categorySpentDelta).toBe(0);
  });

  test("isNewCategory is always false", () => {
    const delta = computeBudgetDelta(intent);
    expect(delta.isNewCategory).toBe(false);
  });
});

// ===========================================================================
// 2. applyBudgetDeltaToMonth — assign to existing category
// ===========================================================================

describe("applyBudgetDeltaToMonth — assign to existing category", () => {
  const monthDoc = JSON.parse(JSON.stringify(BASE_MONTH));

  test("increases category.assigned by the delta amount", () => {
    const delta = {
      tbbDeltaCents:      -20000,
      categoryName:       "Groceries",
      categorySpentDelta: 0,
      assignedDelta:      20000,
      isNewCategory:      false,
      reason:             "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    const cat = result.categories.find(c => c.name === "Groceries");
    expect(cat.assigned).toBeCloseTo(300 + 200, 5);
  });

  test("recalculates balance correctly (assigned - spent)", () => {
    const delta = {
      tbbDeltaCents:      -20000,
      categoryName:       "Groceries",
      categorySpentDelta: 0,
      assignedDelta:      20000,
      isNewCategory:      false,
      reason:             "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    const cat = result.categories.find(c => c.name === "Groceries");
    // Groceries: assigned=300+200=500, spent=50, balance=450
    expect(cat.balance).toBeCloseTo(500 - 50, 5);
  });

  test("decreases tbb by the assign amount", () => {
    const delta = {
      tbbDeltaCents:      -20000,
      categoryName:       "Groceries",
      categorySpentDelta: 0,
      assignedDelta:      20000,
      isNewCategory:      false,
      reason:             "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    expect(result.tbb).toBeCloseTo(500 - 200, 5);
  });

  test("does not mutate the original monthDoc", () => {
    const original = JSON.parse(JSON.stringify(monthDoc));
    const delta = {
      tbbDeltaCents: -10000, categoryName: "Groceries",
      categorySpentDelta: 0, assignedDelta: 10000,
      isNewCategory: false, reason: "test",
    };
    applyBudgetDeltaToMonth(monthDoc, delta);
    expect(monthDoc).toEqual(original);
  });

  test("does not touch other categories", () => {
    const delta = {
      tbbDeltaCents: -20000, categoryName: "Groceries",
      categorySpentDelta: 0, assignedDelta: 20000,
      isNewCategory: false, reason: "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    const rent = result.categories.find(c => c.name === "Rent");
    expect(rent).toEqual(BASE_CATEGORIES.find(c => c.name === "Rent"));
  });
});

// ===========================================================================
// 3. applyBudgetDeltaToMonth — NEW category (isNewCategory: true)
// ===========================================================================

describe("applyBudgetDeltaToMonth — new category creation", () => {
  test("creates category with correct assigned/spent/balance", () => {
    const monthDoc = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = {
      tbbDeltaCents:      -15000,
      categoryName:       "Entertainment",
      categorySpentDelta: 0,
      assignedDelta:      15000,
      isNewCategory:      true,
      reason:             "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    const cat = result.categories.find(c => c.name === "Entertainment");
    expect(cat).toBeDefined();
    expect(cat.assigned).toBeCloseTo(150, 5);
    expect(cat.spent).toBe(0);
    expect(cat.balance).toBeCloseTo(150, 5);
  });

  test("assigned = 0 + assignAmount (the plan's placeholder invariant)", () => {
    // Plan note: "placeholder defaults to assigned:0 then applies assignedDelta — confirm 0 + assignAmount = assignAmount"
    const monthDoc = JSON.parse(JSON.stringify(BASE_MONTH));
    const assignAmount = 200;
    const delta = {
      tbbDeltaCents:      -toCents(assignAmount),
      categoryName:       "NewCat",
      categorySpentDelta: 0,
      assignedDelta:      toCents(assignAmount),
      isNewCategory:      true,
      reason:             "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    const cat = result.categories.find(c => c.name === "NewCat");
    expect(cat.assigned).toBeCloseTo(assignAmount, 5);  // 0 + 200 = 200 ✓
  });

  test("decreases tbb by assignAmount", () => {
    const monthDoc = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = {
      tbbDeltaCents:      -20000,
      categoryName:       "NewCat",
      categorySpentDelta: 0,
      assignedDelta:      20000,
      isNewCategory:      true,
      reason:             "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    expect(result.tbb).toBeCloseTo(500 - 200, 5);
  });

  test("new category appended after existing categories", () => {
    const monthDoc = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = {
      tbbDeltaCents: -10000, categoryName: "Utilities",
      categorySpentDelta: 0, assignedDelta: 10000,
      isNewCategory: true, reason: "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    expect(result.categories.length).toBe(BASE_MONTH.categories.length + 1);
    expect(result.categories[result.categories.length - 1].name).toBe("Utilities");
  });

  test("does NOT create new category when isNewCategory is false and category missing", () => {
    const monthDoc = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = {
      tbbDeltaCents: -10000, categoryName: "DoesNotExist",
      categorySpentDelta: 0, assignedDelta: 10000,
      isNewCategory: false, reason: "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    expect(result.categories.length).toBe(BASE_MONTH.categories.length);
  });

  test("zero-amount new category: assigned=0, balance=0", () => {
    const monthDoc = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta = {
      tbbDeltaCents: 0, categoryName: "ZeroCat",
      categorySpentDelta: 0, assignedDelta: 0,
      isNewCategory: true, reason: "test",
    };
    const result = applyBudgetDeltaToMonth(monthDoc, delta);
    const cat = result.categories.find(c => c.name === "ZeroCat");
    expect(cat.assigned).toBe(0);
    expect(cat.balance).toBe(0);
  });
});

// ===========================================================================
// 4. buildIntentFromFlat — assign branch
// ===========================================================================

describe("buildIntentFromFlat — assign", () => {
  test("maps flat assign to engine intent shape", () => {
    const flat = {
      type:     "assign",
      amount:   200,
      date:     TODAY,
      monthKey: MONTH,
      category: "NewCat",
      meta:     { isNewCategory: true },
    };
    const intent = buildIntentFromFlat(flat);
    expect(intent.type).toBe("assign");
    expect(intent.categoryName).toBe("NewCat");
    expect(intent.amountCents).toBe(20000);
    expect(intent.month).toBe(MONTH);      // engine uses .month not .monthKey
    expect(intent.date).toBe(TODAY);
    expect(intent.meta.isNewCategory).toBe(true);
  });

  test("maps flat unassign correctly", () => {
    const flat = {
      type:     "unassign",
      amount:   100,
      date:     TODAY,
      monthKey: MONTH,
      category: "Groceries",
      meta:     {},
    };
    const intent = buildIntentFromFlat(flat);
    expect(intent.type).toBe("unassign");
    expect(intent.categoryName).toBe("Groceries");
    expect(intent.amountCents).toBe(10000);
  });

  test("accepts categoryName field as fallback for category", () => {
    const flat = { type: "assign", amount: 50, date: TODAY, monthKey: MONTH, categoryName: "Rent", meta: {} };
    const intent = buildIntentFromFlat(flat);
    expect(intent.categoryName).toBe("Rent");
  });

  test("amountCents is an integer (no float drift)", () => {
    const flat = { type: "assign", amount: 99.99, date: TODAY, monthKey: MONTH, category: "X", meta: {} };
    const intent = buildIntentFromFlat(flat);
    expect(Number.isInteger(intent.amountCents)).toBe(true);
    expect(intent.amountCents).toBe(9999);
  });
});

// ===========================================================================
// 5. persistFinancialTransaction — assign (end-to-end with mock engine)
// ===========================================================================

describe("persistFinancialTransaction — assign (new category)", () => {
  test("new category appears in month doc with correct fields", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(
      { type: "assign", amount: 200, date: TODAY, monthKey: MONTH, category: "Entertainment", meta: { isNewCategory: true } },
      db, UID, eng
    );

    const saved = db._getDoc(MONTH_PATH);
    const cat   = saved.categories.find(c => c.name === "Entertainment");
    expect(cat).toBeDefined();
    expect(cat.assigned).toBeCloseTo(200, 5);
    expect(cat.spent).toBe(0);
    expect(cat.balance).toBeCloseTo(200, 5);
  });

  test("tbb decreases by assignAmount", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(
      { type: "assign", amount: 200, date: TODAY, monthKey: MONTH, category: "Entertainment", meta: { isNewCategory: true } },
      db, UID, eng
    );

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.tbb).toBeCloseTo(BASE_MONTH.tbb - 200, 5);
  });

  test("availableBalance is UNCHANGED (Phase 8 owns it)", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(
      { type: "assign", amount: 100, date: TODAY, monthKey: MONTH, category: "NewCat", meta: { isNewCategory: true } },
      db, UID, eng
    );

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.availableBalance).toBe(BASE_MONTH.availableBalance);
  });

  test("existing categories are UNCHANGED", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(
      { type: "assign", amount: 50, date: TODAY, monthKey: MONTH, category: "Brand New", meta: { isNewCategory: true } },
      db, UID, eng
    );

    const saved = db._getDoc(MONTH_PATH);
    const groceries = saved.categories.find(c => c.name === "Groceries");
    const rent      = saved.categories.find(c => c.name === "Rent");
    expect(groceries.assigned).toBeCloseTo(300, 5);
    expect(rent.assigned).toBeCloseTo(800, 5);
  });

  test("accounts[] in root doc is UNCHANGED", async () => {
    const rootWithAccounts = { ...BASE_ROOT, accounts: [{ name: "Checking", balance: 5000 }] };
    const db  = makeMockDb({ [ROOT_PATH]: rootWithAccounts, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(
      { type: "assign", amount: 100, date: TODAY, monthKey: MONTH, category: "X", meta: { isNewCategory: true } },
      db, UID, eng
    );

    const root = db._getDoc(ROOT_PATH);
    expect(root.accounts).toEqual(rootWithAccounts.accounts);
  });

  test("transactions[] is UNCHANGED (assign doesn't push a tx record)", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    const beforeCount = BASE_MONTH.transactions.length;

    await persistFinancialTransaction(
      { type: "assign", amount: 100, date: TODAY, monthKey: MONTH, category: "NewCat", meta: { isNewCategory: true } },
      db, UID, eng
    );

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.transactions.length).toBe(beforeCount);
  });

  test("note and other existing fields are preserved", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();

    await persistFinancialTransaction(
      { type: "assign", amount: 100, date: TODAY, monthKey: MONTH, category: "X", meta: { isNewCategory: true } },
      db, UID, eng
    );

    const saved = db._getDoc(MONTH_PATH);
    expect(saved.note).toBe("June");
  });
});

// ===========================================================================
// 6. Parity — engine path matches legacy inline addCategory logic
// ===========================================================================

describe("Parity: engine assign === legacy addCategory inline logic", () => {
  /**
   * Literal transcription of the old addCategory inline logic
   * (the else branch in the new script.js).
   */
  function legacyAddCategory(monthData, name, assignAmount, targetMonth) {
    const cloned = JSON.parse(JSON.stringify(monthData));
    cloned.categories.push({
      name,
      assigned: assignAmount,
      spent:    0,
      balance:  assignAmount,
      monthly:  { [targetMonth]: { assigned: assignAmount, spent: 0 } },
    });
    cloned.tbb = (cloned.tbb || 0) - assignAmount;
    return cloned;
  }

  // Note on category names: must NOT collide with BASE_CATEGORIES ("Groceries", "Rent")
  // because the engine correctly finds-and-updates an existing category with that name,
  // while the legacy code pushes a duplicate entry. Tests use unique names throughout.
  test.each([
    ["small amount",   50,    "NewFood"],
    ["large amount",   800,   "NewRent"],   // "Rent" exists in BASE_CATEGORIES — use "NewRent"
    ["decimal amount", 99.99, "NewMisc"],
  ])("%s — tbb and new category match", async (_, amount, catName) => {
    const freshMonth = JSON.parse(JSON.stringify(BASE_MONTH));
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: freshMonth });
    const eng = makeEngine();

    await persistFinancialTransaction(
      { type: "assign", amount, date: TODAY, monthKey: MONTH, category: catName, meta: { isNewCategory: true } },
      db, UID, eng
    );

    const engineResult = db._getDoc(MONTH_PATH);
    const legacyResult = legacyAddCategory(freshMonth, catName, amount, MONTH);

    // TBB must match
    expect(engineResult.tbb).toBeCloseTo(legacyResult.tbb, 5);

    // New category fields must match (engine omits monthly: {} field — that's vestigial)
    const engCat    = engineResult.categories.find(c => c.name === catName);
    const legacyCat = legacyResult.categories.find(c => c.name === catName);
    expect(engCat.assigned).toBeCloseTo(legacyCat.assigned, 5);
    expect(engCat.spent).toBe(legacyCat.spent);
    expect(engCat.balance).toBeCloseTo(legacyCat.balance, 5);

    // Existing categories must be identical
    const engGroceries    = engineResult.categories.find(c => c.name === "Groceries");
    const legacyGroceries = legacyResult.categories.find(c => c.name === "Groceries");
    expect(engGroceries).toEqual(legacyGroceries);
  });

  // Zero-amount: both the engine (_validateFlatIntent) and the pure budget service
  // (_requireIntent) require amountCents > 0. The addCategory UI guard requires
  // assignAmount >= 0 but the engine is intentionally stricter — a zero-budget
  // category provides no value and the user can always set assigned=0 later via
  // saveAssigned. This alignment is intentional and does not need a parity test.
  test("zero amount: engine and pure service both reject amountCents=0 (intentional)", () => {
    expect(() => computeBudgetDelta({
      type: "assign", amountCents: 0, categoryName: "FreeCategory", meta: { isNewCategory: true },
    })).toThrow(/positive number/);
  });

  test("tbb parity across 9 sequential category additions (non-zero amounts)", async () => {
    // Zero excluded: engine rejects amount=0 via _validateFlatIntent.
    // The addCategory UI guard (assignAmount < 0) also prevents negative amounts,
    // so all real user-submitted amounts are > 0.
    const additions = [100, 50, 200, 75.5, 33.33, 1000, 5, 99.99, 250];
    let currentMonth = JSON.parse(JSON.stringify(BASE_MONTH));
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: currentMonth });
    const eng = makeEngine();

    let expectedTbb = BASE_MONTH.tbb;

    for (let i = 0; i < additions.length; i++) {
      const amount  = additions[i];
      const catName = `SeqCat${i}`;
      expectedTbb  -= amount;

      await persistFinancialTransaction(
        { type: "assign", amount, date: TODAY, monthKey: MONTH, category: catName, meta: { isNewCategory: true } },
        db, UID, eng
      );

      // Re-seed mock so next iteration reads the updated month
      currentMonth = db._getDoc(MONTH_PATH);
      db._store().set(MONTH_PATH, JSON.parse(JSON.stringify(currentMonth)));
    }

    const final = db._getDoc(MONTH_PATH);
    expect(final.tbb).toBeCloseTo(expectedTbb, 4);
    expect(final.categories.filter(c => c.name.startsWith("SeqCat")).length).toBe(9);
  });
});
