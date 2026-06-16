/**
 * validators/transactionValidators.js
 *
 * Pure, side-effect-free validation functions for every transaction type
 * present in script.js.  "Pure" means: no alert(), no Firestore reads, no
 * DOM access — only { valid, errors[] } return objects.
 *
 * Why a separate module?
 * ----------------------
 * All validation in script.js is currently inlined as `if (!x) return alert(…)`
 * guards immediately before write logic.  This makes it:
 *   - Impossible to unit-test without a DOM.
 *   - Impossible to reuse in the recurring-transaction engine (Phase 0
 *     pre-requisite for that feature: background jobs cannot call alert()).
 *   - Impossible to give users structured error messages instead of browser
 *     dialogs.
 *
 * Phases 2-7 will route UI validation through these functions before calling
 * processFinancialTransaction(); the engine itself also calls them as a
 * safety net so even headless/background callers get validation.
 *
 * Field shapes validated here match the transaction records in:
 *   - addIncome()            lines 731-778
 *   - addTransaction()       lines 849-912
 *   - addCategory()          lines 781-847
 *   - saveAssigned()         lines 588-643
 *   - openTransactionPanel() save handler  lines 1989-2223
 *   - accounts save handler  lines 1725-1832
 *
 * Usage
 * -----
 *   const { validateIncome, ValidationError } = require('./validators/transactionValidators');
 *
 *   const result = validateIncome({ amount: -5, description: '' });
 *   if (!result.valid) throw new ValidationError(result.errors.join('; '));
 */

// ---------------------------------------------------------------------------
// ValidationResult shape
// ---------------------------------------------------------------------------
// { valid: boolean, errors: string[] }
// errors is always an array (empty when valid === true).

function _ok()        { return { valid: true, errors: [] }; }
function _fail(msgs)  { return { valid: false, errors: Array.isArray(msgs) ? msgs : [msgs] }; }

// ---------------------------------------------------------------------------
// Shared field validators (private)
// ---------------------------------------------------------------------------

function _requireAmount(amount, label = "Amount") {
  const errors = [];
  if (typeof amount !== "number" || isNaN(amount)) {
    errors.push(`${label} must be a number.`);
  } else if (amount <= 0) {
    errors.push(`${label} must be greater than zero.`);
  }
  return errors;
}

function _requirePositiveOrZero(value, label) {
  const errors = [];
  if (typeof value !== "number" || isNaN(value)) {
    errors.push(`${label} must be a number.`);
  } else if (value < 0) {
    errors.push(`${label} cannot be negative.`);
  }
  return errors;
}

function _requireNonEmptyString(value, label) {
  if (!value || typeof value !== "string" || value.trim() === "") {
    return [`${label} is required.`];
  }
  return [];
}

function _requireDate(date, label = "Date") {
  if (!date) return [`${label} is required.`];
  const d = new Date(date);
  if (isNaN(d.getTime())) return [`${label} "${date}" is not a valid date.`];
  return [];
}

function _requireMonthKey(monthKey) {
  if (!monthKey) return ["monthKey is required."];
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return [`monthKey "${monthKey}" must be in YYYY-MM format.`];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Public validators
// ---------------------------------------------------------------------------

/**
 * Validate parameters for addIncome() / processFinancialTransaction({ type: 'income' })
 *
 * @param {{ amount: number, description?: string, date: string, monthKey: string }} params
 */
function validateIncome({ amount, description, date, monthKey } = {}) {
  const errors = [
    ..._requireAmount(amount, "Income amount"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
    // description is optional — matches old code: `description || "Income"`
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate parameters for addTransaction() — dashboard expense.
 * Matches guards: name required, amount > 0, date required, category must be selected.
 *
 * @param {{ name: string, amount: number, category: string, date: string, monthKey: string }} params
 */
function validateDashboardExpense({ name, amount, category, date, monthKey } = {}) {
  const errors = [
    ..._requireNonEmptyString(name, "Transaction name"),
    ..._requireAmount(amount, "Transaction amount"),
    ..._requireNonEmptyString(category, "Category"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate parameters for addCategory().
 * Matches guards: name required, assignAmount >= 0 (zero is allowed — category with no initial budget).
 *
 * @param {{ name: string, assignAmount: number, monthKey: string }} params
 */
function validateNewCategory({ name, assignAmount, monthKey } = {}) {
  const errors = [
    ..._requireNonEmptyString(name, "Category name"),
    ..._requirePositiveOrZero(assignAmount, "Assigned amount"),
    ..._requireMonthKey(monthKey),
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate parameters for saveAssigned() — inline category budget edit.
 *
 * @param {{ value: number, categoryIndex: number, monthKey: string }} params
 */
function validateAssignedEdit({ value, categoryIndex, monthKey } = {}) {
  const errors = [
    ..._requirePositiveOrZero(value, "Assigned value"),
    ..._requireMonthKey(monthKey),
  ];
  if (typeof categoryIndex !== "number" || !Number.isInteger(categoryIndex) || categoryIndex < 0) {
    errors.push("categoryIndex must be a non-negative integer.");
  }
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate a deposit into an asset account.
 *
 * @param {{ amount: number, accountId: string, date: string, monthKey: string }} params
 */
function validateDeposit({ amount, accountId, date, monthKey } = {}) {
  const errors = [
    ..._requireAmount(amount, "Deposit amount"),
    ..._requireNonEmptyString(accountId, "Account ID"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate a withdrawal from an asset account.
 * Note: insufficient-balance check is NOT here — it requires a Firestore read
 * and belongs in the engine (processFinancialTransaction) or the UI handler.
 *
 * @param {{ amount: number, accountId: string, date: string, monthKey: string }} params
 */
function validateWithdrawal({ amount, accountId, date, monthKey } = {}) {
  const errors = [
    ..._requireAmount(amount, "Withdrawal amount"),
    ..._requireNonEmptyString(accountId, "Account ID"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate a transfer between two accounts.
 * Note: insufficient-balance check and same-account check done in engine.
 *
 * @param {{ amount: number, sourceAccountId: string, targetAccountId: string, date: string, monthKey: string }} params
 */
function validateTransfer({ amount, sourceAccountId, targetAccountId, date, monthKey } = {}) {
  const errors = [
    ..._requireAmount(amount, "Transfer amount"),
    ..._requireNonEmptyString(sourceAccountId, "Source account ID"),
    ..._requireNonEmptyString(targetAccountId, "Target account ID"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
  ];
  if (sourceAccountId && targetAccountId && sourceAccountId === targetAccountId) {
    errors.push("Source and target accounts must be different.");
  }
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate an expense paid from an asset account (fromAsset = true).
 *
 * @param {{ amount: number, category: string, sourceAccountId: string, date: string, monthKey: string }} params
 */
function validateAssetFundedExpense({ amount, category, sourceAccountId, date, monthKey } = {}) {
  const errors = [
    ..._requireAmount(amount, "Expense amount"),
    ..._requireNonEmptyString(category, "Category"),
    ..._requireNonEmptyString(sourceAccountId, "Source account ID"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate an expense charged to a liability account (fromLiability = true).
 *
 * @param {{ amount: number, category: string, sourceAccountId: string, date: string, monthKey: string }} params
 */
function validateLiabilityFundedExpense({ amount, category, sourceAccountId, date, monthKey } = {}) {
  // Same shape as asset-funded expense — separated for semantic clarity and
  // for future per-type rules (e.g. credit-limit guard).
  const errors = [
    ..._requireAmount(amount, "Expense amount"),
    ..._requireNonEmptyString(category, "Category"),
    ..._requireNonEmptyString(sourceAccountId, "Liability account ID"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate a liability payment (the "pay" type in openTransactionPanel).
 *
 * @param {{ amount: number, sourceAccountId: string, date: string, monthKey: string }} params
 */
function validateLiabilityPayment({ amount, sourceAccountId, date, monthKey } = {}) {
  const errors = [
    ..._requireAmount(amount, "Payment amount"),
    ..._requireNonEmptyString(sourceAccountId, "Liability account ID"),
    ..._requireDate(date),
    ..._requireMonthKey(monthKey),
  ];
  return errors.length ? _fail(errors) : _ok();
}

/**
 * Validate an account record before save/update (the "save-account-btn" handler).
 *
 * @param {{ type: string, name: string, balance: number, creditLimit?: number, dueDay?: number|string }} params
 */
function validateAccountRecord({ type, name, balance, creditLimit, dueDay } = {}) {
  const VALID_TYPES = [
    "checking", "savings", "cash", "investment", "retirement", "other-asset",
    "credit-card", "loan", "mortgage", "line-of-credit", "other-liability",
  ];
  const errors = [
    ..._requireNonEmptyString(type, "Account type"),
    ..._requireNonEmptyString(name, "Account name"),
  ];
  if (type && !VALID_TYPES.includes(type)) {
    errors.push(`Account type "${type}" is not recognised. Valid types: ${VALID_TYPES.join(", ")}.`);
  }
  if (typeof balance !== "number" || isNaN(balance)) {
    errors.push("Balance must be a number.");
  }
  if (type === "credit-card") {
    if (!creditLimit || isNaN(parseFloat(creditLimit)) || parseFloat(creditLimit) <= 0) {
      errors.push("Credit limit must be a positive number for credit card accounts.");
    }
    if (!dueDay) {
      errors.push("Due date is required for credit card accounts.");
    }
  }
  return errors.length ? _fail(errors) : _ok();
}

// ---------------------------------------------------------------------------
// Master dispatcher — used by the engine so it calls the right validator
// based on intent.type without if/else chains in the engine itself.
// ---------------------------------------------------------------------------

/**
 * Validate any TransactionIntent object.
 * Returns { valid, errors } — delegates to the appropriate type-specific validator.
 *
 * @param {object} intent - A TransactionIntent (shape defined in services/transactions/transactionTypes.js).
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateIntent(intent = {}) {
  if (!intent.type) return _fail(["intent.type is required."]);

  switch (intent.type) {
    case "income":
      return validateIncome({
        amount:      intent.amount,
        description: intent.name,
        date:        intent.date,
        monthKey:    intent.monthKey,
      });

    case "expense": {
      const meta = intent.meta || {};
      if (meta.fromAsset) {
        return validateAssetFundedExpense({
          amount:          intent.amount,
          category:        intent.category,
          sourceAccountId: intent.sourceAccountId,
          date:            intent.date,
          monthKey:        intent.monthKey,
        });
      }
      if (meta.fromLiability) {
        return validateLiabilityFundedExpense({
          amount:          intent.amount,
          category:        intent.category,
          sourceAccountId: intent.sourceAccountId,
          date:            intent.date,
          monthKey:        intent.monthKey,
        });
      }
      // Available-balance-funded expense (dashboard addTransaction path)
      return validateDashboardExpense({
        name:     intent.name,
        amount:   intent.amount,
        category: intent.category,
        date:     intent.date,
        monthKey: intent.monthKey,
      });
    }

    case "deposit":
      return validateDeposit({
        amount:          intent.amount,
        accountId:       intent.sourceAccountId,
        date:            intent.date,
        monthKey:        intent.monthKey,
      });

    case "withdrawal":
      return validateWithdrawal({
        amount:          intent.amount,
        accountId:       intent.sourceAccountId,
        date:            intent.date,
        monthKey:        intent.monthKey,
      });

    case "transfer":
      return validateTransfer({
        amount:          intent.amount,
        sourceAccountId: intent.sourceAccountId,
        targetAccountId: intent.targetAccountId,
        date:            intent.date,
        monthKey:        intent.monthKey,
      });

    case "liability_payment":
      return validateLiabilityPayment({
        amount:          intent.amount,
        sourceAccountId: intent.sourceAccountId,
        date:            intent.date,
        monthKey:        intent.monthKey,
      });

    case "assign":
      return validateNewCategory({
        name:          intent.category,
        assignAmount:  intent.amount,
        monthKey:      intent.monthKey,
      });

    case "unassign":
      // Unassign = assign delta of 0 or negative.  We reuse the assigned-edit
      // validator; the engine will handle the directionality.
      return validateAssignedEdit({
        value:         intent.amount,
        categoryIndex: intent.meta?.categoryIndex,
        monthKey:      intent.monthKey,
      });

    default:
      return _fail([`Unknown intent type "${intent.type}".`]);
  }
}

// ---------------------------------------------------------------------------
// ValidationError — for callers that prefer throw/catch over result objects.
// ---------------------------------------------------------------------------

class ValidationError extends Error {
  /**
   * @param {string[]} errors - Array of human-readable error messages.
   */
  constructor(errors = []) {
    super(Array.isArray(errors) ? errors.join("; ") : errors);
    this.name = "ValidationError";
    this.errors = Array.isArray(errors) ? errors : [errors];
  }
}

/**
 * Like validateIntent but throws ValidationError instead of returning.
 * Convenience for callers that prefer exception style.
 */
function assertIntent(intent) {
  const result = validateIntent(intent);
  if (!result.valid) throw new ValidationError(result.errors);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    // Type-specific validators
    validateIncome,
    validateDashboardExpense,
    validateNewCategory,
    validateAssignedEdit,
    validateDeposit,
    validateWithdrawal,
    validateTransfer,
    validateAssetFundedExpense,
    validateLiabilityFundedExpense,
    validateLiabilityPayment,
    validateAccountRecord,
    // Master dispatcher
    validateIntent,
    // Exception-style helper
    ValidationError,
    assertIntent,
    // Private helpers — exported only for unit tests.
    _requireAmount,
    _requireNonEmptyString,
    _requireDate,
    _requireMonthKey,
  };
}
