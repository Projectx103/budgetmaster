/**
 * services/transactions/transactionIntent.js
 *
 * Parses and validates raw form/UI data into a clean, typed TransactionIntent.
 * Nothing calls this in production yet (Phase 1 is additive-only).
 *
 * A TransactionIntent is a plain object that answers three questions:
 *   1. What kind of transaction is this?          → .type / .source
 *   2. Who / what is involved?                     → .accountName, .categoryName, etc.
 *   3. What are the exact amounts?                 → .amount (always positive integer cents)
 *
 * All monetary values are stored as integer CENTS to avoid floating-point drift.
 * The UI layer (script.js) currently uses float pesos; toCents() / fromCents()
 * are provided for bridging.
 */

import {
  TYPE_EXPENSE,
  TYPE_INCOME,
  TYPE_TRANSFER,
  TYPE_LIABILITY_PAYMENT,
  SOURCE_ASSET,
  SOURCE_LIABILITY,
  SOURCE_AVAILABLE,
} from "./transactionTypes.js";

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

/**
 * Converts a floating-point currency value (e.g. 1234.56) to integer cents
 * (e.g. 123456).  Rounds half-up to avoid accumulating drift.
 *
 * @param {number} floatAmount
 * @returns {number}  integer cents, always ≥ 0 after Math.round
 */
export function toCents(floatAmount) {
  return Math.round(floatAmount * 100);
}

/**
 * Converts integer cents back to a float for display / Firestore storage.
 *
 * @param {number} cents
 * @returns {number}
 */
export function fromCents(cents) {
  return cents / 100;
}

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

export class IntentValidationError extends Error {
  /**
   * @param {string} message
   * @param {string} field  — the field name that failed validation
   */
  constructor(message, field) {
    super(message);
    this.name = "IntentValidationError";
    this.field = field;
  }
}

// ---------------------------------------------------------------------------
// Intent factories
// ---------------------------------------------------------------------------

/**
 * Builds a TransactionIntent for a budget-category expense.
 *
 * @param {{
 *   payee:         string,
 *   amount:        number,   // positive float (pesos / user currency)
 *   categoryName:  string,
 *   date:          string,   // YYYY-MM-DD
 *   month:         string,   // YYYY-MM
 *   source?:       'asset' | 'liability' | 'available'
 *   accountName?:  string,   // required when source is 'asset' or 'liability'
 * }} raw
 * @returns {TransactionIntent}
 */
export function buildExpenseIntent(raw) {
  _requireString(raw.payee,        "payee");
  _requireString(raw.categoryName, "categoryName");
  _requireDate(raw.date,           "date");
  _requireMonth(raw.month,         "month");
  _requirePositiveAmount(raw.amount, "amount");

  const source = raw.source || SOURCE_AVAILABLE;
  _validateSource(source);

  if (source !== SOURCE_AVAILABLE && !raw.accountName) {
    throw new IntentValidationError(
      "accountName is required when source is 'asset' or 'liability'",
      "accountName"
    );
  }

  return {
    type:         TYPE_EXPENSE,
    source,
    payee:        raw.payee.trim(),
    categoryName: raw.categoryName,
    accountName:  raw.accountName || null,
    amountCents:  toCents(raw.amount),
    date:         raw.date,
    month:        raw.month,
  };
}

/**
 * Builds a TransactionIntent for income (adds to TBB).
 *
 * @param {{
 *   description: string,
 *   amount:      number,
 *   date:        string,
 *   month:       string,
 * }} raw
 * @returns {TransactionIntent}
 */
export function buildIncomeIntent(raw) {
  _requireString(raw.description, "description");
  _requireDate(raw.date,          "date");
  _requireMonth(raw.month,        "month");
  _requirePositiveAmount(raw.amount, "amount");

  return {
    type:        TYPE_INCOME,
    source:      null,
    payee:       raw.description.trim(),
    categoryName: "Income",
    accountName: null,
    amountCents: toCents(raw.amount),
    date:        raw.date,
    month:       raw.month,
  };
}

/**
 * Builds a TransactionIntent for a transfer between two accounts.
 *
 * @param {{
 *   fromAccountName: string,
 *   toAccountName:   string,
 *   amount:          number,
 *   date:            string,
 *   month:           string,
 * }} raw
 * @returns {TransactionIntent}
 */
export function buildTransferIntent(raw) {
  _requireString(raw.fromAccountName, "fromAccountName");
  _requireString(raw.toAccountName,   "toAccountName");
  _requireDate(raw.date,              "date");
  _requireMonth(raw.month,            "month");
  _requirePositiveAmount(raw.amount,  "amount");

  if (raw.fromAccountName.trim() === raw.toAccountName.trim()) {
    throw new IntentValidationError(
      "fromAccountName and toAccountName must be different",
      "toAccountName"
    );
  }

  return {
    type:            TYPE_TRANSFER,
    source:          null,
    payee:           `Transfer: ${raw.fromAccountName} → ${raw.toAccountName}`,
    categoryName:    "Transfer",
    fromAccountName: raw.fromAccountName.trim(),
    toAccountName:   raw.toAccountName.trim(),
    accountName:     null,
    amountCents:     toCents(raw.amount),
    date:            raw.date,
    month:           raw.month,
  };
}

/**
 * Builds a TransactionIntent for a liability payment (cash repays a debt).
 *
 * @param {{
 *   liabilityAccountName: string,
 *   amount:               number,
 *   date:                 string,
 *   month:                string,
 * }} raw
 * @returns {TransactionIntent}
 */
export function buildLiabilityPaymentIntent(raw) {
  _requireString(raw.liabilityAccountName, "liabilityAccountName");
  _requireDate(raw.date,                   "date");
  _requireMonth(raw.month,                 "month");
  _requirePositiveAmount(raw.amount,       "amount");

  return {
    type:                 TYPE_LIABILITY_PAYMENT,
    source:               SOURCE_AVAILABLE,   // cash out of available balance
    payee:                `Payment to ${raw.liabilityAccountName}`,
    categoryName:         null,
    accountName:          raw.liabilityAccountName.trim(),
    amountCents:          toCents(raw.amount),
    date:                 raw.date,
    month:                raw.month,
  };
}

// ---------------------------------------------------------------------------
// Private validators
// ---------------------------------------------------------------------------

function _requireString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new IntentValidationError(`${field} must be a non-empty string`, field);
  }
}

function _requirePositiveAmount(value, field) {
  if (typeof value !== "number" || !isFinite(value) || value <= 0) {
    throw new IntentValidationError(`${field} must be a positive number`, field);
  }
}

function _requireDate(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new IntentValidationError(
      `${field} must be a date string in YYYY-MM-DD format`,
      field
    );
  }
}

function _requireMonth(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) {
    throw new IntentValidationError(
      `${field} must be a month string in YYYY-MM format`,
      field
    );
  }
}

function _validateSource(source) {
  const valid = [SOURCE_ASSET, SOURCE_LIABILITY, SOURCE_AVAILABLE];
  if (!valid.includes(source)) {
    throw new IntentValidationError(
      `source must be one of: ${valid.join(", ")}`,
      "source"
    );
  }
}

// ---------------------------------------------------------------------------
// JSDoc typedef (for editor tooling only — not runtime)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TransactionIntent
 * @property {string}      type            — TYPE_EXPENSE | TYPE_INCOME | TYPE_TRANSFER | TYPE_LIABILITY_PAYMENT
 * @property {string|null} source          — SOURCE_ASSET | SOURCE_LIABILITY | SOURCE_AVAILABLE | null
 * @property {string}      payee
 * @property {string|null} categoryName
 * @property {string|null} accountName     — primary account affected (asset/liability)
 * @property {string} [fromAccountName]    — only on TYPE_TRANSFER
 * @property {string} [toAccountName]      — only on TYPE_TRANSFER
 * @property {number}      amountCents     — positive integer cents
 * @property {string}      date            — YYYY-MM-DD
 * @property {string}      month           — YYYY-MM
 */
