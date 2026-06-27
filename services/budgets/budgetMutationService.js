/**
 * services/budgets/budgetMutationService.js
 *
 * Pure functions that compute and apply budget deltas.
 * ZERO side-effects: every function takes data in, returns new data out.
 * Nothing in production calls these yet (Phase 1 is additive-only).
 *
 * Design contract:
 *  • Inputs are plain JS objects matching the Firestore month-doc schema.
 *  • All monetary values are integer CENTS (matching transactionIntent.js).
 *  • Functions never mutate their arguments — they always return new objects.
 *  • Functions throw descriptive errors on invalid input; callers decide how
 *    to surface them.
 */





// ---------------------------------------------------------------------------
// BudgetDelta type
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} BudgetDelta
 * @property {number}      tbbDeltaCents       — how much TBB should change (+/-)
 * @property {string|null} categoryName        — which category to touch (null = none)
 * @property {number}      categorySpentDelta  — how much category.spent should change
 * @property {number}      assignedDelta       — how much category.assigned should change (Phase 3)
 * @property {boolean}     isNewCategory       — true when the category must be created (Phase 3)
 * @property {string}      reason              — human-readable explanation (for tests/logs)
 */

// ---------------------------------------------------------------------------
// computeBudgetDelta
// ---------------------------------------------------------------------------

/**
 * Given a TransactionIntent, compute exactly what the budget deltas should be.
 *
 * Rules (mirror the existing logic in addTransaction / addIncome / performRollover):
 *
 *  TYPE_INCOME
 *    → TBB += amount
 *    → No category touch
 *
 *  TYPE_EXPENSE, source = SOURCE_AVAILABLE
 *    → category.spent += amount
 *    → TBB unchanged (spent is deducted from category balance, not TBB)
 *
 *  TYPE_EXPENSE, source = SOURCE_ASSET | SOURCE_LIABILITY
 *    → category.spent += amount  (category balance still affected)
 *    → TBB unchanged             (available balance not consumed)
 *
 *  TYPE_TRANSFER
 *    → No budget change (inter-account only)
 *
 *  TYPE_LIABILITY_PAYMENT
 *    → TBB -= amount  (cash leaves available balance)
 *    → No category touch
 *
 * @param {import('../transactions/transactionIntent').TransactionIntent} intent
 * @returns {BudgetDelta}
 */
function computeBudgetDelta(intent) {
  _bmsRequireIntent(intent);

  switch (intent.type) {

    case TYPE_INCOME:
      return {
        tbbDeltaCents:      intent.amountCents,
        categoryName:       null,
        categorySpentDelta: 0,
        reason: `Income of ${_bmsFmt(intent.amountCents)} added to TBB`,
      };

    case TYPE_EXPENSE: {
      // category.spent always increases regardless of source
      // TBB is never directly changed by an expense (it was already
      // reduced when the category was assigned money)
      const reason = intent.source === SOURCE_AVAILABLE
        ? `Expense of ${_bmsFmt(intent.amountCents)} on "${intent.categoryName}" (from available balance)`
        : `Expense of ${_bmsFmt(intent.amountCents)} on "${intent.categoryName}" (from ${intent.source} account "${intent.accountName}") — TBB unaffected`;

      return {
        tbbDeltaCents:      0,
        categoryName:       intent.categoryName,
        categorySpentDelta: intent.amountCents,
        reason,
      };
    }

    case TYPE_TRANSFER:
      return {
        tbbDeltaCents:      0,
        categoryName:       null,
        categorySpentDelta: 0,
        reason: `Transfer of ${_bmsFmt(intent.amountCents)} between accounts — no budget impact`,
      };

    case TYPE_LIABILITY_PAYMENT:
      return {
        tbbDeltaCents:      -intent.amountCents,
        categoryName:       null,
        categorySpentDelta: 0,
        reason: `Liability payment of ${_bmsFmt(intent.amountCents)} to "${intent.accountName}" deducted from TBB`,
      };

    // ── Phase 6: deposit / withdrawal ──────────────────────────────────────
    case "deposit":
      // Deposit increases account balance — no direct budget impact
      // (tbb and categories are unchanged; availableBalance handled by renderBudget)
      return {
        tbbDeltaCents:      0,
        categoryName:       null,
        categorySpentDelta: 0,
        assignedDelta:      0,
        isNewCategory:      false,
        reason: `Deposit of ${_bmsFmt(intent.amountCents)} — no budget impact`,
      };

    case "withdrawal":
      // Withdrawal decreases tbb (cash leaves the budget pool)
      return {
        tbbDeltaCents:      -intent.amountCents,
        categoryName:       null,
        categorySpentDelta: 0,
        assignedDelta:      0,
        isNewCategory:      false,
        reason: `Withdrawal of ${_bmsFmt(intent.amountCents)} deducted from TBB`,
      };

    // ── Phase 3: assign / unassign ─────────────────────────────────────────
    case "assign":
      return {
        tbbDeltaCents:      -intent.amountCents,   // TBB decreases when money is assigned
        categoryName:       intent.categoryName,
        categorySpentDelta: 0,
        assignedDelta:      intent.amountCents,    // category.assigned increases
        isNewCategory:      intent.meta && intent.meta.isNewCategory ? true : false,
        reason: `Assign ${_bmsFmt(intent.amountCents)} to category "${intent.categoryName}"` +
                (intent.meta && intent.meta.isNewCategory ? " (new category)" : ""),
      };

    case "unassign":
      return {
        tbbDeltaCents:       intent.amountCents,   // TBB increases when money is unassigned
        categoryName:        intent.categoryName,
        categorySpentDelta:  0,
        assignedDelta:      -intent.amountCents,   // category.assigned decreases
        isNewCategory:       false,
        reason: `Unassign ${_bmsFmt(intent.amountCents)} from category "${intent.categoryName}"`,
      };

    default:
      throw new Error(`computeBudgetDelta: unknown intent type "${intent.type}"`);
  }
}

// ---------------------------------------------------------------------------
// applyBudgetDeltaToMonth
// ---------------------------------------------------------------------------

/**
 * Applies a BudgetDelta to a month-doc snapshot and returns a NEW month-doc
 * object (never mutates the original).
 *
 * The month-doc shape (matching Firestore):
 * {
 *   tbb:          number,   // float pesos in Firestore, we convert to/from cents
 *   categories:   Array<{
 *     name:     string,
 *     assigned: number,
 *     spent:    number,
 *     balance:  number,
 *   }>,
 *   transactions: Array,
 *   currentMonth: string,
 *   ...other fields preserved verbatim
 * }
 *
 * @param {Object}      monthDoc   — Firestore month snapshot (plain object)
 * @param {BudgetDelta} delta
 * @returns {Object}  new month-doc with changes applied
 */
function applyBudgetDeltaToMonth(monthDoc, delta) {
  if (!monthDoc || typeof monthDoc !== "object") {
    throw new Error("applyBudgetDeltaToMonth: monthDoc must be a plain object");
  }
  _bmsRequireDelta(delta);

  // Work in cents to stay precise
  const currentTbbCents = toCents(monthDoc.tbb || 0);
  const newTbbCents     = currentTbbCents + delta.tbbDeltaCents;

  // Deep-clone categories; update only the targeted one
  let categoryFound = false;
  const categories = (monthDoc.categories || []).map(cat => {
    if (cat.name !== delta.categoryName) return { ...cat };

    categoryFound = true;
    const currentSpentCents    = toCents(cat.spent    || 0);
    const currentAssignedCents = toCents(cat.assigned || 0);
    const startingBalanceCents = toCents(cat.startingBalance || 0);
    const assignedDeltaCents   = delta.assignedDelta || 0;
    const newSpentCents        = currentSpentCents + delta.categorySpentDelta;
    const newAssignedCents     = currentAssignedCents + assignedDeltaCents;
    // Balance includes any carried-forward starting balance from rollover.
    // Cover carries a negative deficit forward; positive leftovers carry
    // forward positive. Categories that never rolled over have no
    // startingBalance, so this term is 0 and balance = assigned - spent.
    const newBalanceCents      = startingBalanceCents + newAssignedCents - newSpentCents;

    return {
      ...cat,
      assigned: fromCents(newAssignedCents),
      spent:    fromCents(newSpentCents),
      balance:  fromCents(newBalanceCents),
    };
  });

  // Phase 3: create placeholder when assigning to a brand-new category
  if (!categoryFound && delta.categoryName && delta.isNewCategory) {
    const assignedCents = delta.assignedDelta || 0;
    categories.push({
      name:     delta.categoryName,
      assigned: fromCents(assignedCents),   // 0 + assignedDelta = assignAmount ✓
      spent:    0,
      balance:  fromCents(assignedCents),
    });
  }

  return {
    ...monthDoc,
    tbb:        fromCents(newTbbCents),
    categories,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _bmsRequireIntent(intent) {
  if (!intent || typeof intent !== "object") {
    throw new Error("computeBudgetDelta: intent must be a plain object");
  }
  if (!intent.type) {
    throw new Error("computeBudgetDelta: intent.type is required");
  }
  if (typeof intent.amountCents !== "number" || intent.amountCents <= 0) {
    throw new Error("computeBudgetDelta: intent.amountCents must be a positive number");
  }
}

function _bmsRequireDelta(delta) {
  if (!delta || typeof delta !== "object") {
    throw new Error("applyBudgetDeltaToMonth: delta must be a plain object");
  }
  if (typeof delta.tbbDeltaCents !== "number") {
    throw new Error("applyBudgetDeltaToMonth: delta.tbbDeltaCents must be a number");
  }
  if (typeof delta.categorySpentDelta !== "number") {
    throw new Error("applyBudgetDeltaToMonth: delta.categorySpentDelta must be a number");
  }
  // assignedDelta is optional (Phase 3+) — default to 0 when absent
  if (delta.assignedDelta === undefined) delta.assignedDelta = 0;
}

/** Format cents for human-readable reason strings. */
function _bmsFmt(cents) {
  return (cents / 100).toFixed(2);
}
