/**
 * services/transactions/transactionEngine.js
 *
 * The top-level engine that wires together:
 *   transactionIntent  → the validated intent
 *   budgetMutationService  → what changes in the month-doc
 *   accountMutationService → what changes in the accounts array
 *   monthService           → month-doc lifecycle
 *
 * processFinancialTransaction() is the single entry-point for ALL financial
 * writes.  It is NOT wired to any UI event in Phase 1 — wiring happens in
 * Phase 2.  The function is exported so Phase 2 can import it directly.
 *
 * Architecture:
 *   ┌──────────────────────────────────────────────┐
 *   │  processFinancialTransaction(intent, ctx)     │
 *   │                                              │
 *   │  1. validate intent (already done by caller) │
 *   │  2. computeBudgetDelta(intent)               │
 *   │  3. computeAccountDelta(intent, accounts)    │
 *   │  4. applyBudgetDeltaToMonth(monthDoc, Δ)     │
 *   │  5. applyAccountDeltaToRoot(accounts, Δ)     │
 *   │  6. build transaction record                 │
 *   │  7. append record to monthDoc.transactions   │
 *   │  8. return EngineResult (no Firestore calls) │
 *   └──────────────────────────────────────────────┘
 *
 * The function is PURE in Phase 1: it takes plain objects in and returns
 * plain objects out.  Firestore persistence is the caller's responsibility
 * (Phase 2 will add a thin persistence wrapper).
 */











// ---------------------------------------------------------------------------
// processFinancialTransaction
// ---------------------------------------------------------------------------

/**
 * Processes a validated TransactionIntent against the current application
 * state and returns the mutated state.
 *
 * @param {import('./transactionIntent').TransactionIntent} intent
 *   — built by one of the buildXxxIntent() factories
 *
 * @param {EngineContext} ctx
 *   — current application state (plain objects, no Firestore references)
 *
 * @returns {EngineResult}
 *   — new state to persist (caller is responsible for Firestore writes)
 */
function processFinancialTransaction(intent, ctx) {
  // ── 0. Validate context ────────────────────────────────────────────────
  _requireContext(ctx);

  // ── 1. Resolve the current month-doc ──────────────────────────────────
  const monthDoc = ensureMonthExists({
    existingData:   ctx.existingMonthData,
    monthKey:       intent.month,
    rootCategories: ctx.rootCategories,
    rootTbb:        ctx.rootTbb,
  });

  // ── 2. Compute deltas (pure, no side-effects) ─────────────────────────
  const budgetDelta  = computeBudgetDelta(intent);
  const accountDelta = computeAccountDelta(intent, ctx.accounts);

  // ── 3. Apply budget delta to month-doc ────────────────────────────────
  const updatedMonthDoc = applyBudgetDeltaToMonth(monthDoc, budgetDelta);

  // ── 4. Apply account delta to accounts array ──────────────────────────
  const updatedAccounts = applyAccountDeltaToRoot(ctx.accounts, accountDelta);

  // ── 5. Build the transaction record (matches existing Firestore schema) ─
  const txnRecord = _buildTransactionRecord(intent);

  // ── 6. Append transaction to month-doc (skipped for assign/unassign) ───
  const finalMonthDoc = txnRecord === null ? updatedMonthDoc : {
    ...updatedMonthDoc,
    transactions: [...(updatedMonthDoc.transactions || []), txnRecord],
  };

  // ── 7. Return result ───────────────────────────────────────────────────
  return {
    monthDoc:       finalMonthDoc,
    accounts:       updatedAccounts,
    transactionRecord: txnRecord,
    budgetDelta,
    accountDelta,
    // Convenience flag: did TBB go negative after this transaction?
    tbbIsNegative:  finalMonthDoc.tbb < 0,
    // Convenience flag: was a new month-doc created (vs existing updated)?
    wasNewMonth:    ctx.existingMonthData === null || ctx.existingMonthData === undefined,
  };
}

// ---------------------------------------------------------------------------
// _buildTransactionRecord
// ---------------------------------------------------------------------------

/**
 * Builds the Firestore transaction record that will be appended to
 * monthDoc.transactions[].
 *
 * The shape mirrors existing records created inline in script.js so that
 * renderTransactionsTable() and renderBudget() continue to work unchanged.
 *
 * @param {import('./transactionIntent').TransactionIntent} intent
 * @returns {Object}
 */
function _buildTransactionRecord(intent) {
  const amount = fromCents(intent.amountCents);

  // Base fields common to all types
  const base = {
    id:       `txn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    name:     intent.payee,
    amount,
    category: intent.categoryName,
    type:     intent.type,
    date:     intent.date,
    source:   "engine",   // distinguish Phase-2 records from legacy ones
  };

  // Type-specific fields (mirror the flags used in renderBudget / renderTransactionsTable)
  switch (intent.type) {

    case TYPE_INCOME:
      return {
        ...base,
        inflow:  amount,
        outflow: 0,
      };

    case TYPE_EXPENSE: {
      const expenseRecord = {
        ...base,
        inflow:  0,
        outflow: amount,
      };
      // Only set these flags when true — Firestore rejects undefined values
      if (intent.source === SOURCE_ASSET)     expenseRecord.fromAsset     = true;
      if (intent.source === SOURCE_LIABILITY) expenseRecord.fromLiability = true;
      if (intent.accountName)                 expenseRecord.fromAccount    = intent.accountName;
      return expenseRecord;
    }

    case TYPE_TRANSFER:
      return {
        ...base,
        category:    "Transfer",
        inflow:      0,
        outflow:     amount,
        fromAccount: intent.fromAccountName,
        toAccount:   intent.toAccountName,
      };

    case TYPE_LIABILITY_PAYMENT:
      return {
        ...base,
        category:           "Liability Payment",
        inflow:             0,
        outflow:            amount,
        isLiabilityPayment: true,
        fromAccount:        intent.accountName,
      };

    // Phase 6: deposit — money in from outside
    case "deposit":
      return {
        ...base,
        category: "Deposit",
        type:     "expense",   // matches legacy shape (deposit uses outflow)
        inflow:   0,
        outflow:  amount,
        isAccountOnlyTxn: true,
        accountName: intent.accountName,
      };

    // Phase 6: withdrawal — money out to outside
    case "withdrawal":
      return {
        ...base,
        category: "Withdrawal",
        type:     "income",    // matches legacy shape (withdrawal uses inflow)
        inflow:   amount,
        outflow:  0,
        isAccountOnlyTxn: true,
        accountName: intent.accountName,
      };

    // Phase 3: assign/unassign are budget-only operations — no transaction record
    case "assign":
    case "unassign":
      return null;

    default:
      throw new Error(`_buildTransactionRecord: unknown type "${intent.type}"`);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _requireContext(ctx) {
  if (!ctx || typeof ctx !== "object") {
    throw new Error("processFinancialTransaction: ctx must be a plain object");
  }
  if (!Array.isArray(ctx.accounts)) {
    throw new Error("processFinancialTransaction: ctx.accounts must be an array");
  }
  // existingMonthData may be null (new month) — that's valid
  if (
    ctx.existingMonthData !== null &&
    ctx.existingMonthData !== undefined &&
    typeof ctx.existingMonthData !== "object"
  ) {
    throw new Error(
      "processFinancialTransaction: ctx.existingMonthData must be an object or null"
    );
  }
}

// ---------------------------------------------------------------------------
// JSDoc typedefs
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} EngineContext
 * @property {Array}       accounts          — current accounts[] from root doc
 * @property {Object|null} existingMonthData — monthSnap.data() or null if new
 * @property {Array}       [rootCategories]  — seed categories for new months
 * @property {number}      [rootTbb]         — seed TBB for new months
 */

/**
 * @typedef {Object} EngineResult
 * @property {Object}  monthDoc            — updated month-doc (ready for Firestore .set())
 * @property {Array}   accounts            — updated accounts array (ready for root-doc .update())
 * @property {Object}  transactionRecord   — the record appended to monthDoc.transactions
 * @property {import('../budgets/budgetMutationService').BudgetDelta}  budgetDelta
 * @property {import('../accounts/accountMutationService').AccountDelta} accountDelta
 * @property {boolean} tbbIsNegative       — true when TBB went below zero
 * @property {boolean} wasNewMonth         — true when a fresh month-doc was created
 */
