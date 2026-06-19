/**
 * helpers/currency.js
 *
 * Single source of truth for currency formatting.
 *
 * Extracted from script.js, which has 4 byte-identical inline copies of this
 * function (lines 210, 1600, 2356, 4212).  All four are identical in logic;
 * this module replaces them all.  Phase 9 will delete the inline copies and
 * import from here.
 *
 * The function is intentionally kept as a pure function with an explicit
 * `currency` parameter (instead of closing over the global `userCurrency`)
 * so it is testable in Node.js without a DOM and without a Firebase session.
 *
 * Callers in script.js currently read the global `userCurrency`.  During the
 * transition period (Phases 0-8), the wrapper `formatCurrencyGlobal` below
 * provides a drop-in replacement that reads the global — import it when you
 * cannot thread the currency argument through a call stack.
 */

// ---------------------------------------------------------------------------
// Core symbol table — must match the object literal in every inline copy.
// ---------------------------------------------------------------------------
const CURRENCY_SYMBOLS = {
  USD: "$",
  PHP: "₱",
  EUR: "€",
  JPY: "¥",
};

/**
 * Format an amount as a currency string.
 *
 * @param {number} amount     - The numeric value to format.
 * @param {boolean} isOutflow - When true, prefixes the result with "-".
 * @param {string} currency   - ISO 4217 code, e.g. "USD", "PHP".
 *                              Defaults to "USD" when unknown (matches old `|| "$"` fallback).
 * @returns {string}          - Formatted string, or "" when amount is NaN.
 *
 * Matches the existing inline logic byte-for-byte:
 *   if (isNaN(amount)) return "";
 *   symbol = currencySymbols[userCurrency] || "$"
 *   Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
 *   Math.abs(amount) — negatives are represented via isOutflow, never a bare minus
 *   isOutflow ? `-${symbol}${formattedAmount}` : `${symbol}${formattedAmount}`
 */
function formatCurrency(amount, isOutflow = false, currency) {
  // When currency not explicitly passed, read from global userCurrency (set by script.js)
  // Falls back to USD if neither is available (e.g. Node/test environment)
  if (currency === undefined) {
    currency = (typeof window !== "undefined" && window.userCurrency) ||
               (typeof userCurrency !== "undefined" && userCurrency) ||
               "USD";
  }
  if (isNaN(amount)) return "";

  const symbol = CURRENCY_SYMBOLS[currency] || "$";

  const formatter = new Intl.NumberFormat("en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const formattedAmount = formatter.format(Math.abs(amount));

  if (isOutflow) {
    return `-${symbol}${formattedAmount}`;
  }

  return `${symbol}${formattedAmount}`;
}

/**
 * Drop-in replacement for script.js callers that close over the global
 * `userCurrency`.  Reads `window.userCurrency` (browser) or falls back to
 * "USD" (Node/test environments).
 *
 * Usage in script.js during transition:
 *   // Old: formatCurrency(amount, isOutflow)
 *   // New: formatCurrencyGlobal(amount, isOutflow)
 */
function formatCurrencyGlobal(amount, isOutflow = false) {
  const currency =
    (typeof window !== "undefined" && window.userCurrency) ||
    (typeof userCurrency !== "undefined" && userCurrency) ||
    "USD";
  return formatCurrency(amount, isOutflow, currency);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
// CommonJS (Node / test runner)
if (typeof module !== "undefined" && module.exports) {
  module.exports = { formatCurrency, formatCurrencyGlobal, CURRENCY_SYMBOLS };
}

// ES Module browsers / bundlers — uncomment if you add a build step:
// export { formatCurrency, formatCurrencyGlobal, CURRENCY_SYMBOLS };
