/**
 * tests/unit/_budgetServiceCJS.js
 *
 * CJS shim that loads budgetMutationService.js (ES module) and
 * transactionTypes.js into a single Node-compatible module.
 *
 * Used only by test files — never imported by production code.
 * The underscore prefix signals it's a test helper.
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const vm   = require("vm");

function stripESM(src) {
  // Remove multiline import blocks: import { ... } from "...";
  src = src.replace(/^import\s*\{[^}]*\}\s*from\s*['"'][^'"]*['"'];?/gms, "");
  // Remove single-line imports
  src = src.replace(/^import\s+.*$/gm, "");
  // Remove closing brace + from lines left over from multiline imports
  src = src.replace(/^\s*\}\s*from\s*['"][^'"]*['"];?\s*$/gm, "");
  // Remove export keyword prefix from declarations only
  src = src.replace(/^export (const|function|class|async function)/gm, "$1");
  return src;
}

function toCents(f)   { return Math.round(f * 100); }
function fromCents(c) { return c / 100; }

const TYPES_PATH = path.join(__dirname, "../../services/transactions/transactionTypes.js");
const BMS_PATH   = path.join(__dirname, "../../services/budgets/budgetMutationService.js");

const typesSrc = stripESM(fs.readFileSync(TYPES_PATH, "utf-8"));
const bmsSrc   = stripESM(fs.readFileSync(BMS_PATH,   "utf-8"));

// Run in a vm context so we can inject dependencies cleanly
// without template-literal escaping issues
const sandbox = {
  toCents,
  fromCents,
  exports: {},
};

vm.createContext(sandbox);
vm.runInContext(typesSrc, sandbox);
vm.runInContext(bmsSrc,   sandbox);

module.exports = {
  computeBudgetDelta:      sandbox.computeBudgetDelta,
  applyBudgetDeltaToMonth: sandbox.applyBudgetDeltaToMonth,
};
