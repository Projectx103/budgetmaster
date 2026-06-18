/**
 * services/transactions/transactionTypes.js
 *
 * Canonical constants for every transaction kind the engine understands.
 * Nothing in production calls these yet (Phase 1 is additive-only).
 *
 * TYPES describe WHAT happened.
 * SOURCES describe WHERE the money came from / went.
 *
 * These mirror the implicit conventions already present in script.js
 * (t.type, t.fromAsset, t.fromLiability, t.isLiabilityPayment, etc.)
 * so Phase 2 wiring is a safe drop-in.
 */

// ---------------------------------------------------------------------------
// Primary transaction type — stored as `transaction.type`
// ---------------------------------------------------------------------------

/** Reduces a budget category's `spent`; touches TBB only when paid from
 *  available balance (not from an asset account or liability). */
const TYPE_EXPENSE = "expense";

/** Increases TBB for the month it lands in. */
const TYPE_INCOME = "income";

/** Moves money between two accounts; no budget category involved.
 *  fromAccount / toAccount carry the names. */
const TYPE_TRANSFER = "transfer";

/** Cash repayment of a liability balance; reduces the liability account
 *  balance AND reduces available balance (cash outflow). */
const TYPE_LIABILITY_PAYMENT = "liability_payment";

// ---------------------------------------------------------------------------
// Payment source — controls which balance buckets are affected
// ---------------------------------------------------------------------------

/** Expense paid from an asset account (e.g. checking).
 *  Reduces asset balance; does NOT reduce TBB / available balance. */
const SOURCE_ASSET = "asset";

/** Expense charged to a liability account (e.g. credit card).
 *  Increases liability balance; does NOT reduce TBB / available balance. */
const SOURCE_LIABILITY = "liability";

/** Expense paid from the budget's available balance (TBB pool).
 *  Reduces TBB; no account balance changes. */
const SOURCE_AVAILABLE = "available";

// ---------------------------------------------------------------------------
// Account category — mirrors ACCOUNT_TYPES in script.js
// ---------------------------------------------------------------------------

const ACCOUNT_CATEGORY_ASSET     = "asset";
const ACCOUNT_CATEGORY_LIABILITY = "liability";

// ---------------------------------------------------------------------------
// Reserved category names (script.js conventions)
// ---------------------------------------------------------------------------

/** Category name used for account Deposit transactions. */
const CAT_DEPOSIT    = "Deposit";

/** Category name used for account Withdrawal transactions. */
const CAT_WITHDRAWAL = "Withdrawal";

/** Category name used for inter-account Transfer transactions. */
const CAT_TRANSFER   = "Transfer";

/** Synthetic category name written by the rollover process. */
const CAT_ROLLOVER   = "BALANCE FROM LAST MONTH";

// ---------------------------------------------------------------------------
// Derived helpers (pure functions; no side-effects)
// ---------------------------------------------------------------------------

/**
 * Returns true when a transaction should be excluded from the budget's
 * "account outflow" calculation (i.e. it does not reduce available balance).
 *
 * Mirrors the guards in renderBudget():
 *   if (t.fromAsset) return;
 *   if (t.fromLiability) return;
 *
 * @param {{ fromAsset?: boolean, fromLiability?: boolean }} txn
 */
function isExcludedFromAvailableBalance(txn) {
  return Boolean(txn.fromAsset || txn.fromLiability);
}

/**
 * Returns true when the transaction is a plain account-ledger movement
 * (Deposit / Withdrawal / Transfer) rather than a budget-category expense.
 *
 * @param {{ category?: string }} txn
 */
function isAccountLedgerTransaction(txn) {
  return (
    txn.category === CAT_DEPOSIT ||
    txn.category === CAT_WITHDRAWAL ||
    txn.category === CAT_TRANSFER
  );
}
