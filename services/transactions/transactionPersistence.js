/**
 * services/transactions/transactionPersistence.js
 *
 * Phase 2 — Firestore persistence layer.
 *
 * This file is the ONLY place in the engine that touches Firestore.
 * The pure Phase 1 functions (processFinancialTransaction, computeBudgetDelta,
 * applyBudgetDeltaToMonth, etc.) remain side-effect-free and are imported here
 * as black boxes.
 *
 * Public API
 * ----------
 *   persistFinancialTransaction(flatIntent, db, uid)
 *     → the function wired behind FEATURE_FLAGS.useEngineForIncome (Phase 2)
 *       and FEATURE_FLAGS.useEngineForCategoryAssign (Phase 3).  Takes the flat intent shape the plan specifies,
 *       maps it to the engine's intent+ctx shape, runs the pure engine, then
 *       persists the result atomically via runWithRetry.
 *
 * Why a separate file (not modifying transactionEngine.js)?
 * ---------------------------------------------------------
 * Keeping I/O at the boundary means:
 *   • Phase 1 unit tests remain 100% valid — no mocking of Firestore needed.
 *   • This file can be unit-tested with a mock db object (same pattern as
 *     firestoreTransactionRunner.test.js).
 *   • Rollback of Phase 2 = flip FEATURE_FLAGS.useEngineForIncome = false.
 *     The persistence layer is never called; the pure engine is untouched.
 *
 * Flat intent shape (what callers pass in)
 * ----------------------------------------
 * {
 *   type:      'income' | 'expense' | 'transfer' | 'liability_payment'
 *   amount:    number   — positive float (user currency)
 *   date:      string   — YYYY-MM-DD
 *   monthKey:  string   — YYYY-MM  (NOTE: engine uses intent.month internally)
 *   name:      string   — payee / description
 *   category:  string   — category name
 *   meta:      object   — type-specific extras (fromAsset, fromLiability, etc.)
 * }
 *
 * Firestore documents touched (income path only — Phase 2 scope)
 * --------------------------------------------------------------
 *   budget/{uid}                 — root doc (read: accounts, tbb, categories)
 *   budget/{uid}/months/{YYYY-MM} — month doc (read + write via runTransaction)
 */

"use strict";

// ---------------------------------------------------------------------------
// Import Phase 0 retry wrapper (CommonJS — matches how script.js is loaded)
// ---------------------------------------------------------------------------
// In the browser these are loaded as <script> tags; in tests we use require().
// The conditional pattern makes the file work in both environments.

let _runWithRetry;
if (typeof require !== "undefined") {
  _runWithRetry = require("../../firebase/firestoreTransactionRunner").runWithRetry;
}

// ---------------------------------------------------------------------------
// Pure engine imports
// These are ES-module files in Phase 1. In the browser they are loaded via
// <script type="module"> or a bundler. In Node tests we use jest + babel or
// a CJS shim. The imports are declared here for documentation; in the browser
// build these resolve via the module graph.
// ---------------------------------------------------------------------------
// import { processFinancialTransaction } from "./transactionEngine.js";
// import { buildIncomeIntent }           from "./transactionIntent.js";
// import { ensureMonthExists }           from "../months/monthService.js";
//
// For the CommonJS/browser-compat wrapper used in tests, callers inject the
// engine via the `_engine` parameter of persistFinancialTransaction().
// Production callers (script.js) use the global-scope versions loaded as
// ES module scripts.

// ---------------------------------------------------------------------------
// persistFinancialTransaction
// ---------------------------------------------------------------------------

/**
 * Runs the pure financial engine and persists the result to Firestore
 * atomically, with ABORTED-error retry via runWithRetry.
 *
 * This is the function behind FEATURE_FLAGS.useEngineForIncome (Phase 2)
 * and future flags for other transaction types.
 *
 * @param {object} flatIntent          - The flat intent shape (see file header).
 * @param {object} db                  - Firestore db instance (firebase.firestore()).
 * @param {string} uid                 - Current user UID.
 * @param {object} [_engine]           - Dependency-injection for tests.
 *   @param {Function} _engine.processFinancialTransaction
 *   @param {Function} _engine.buildIntentFromFlat
 *   @param {Function} _engine.ensureMonthExists
 * @returns {Promise<EngineResult>}    - The result from processFinancialTransaction.
 */
async function persistFinancialTransaction(flatIntent, db, uid, _engine) {
  // Resolve injected or global engine functions
  const engineFn  = (_engine && _engine.processFinancialTransaction)
    || (typeof processFinancialTransaction !== "undefined" && processFinancialTransaction)
    || _missingDep("processFinancialTransaction");

  const buildIntent = (_engine && _engine.buildIntentFromFlat)
    || buildIntentFromFlat;

  const runTxn = _runWithRetry
    || (typeof runWithRetry !== "undefined" && runWithRetry)
    || _missingDep("runWithRetry");

  // Validate flat intent minimally before touching Firestore
  _validateFlatIntent(flatIntent);

  const rootRef   = db.collection("budget").doc(uid);
  const monthRef  = rootRef.collection("months").doc(flatIntent.monthKey);

  let engineResult;

  await runTxn(db, async (txn) => {
    // ── Read phase (all gets before any sets) ─────────────────────────────
    const [rootSnap, monthSnap] = await Promise.all([
      txn.get(rootRef),
      txn.get(monthRef),
    ]);

    const rootData  = rootSnap.exists ? rootSnap.data() : { tbb: 0, categories: [], accounts: [] };
    const monthData = monthSnap.exists ? monthSnap.data() : null;

    // ── Build typed intent from the flat shape ─────────────────────────────
    const typedIntent = buildIntent(flatIntent);

    // ── Run the pure engine ────────────────────────────────────────────────
    engineResult = engineFn(typedIntent, {
      accounts:         rootData.accounts  || [],
      existingMonthData: monthData,
      rootCategories:   rootData.categories || [],
      rootTbb:          rootData.tbb        || 0,
    });

    // ── Write phase ────────────────────────────────────────────────────────
    // Phase 2 scope: income only touches the month doc (tbb + transactions).
    // accounts[] is unchanged for income — no root-doc write needed this phase.
    //
    // CRITICAL: do NOT write currentMonth here.
    // The old addIncome does NOT update docRef.currentMonth either — only
    // addTransaction does. We match that behaviour exactly.
    //
    // CRITICAL: do NOT touch availableBalance — it stays driven by
    // renderBudget() until Phase 8.
    txn.set(monthRef, _safeMonthPayload(engineResult.monthDoc, monthData));
  });

  return engineResult;
}

// ---------------------------------------------------------------------------
// buildIntentFromFlat
// ---------------------------------------------------------------------------

/**
 * Converts the flat intent shape used in script.js call-sites into the typed
 * TransactionIntent the pure engine expects.
 *
 * This bridges two naming conventions:
 *   flat.monthKey  →  intent.month   (engine uses .month)
 *   flat.name      →  intent.payee
 *   flat.category  →  intent.categoryName
 *
 * Phase 2 only handles TYPE_INCOME. Other types are added in later phases.
 *
 * @param {object} flat
 * @returns {TransactionIntent}
 */
function buildIntentFromFlat(flat) {
  switch (flat.type) {
    case "income":
      // Uses buildIncomeIntent shape — map flat fields
      return {
        type:         "income",
        source:       null,
        payee:        (flat.name || flat.description || "Income").trim(),
        categoryName: flat.category || "Income",
        accountName:  null,
        amountCents:  _toCents(flat.amount),
        date:         flat.date,
        month:        flat.monthKey,   // ← engine uses .month not .monthKey
      };

    // Phases 4-7 will add: expense, deposit, withdrawal, transfer, liability_payment.
    case "expense":
      // Phase 4 — dashboard expense from available balance
      return {
        type:         "expense",
        source:       flat.source || "available",
        payee:        (flat.name || "Expense").trim(),
        categoryName: flat.category || flat.categoryName,
        accountName:  flat.accountName || null,
        amountCents:  _toCents(flat.amount),
        date:         flat.date,
        month:        flat.monthKey,
        meta:         flat.meta || {},
      };

    case "assign":
      // Phase 3 — new category or reassignment
      return {
        type:         "assign",
        source:       null,
        payee:        `Assign to ${flat.category || flat.categoryName}`,
        categoryName: flat.category || flat.categoryName,
        accountName:  null,
        amountCents:  _toCents(flat.amount),
        date:         flat.date,
        month:        flat.monthKey,
        meta:         flat.meta || {},
      };

    case "unassign":
      return {
        type:         "unassign",
        source:       null,
        payee:        `Unassign from ${flat.category || flat.categoryName}`,
        categoryName: flat.category || flat.categoryName,
        accountName:  null,
        amountCents:  _toCents(flat.amount),
        date:         flat.date,
        month:        flat.monthKey,
        meta:         flat.meta || {},
      };

    case "deposit":
    case "withdrawal":
    case "transfer":
    case "liability_payment":
      throw new Error(
        `buildIntentFromFlat: type "${flat.type}" is not yet wired in Phase 3. ` +
        `Add its branch here when that phase ships.`
      );

    default:
      throw new Error(`buildIntentFromFlat: unknown intent type "${flat.type}"`);
  }
}

// ---------------------------------------------------------------------------
// _safeMonthPayload
// ---------------------------------------------------------------------------

/**
 * Builds the Firestore payload for the month doc write.
 *
 * Rules for Phase 2 (income only):
 *  - Write tbb and transactions from the engine result.
 *  - Preserve all other fields from the existing month doc (categories,
 *    availableBalance, note, savedAt, currentMonth, etc.).
 *  - When the month doc is NEW (existingMonthData === null), write the full
 *    engine-produced month doc — but still omit availableBalance (Phase 8).
 *
 * We do NOT use {merge: true} on the txn.set() because inside a Firestore
 * runTransaction, txn.set() replaces the document but we control the full
 * payload here anyway. This is intentional — we always write a complete,
 * consistent document.
 *
 * @param {object} engineMonthDoc    - result.monthDoc from processFinancialTransaction
 * @param {object|null} existingData - original Firestore month doc data (or null)
 * @returns {object}                 - safe payload for txn.set()
 */
function _safeMonthPayload(engineMonthDoc, existingData) {
  if (existingData === null) {
    // Brand-new month doc: write the full engine output, but scrub availableBalance.
    const payload = { ...engineMonthDoc };
    delete payload.availableBalance;  // Phase 8 owns this field
    return payload;
  }

  // Existing month doc: merge engine's tbb + transactions + categories into existing data.
  // Preserve every other field exactly as it was (availableBalance, note, savedAt, etc.)
  // Phase 3: categories must also be written because assign/unassign mutate them.
  return {
    ...existingData,
    tbb:          engineMonthDoc.tbb,
    transactions: engineMonthDoc.transactions,
    categories:   engineMonthDoc.categories,
  };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function _toCents(floatAmount) {
  return Math.round(floatAmount * 100);
}

function _validateFlatIntent(flat) {
  if (!flat || typeof flat !== "object") {
    throw new Error("persistFinancialTransaction: flatIntent must be an object");
  }
  if (!flat.type)     throw new Error("persistFinancialTransaction: flatIntent.type is required");
  if (!flat.monthKey) throw new Error("persistFinancialTransaction: flatIntent.monthKey is required");
  if (typeof flat.amount !== "number" || flat.amount <= 0) {
    throw new Error("persistFinancialTransaction: flatIntent.amount must be a positive number");
  }
  if (!flat.date) throw new Error("persistFinancialTransaction: flatIntent.date is required");
}

function _missingDep(name) {
  throw new Error(
    `persistFinancialTransaction: "${name}" is not available. ` +
    `Ensure it is loaded before calling this function (browser: check script load order; ` +
    `Node/tests: inject via the _engine parameter).`
  );
}

// ---------------------------------------------------------------------------
// Exports (CommonJS for Node tests; browser uses global scope)
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    persistFinancialTransaction,
    buildIntentFromFlat,
    _safeMonthPayload,
    _validateFlatIntent,
    _toCents,
  };
}
