/**
 * tests/unit/phase9_formatCurrency.test.js
 *
 * Phase 9 — Verify that helpers/currency.js is the single source of truth
 * and that its output is byte-identical to the 4 inline copies that were
 * removed from script.js.
 *
 * The inline copies all closed over `userCurrency` (a global).
 * helpers/currency.js exposes:
 *   - formatCurrency(amount, isOutflow, currency)   — pure, takes explicit currency
 *   - formatCurrencyGlobal(amount, isOutflow)        — reads window.userCurrency / global
 *
 * These tests confirm:
 *   1. formatCurrency output is byte-identical to the removed inline logic
 *   2. formatCurrencyGlobal reads the global correctly
 *   3. No duplicate formatCurrency definitions remain in script.js
 */

"use strict";

const {
  formatCurrency,
  formatCurrencyGlobal,
  CURRENCY_SYMBOLS,
} = require("../../helpers/currency");

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Reference: literal copy of the inline logic that was in script.js
// (used to prove byte-identical output)
// ---------------------------------------------------------------------------
function inlineFormatCurrency(amount, isOutflow = false, userCurrency = "USD") {
  if (isNaN(amount)) return "";
  const currencySymbols = { USD: "$", PHP: "₱", EUR: "€", JPY: "¥" };
  const symbol = currencySymbols[userCurrency] || "$";
  const formatter = new Intl.NumberFormat("en", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const formattedAmount = formatter.format(Math.abs(amount));
  if (isOutflow) return `-${symbol}${formattedAmount}`;
  return `${symbol}${formattedAmount}`;
}

// ---------------------------------------------------------------------------
// 1. Byte-identical output vs inline reference
// ---------------------------------------------------------------------------

describe("Phase 9: formatCurrency output matches removed inline copies", () => {
  const cases = [
    [0,       false, "USD"],
    [0,       true,  "PHP"],
    [100,     false, "USD"],
    [100,     true,  "USD"],
    [1234.56, false, "EUR"],
    [1234.56, true,  "JPY"],
    [0.01,    false, "PHP"],
    [99999.99,true,  "USD"],
    [NaN,     false, "USD"],
    [NaN,     true,  "PHP"],
    [-50,     false, "USD"],   // negative: Math.abs applied
    [-50,     true,  "USD"],
  ];

  test.each(cases)(
    "amount=%s isOutflow=%s currency=%s",
    (amount, isOutflow, currency) => {
      expect(formatCurrency(amount, isOutflow, currency))
        .toBe(inlineFormatCurrency(amount, isOutflow, currency));
    }
  );
});

// ---------------------------------------------------------------------------
// 2. No duplicate formatCurrency definitions in script.js
// ---------------------------------------------------------------------------

describe("Phase 9: script.js contains zero formatCurrency definitions", () => {
  let scriptContent;

  beforeAll(() => {
    const scriptPath = path.join(__dirname, "../../script.js");
    scriptContent = fs.readFileSync(scriptPath, "utf-8");
  });

  test("script.js has no 'function formatCurrency' definitions", () => {
    const matches = scriptContent.match(/^function formatCurrency\b/gm) || [];
    expect(matches.length).toBe(0);
  });

  test("script.js has no indented 'function formatCurrency' definitions", () => {
    const matches = scriptContent.match(/^\s+function formatCurrency\b/gm) || [];
    expect(matches.length).toBe(0);
  });

  test("script.js references helpers/currency.js in a comment", () => {
    expect(scriptContent).toContain("helpers/currency.js");
  });

  test("script.js still calls formatCurrency() in many places", () => {
    // Calls should still exist — only the definitions were removed
    const calls = scriptContent.match(/formatCurrency\(/g) || [];
    expect(calls.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// 3. formatCurrencyGlobal reads global userCurrency
// ---------------------------------------------------------------------------

describe("Phase 9: formatCurrencyGlobal reads global userCurrency", () => {
  const original = global.userCurrency;
  afterEach(() => { global.userCurrency = original; });

  test("uses PHP symbol when global is PHP", () => {
    global.userCurrency = "PHP";
    expect(formatCurrencyGlobal(500, false)).toBe("₱500.00");
  });

  test("uses EUR symbol when global is EUR", () => {
    global.userCurrency = "EUR";
    expect(formatCurrencyGlobal(100, true)).toBe("-€100.00");
  });

  test("falls back to USD when global is undefined", () => {
    global.userCurrency = undefined;
    expect(formatCurrencyGlobal(100, false)).toBe("$100.00");
  });

  test("matches inline reference with same currency", () => {
    global.userCurrency = "JPY";
    const amount = 9999.99;
    expect(formatCurrencyGlobal(amount, false))
      .toBe(inlineFormatCurrency(amount, false, "JPY"));
  });
});

// ---------------------------------------------------------------------------
// 4. CURRENCY_SYMBOLS matches what the inline copies had
// ---------------------------------------------------------------------------

describe("Phase 9: CURRENCY_SYMBOLS matches inline copies", () => {
  test("has exactly USD, PHP, EUR, JPY", () => {
    expect(CURRENCY_SYMBOLS).toEqual({
      USD: "$",
      PHP: "₱",
      EUR: "€",
      JPY: "¥",
    });
  });
});
