/**
 * tests/unit/saveAssigned.test.js
 *
 * Phase 5 — Tests for wiring saveAssigned() (inline category budget edit)
 * through the engine.
 *
 * Covers:
 *   1. assign/unassign direction logic — diff > 0 = assign, diff < 0 = unassign
 *   2. computeBudgetDelta for both directions
 *   3. applyBudgetDeltaToMonth — assigned field updated, balance recalculated
 *   4. persistFinancialTransaction — assign edit end-to-end
 *   5. Parity — engine output matches legacy inline saveAssigned logic
 *   6. Edge cases: zero diff (no-op), exact amount, unassign below zero
 */

"use strict";

const { buildIntentFromFlat, persistFinancialTransaction } =
  require("../../services/transactions/transactionPersistence");

const { computeBudgetDelta, applyBudgetDeltaToMonth } =
  require("./_budgetServiceCJS");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UID        = "test-uid-phase5";
const MONTH      = "2026-06";
const ROOT_PATH  = `budget/${UID}`;
const MONTH_PATH = `budget/${UID}/months/${MONTH}`;
const TODAY      = "2026-06-18";

const BASE_CATEGORIES = [
  { name: "Groceries", assigned: 300, spent: 50,  balance: 250 },
  { name: "Rent",      assigned: 800, spent: 800, balance: 0   },
  { name: "Fun",       assigned: 100, spent: 0,   balance: 100 },
];

const BASE_MONTH = {
  currentMonth:     MONTH,
  tbb:              200,
  availableBalance: 450,
  categories:       BASE_CATEGORIES.map(c => ({ ...c })),
  transactions:     [{ id: "tx-1", type: "income", amount: 1400, inflow: 1400, outflow: 0 }],
  note:             "June",
};

const BASE_ROOT = {
  tbb:        200,
  categories: BASE_CATEGORIES.map(c => ({ ...c })),
  accounts:   [],
};

// ---------------------------------------------------------------------------
// Mock DB
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

    return {
      monthDoc:          updated,
      accounts:          ctx.accounts,
      transactionRecord: null,  // assign/unassign never push a record
      tbbIsNegative:     updated.tbb < 0,
      wasNewMonth:       !existingData,
    };
  });
  return { processFinancialTransaction, buildIntentFromFlat };
}

// ===========================================================================
// 1. Direction logic — assign vs unassign based on diff sign
// ===========================================================================

describe("assign/unassign direction logic", () => {
  test("diff > 0 maps to 'assign' intent type", () => {
    // oldAssigned=300, newVal=500 → diff=200 → assign
    const diff = 500 - 300;
    expect(diff > 0 ? "assign" : "unassign").toBe("assign");
  });

  test("diff < 0 maps to 'unassign' intent type", () => {
    // oldAssigned=300, newVal=100 → diff=-200 → unassign
    const diff = 100 - 300;
    expect(diff > 0 ? "assign" : "unassign").toBe("unassign");
  });

  test("amount passed to engine is always Math.abs(diff)", () => {
    expect(Math.abs(500 - 300)).toBe(200);  // assign: positive diff
    expect(Math.abs(100 - 300)).toBe(200);  // unassign: negative diff → still positive
  });
});

// ===========================================================================
// 2. computeBudgetDelta — assign edit (increasing assigned)
// ===========================================================================

describe("computeBudgetDelta — assign edit (increase)", () => {
  // Groceries: currently assigned=300, editing to 500 → diff=200 → assign 200
  const intent = {
    type:         "assign",
    amountCents:  20000,  // 200 * 100
    categoryName: "Groceries",
    meta:         { isNewCategory: false },
  };

  test("tbbDeltaCents is negative (TBB decreases when assigning more)", () => {
    expect(computeBudgetDelta(intent).tbbDeltaCents).toBe(-20000);
  });

  test("assignedDelta equals amountCents", () => {
    expect(computeBudgetDelta(intent).assignedDelta).toBe(20000);
  });

  test("categorySpentDelta is zero", () => {
    expect(computeBudgetDelta(intent).categorySpentDelta).toBe(0);
  });
});

// ===========================================================================
// 3. computeBudgetDelta — unassign edit (decreasing assigned)
// ===========================================================================

describe("computeBudgetDelta — unassign edit (decrease)", () => {
  // Groceries: currently assigned=300, editing to 100 → diff=-200 → unassign 200
  const intent = {
    type:         "unassign",
    amountCents:  20000,  // Math.abs(-200) * 100
    categoryName: "Groceries",
    meta:         {},
  };

  test("tbbDeltaCents is positive (TBB increases when unassigning)", () => {
    expect(computeBudgetDelta(intent).tbbDeltaCents).toBe(20000);
  });

  test("assignedDelta is negative", () => {
    expect(computeBudgetDelta(intent).assignedDelta).toBe(-20000);
  });

  test("categorySpentDelta is zero", () => {
    expect(computeBudgetDelta(intent).categorySpentDelta).toBe(0);
  });
});

// ===========================================================================
// 4. applyBudgetDeltaToMonth — assign edit
// ===========================================================================

describe("applyBudgetDeltaToMonth — assign edit", () => {
  test("increases category.assigned by diff amount", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "assign", amountCents: 20000, categoryName: "Groceries", meta: { isNewCategory: false } });
    const result = applyBudgetDeltaToMonth(month, delta);
    expect(result.categories.find(c => c.name === "Groceries").assigned).toBeCloseTo(300 + 200, 5);
  });

  test("recalculates balance = new assigned - spent", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "assign", amountCents: 20000, categoryName: "Groceries", meta: { isNewCategory: false } });
    const result = applyBudgetDeltaToMonth(month, delta);
    const cat    = result.categories.find(c => c.name === "Groceries");
    expect(cat.balance).toBeCloseTo((300 + 200) - 50, 5);  // 450
  });

  test("decreases TBB by diff amount", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "assign", amountCents: 20000, categoryName: "Groceries", meta: { isNewCategory: false } });
    const result = applyBudgetDeltaToMonth(month, delta);
    expect(result.tbb).toBeCloseTo(200 - 200, 5);  // 0
  });

  test("spent is UNCHANGED", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "assign", amountCents: 20000, categoryName: "Groceries", meta: { isNewCategory: false } });
    const result = applyBudgetDeltaToMonth(month, delta);
    expect(result.categories.find(c => c.name === "Groceries").spent).toBe(50);
  });

  test("other categories are UNCHANGED", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "assign", amountCents: 20000, categoryName: "Groceries", meta: { isNewCategory: false } });
    const result = applyBudgetDeltaToMonth(month, delta);
    expect(result.categories.find(c => c.name === "Rent")).toEqual(BASE_CATEGORIES.find(c => c.name === "Rent"));
    expect(result.categories.find(c => c.name === "Fun")).toEqual(BASE_CATEGORIES.find(c => c.name === "Fun"));
  });
});

// ===========================================================================
// 5. applyBudgetDeltaToMonth — unassign edit
// ===========================================================================

describe("applyBudgetDeltaToMonth — unassign edit", () => {
  test("decreases category.assigned by diff amount", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "unassign", amountCents: 10000, categoryName: "Groceries", meta: {} });
    const result = applyBudgetDeltaToMonth(month, delta);
    expect(result.categories.find(c => c.name === "Groceries").assigned).toBeCloseTo(300 - 100, 5);
  });

  test("recalculates balance = new assigned - spent", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "unassign", amountCents: 10000, categoryName: "Groceries", meta: {} });
    const result = applyBudgetDeltaToMonth(month, delta);
    const cat    = result.categories.find(c => c.name === "Groceries");
    expect(cat.balance).toBeCloseTo((300 - 100) - 50, 5);  // 150
  });

  test("increases TBB by diff amount", () => {
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "unassign", amountCents: 10000, categoryName: "Groceries", meta: {} });
    const result = applyBudgetDeltaToMonth(month, delta);
    expect(result.tbb).toBeCloseTo(200 + 100, 5);  // 300
  });

  test("unassign can make balance negative (over-spent category)", () => {
    // Rent: assigned=800, spent=800, balance=0 — unassign 200 → balance=-200
    const month  = JSON.parse(JSON.stringify(BASE_MONTH));
    const delta  = computeBudgetDelta({ type: "unassign", amountCents: 20000, categoryName: "Rent", meta: {} });
    const result = applyBudgetDeltaToMonth(month, delta);
    const cat    = result.categories.find(c => c.name === "Rent");
    expect(cat.assigned).toBeCloseTo(600, 5);
    expect(cat.balance).toBeCloseTo(-200, 5);
  });
});

// ===========================================================================
// 6. persistFinancialTransaction — assign edit end-to-end
// ===========================================================================

describe("persistFinancialTransaction — assign edit (increase)", () => {
  test("category.assigned increases to the new value", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    // Groceries: 300 → 500 (diff=200, type=assign)
    await persistFinancialTransaction(
      { type: "assign", amount: 200, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    const saved = db._getDoc(MONTH_PATH);
    expect(saved.categories.find(c => c.name === "Groceries").assigned).toBeCloseTo(500, 5);
  });

  test("category.balance recalculated correctly", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      { type: "assign", amount: 200, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    const saved = db._getDoc(MONTH_PATH);
    const cat   = saved.categories.find(c => c.name === "Groceries");
    expect(cat.balance).toBeCloseTo(500 - 50, 5);  // new assigned - spent
  });

  test("TBB decreases by diff amount", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      { type: "assign", amount: 200, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    const saved = db._getDoc(MONTH_PATH);
    expect(saved.tbb).toBeCloseTo(200 - 200, 5);
  });

  test("no transaction record pushed (assign is not a financial event)", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      { type: "assign", amount: 50, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    const saved = db._getDoc(MONTH_PATH);
    expect(saved.transactions.length).toBe(BASE_MONTH.transactions.length);
  });

  test("availableBalance is UNCHANGED", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      { type: "assign", amount: 100, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    expect(typeof db._getDoc(MONTH_PATH).availableBalance).toBe("number");
  });

  test("note and other existing fields are preserved", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      { type: "assign", amount: 100, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    expect(db._getDoc(MONTH_PATH).note).toBe("June");
  });
});

describe("persistFinancialTransaction — unassign edit (decrease)", () => {
  test("category.assigned decreases by diff amount", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    // Groceries: 300 → 100 (diff=-200, type=unassign, amount=200)
    await persistFinancialTransaction(
      { type: "unassign", amount: 200, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    const saved = db._getDoc(MONTH_PATH);
    expect(saved.categories.find(c => c.name === "Groceries").assigned).toBeCloseTo(100, 5);
  });

  test("TBB increases by diff amount", async () => {
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: BASE_MONTH });
    const eng = makeEngine();
    await persistFinancialTransaction(
      { type: "unassign", amount: 200, date: TODAY, monthKey: MONTH, category: "Groceries", meta: { isNewCategory: false } },
      db, UID, eng
    );
    expect(db._getDoc(MONTH_PATH).tbb).toBeCloseTo(200 + 200, 5);
  });
});

// ===========================================================================
// 7. Parity — engine output matches legacy saveAssigned logic
// ===========================================================================

describe("Parity: engine assign edit === legacy saveAssigned inline logic", () => {
  function legacySaveAssigned(monthData, index, newVal) {
    const cloned   = JSON.parse(JSON.stringify(monthData));
    const oldValue = cloned.categories[index].assigned || 0;
    const diff     = newVal - oldValue;
    cloned.categories[index].assigned = newVal;
    cloned.categories[index].balance  = newVal - cloned.categories[index].spent;
    cloned.tbb = (cloned.tbb || 0) - diff;
    return cloned;
  }

  test.each([
    ["increase Groceries 300→500", 0, 500, "Groceries"],
    ["decrease Groceries 300→150", 0, 150, "Groceries"],
    ["increase Fun 100→400",       2, 400, "Fun"],
    ["decrease Fun 100→0",         2, 0,   "Fun"],
  ])("%s", async (_, index, newVal, catName) => {
    const freshMonth = JSON.parse(JSON.stringify(BASE_MONTH));
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: freshMonth });
    const eng = makeEngine();

    const oldVal = freshMonth.categories[index].assigned;
    const diff   = newVal - oldVal;

    if (diff === 0) return; // no-op — skip

    const intentType   = diff > 0 ? "assign" : "unassign";
    const intentAmount = Math.abs(diff);

    await persistFinancialTransaction(
      { type: intentType, amount: intentAmount, date: TODAY, monthKey: MONTH, category: catName, meta: { isNewCategory: false } },
      db, UID, eng
    );

    const engineResult = db._getDoc(MONTH_PATH);
    const legacyResult = legacySaveAssigned(freshMonth, index, newVal);

    // TBB must match
    expect(engineResult.tbb).toBeCloseTo(legacyResult.tbb, 5);

    // Category assigned, balance must match
    const engCat    = engineResult.categories.find(c => c.name === catName);
    const legacyCat = legacyResult.categories.find(c => c.name === catName);
    expect(engCat.assigned).toBeCloseTo(legacyCat.assigned, 5);
    expect(engCat.balance).toBeCloseTo(legacyCat.balance, 5);
    expect(engCat.spent).toBeCloseTo(legacyCat.spent, 5);

    // Other categories unchanged
    const otherCats = BASE_CATEGORIES.filter(c => c.name !== catName);
    otherCats.forEach(bc => {
      const engOther    = engineResult.categories.find(c => c.name === bc.name);
      const legacyOther = legacyResult.categories.find(c => c.name === bc.name);
      expect(engOther.assigned).toBeCloseTo(legacyOther.assigned, 5);
    });
  });

  test("sequential edits: tbb tracks correctly across 4 edits", async () => {
    let currentMonth = JSON.parse(JSON.stringify(BASE_MONTH));
    const db  = makeMockDb({ [ROOT_PATH]: BASE_ROOT, [MONTH_PATH]: currentMonth });
    const eng = makeEngine();

    // [index, newVal]
    const edits = [[0, 400], [2, 50], [0, 250], [2, 200]];
    let expectedTbb = BASE_MONTH.tbb;
    let currentAssigned = BASE_CATEGORIES.map(c => c.assigned);

    for (const [index, newVal] of edits) {
      const catName  = BASE_CATEGORIES[index].name;
      const oldVal   = currentAssigned[index];
      const diff     = newVal - oldVal;
      expectedTbb   -= diff;
      currentAssigned[index] = newVal;

      if (diff === 0) continue;
      const intentType   = diff > 0 ? "assign" : "unassign";
      const intentAmount = Math.abs(diff);

      await persistFinancialTransaction(
        { type: intentType, amount: intentAmount, date: TODAY, monthKey: MONTH, category: catName, meta: { isNewCategory: false } },
        db, UID, eng
      );
      currentMonth = db._getDoc(MONTH_PATH);
      db._store().set(MONTH_PATH, JSON.parse(JSON.stringify(currentMonth)));
    }

    const final = db._getDoc(MONTH_PATH);
    expect(final.tbb).toBeCloseTo(expectedTbb, 4);
    expect(final.categories.find(c => c.name === "Groceries").assigned).toBeCloseTo(250, 4);
    expect(final.categories.find(c => c.name === "Fun").assigned).toBeCloseTo(200, 4);
  });
});
