/**
 * services/months/monthService.js
 *
 * Pure helpers for month-document lifecycle.
 * Nothing in production calls these yet (Phase 1 is additive-only).
 *
 * These replace the repeated inline "load or create month doc" pattern
 * scattered throughout script.js (addIncome, addCategory, addTransaction,
 * saveAssigned, etc.) with a single, tested source of truth.
 *
 * Firestore is NOT imported here — callers pass snapshots / refs so this
 * file stays pure and testable without a live database.
 */

// ---------------------------------------------------------------------------
// buildEmptyMonth
// ---------------------------------------------------------------------------

/**
 * Creates a brand-new month document with zeroed-out state.
 *
 * When a month is first accessed (no Firestore snapshot exists), callers
 * need a starting state.  Previously each function did this inline with
 * slightly different shapes:
 *
 *   { categories: JSON.parse(JSON.stringify(data.categories || [])),
 *     transactions: [], tbb: data.tbb || 0, currentMonth: targetMonth }
 *
 * This function is the single canonical implementation.
 *
 * @param {Object}  options
 * @param {string}  options.monthKey        — YYYY-MM (e.g. "2025-06")
 * @param {Array}   [options.seedCategories=[]] — categories to copy forward
 *                    (passed in from the root doc when creating a fresh month)
 * @param {number}  [options.seedTbb=0]     — starting TBB (float pesos)
 * @returns {MonthDoc}
 */
function buildEmptyMonth({ monthKey, seedCategories = [], seedTbb = 0 } = {}) {
  if (!monthKey || typeof monthKey !== "string" || !/^\d{4}-\d{2}$/.test(monthKey)) {
    throw new Error(
      `buildEmptyMonth: monthKey must be a YYYY-MM string, got "${monthKey}"`
    );
  }

  if (!Array.isArray(seedCategories)) {
    throw new Error("buildEmptyMonth: seedCategories must be an array");
  }

  if (typeof seedTbb !== "number" || !isFinite(seedTbb)) {
    throw new Error("buildEmptyMonth: seedTbb must be a finite number");
  }

  // Deep-clone so callers can't mutate the seed array and corrupt this doc
  const categories = seedCategories.map(cat => ({
    name:     cat.name,
    assigned: cat.assigned || 0,
    spent:    cat.spent    || 0,
    balance:  (cat.assigned || 0) - (cat.spent || 0),
    // Preserve any extra fields (e.g. monthly history, custom colors)
    ..._omit(cat, ["name", "assigned", "spent", "balance"]),
  }));

  return {
    currentMonth: monthKey,
    tbb:          seedTbb,
    categories,
    transactions: [],
  };
}

// ---------------------------------------------------------------------------
// ensureMonthExists
// ---------------------------------------------------------------------------

/**
 * Returns a valid month-doc object, creating an empty one if needed.
 *
 * This is the replacement for the pattern:
 *
 *   const monthSnap = await monthDocRef.get();
 *   let monthData = monthSnap.exists
 *     ? monthSnap.data()
 *     : { categories: ..., transactions: [], tbb: ..., currentMonth: targetMonth };
 *
 * In Phase 1 we keep this pure (no Firestore calls).  Callers pass in the
 * already-fetched `monthSnap` and `rootData`; we return the resolved doc.
 *
 * @param {Object}  options
 * @param {Object|null} options.existingData
 *   — monthSnap.data() if monthSnap.exists, else null
 * @param {string}  options.monthKey   — YYYY-MM
 * @param {Array}   [options.rootCategories=[]]
 *   — root-doc categories to seed with when creating fresh
 * @param {number}  [options.rootTbb=0]
 *   — root-doc TBB to seed with when creating fresh
 * @returns {MonthDoc}
 */
function ensureMonthExists({
  existingData,
  monthKey,
  rootCategories = [],
  rootTbb = 0,
} = {}) {
  if (existingData !== null && existingData !== undefined) {
    // Month already exists — return as-is (shallow clone to signal "safe to mutate")
    return { ...existingData };
  }

  // Month is new — build from seed
  return buildEmptyMonth({
    monthKey,
    seedCategories: rootCategories,
    seedTbb:        rootTbb,
  });
}

// ---------------------------------------------------------------------------
// getNextMonthKey
// ---------------------------------------------------------------------------

/**
 * Computes the YYYY-MM key for the month following the given one.
 *
 * Mirrors the inline calculation in performRollover():
 *   const [year, month] = baseMonthKey.split("-").map(Number);
 *   const nextMonthDate = new Date(year, month - 1, 1);
 *   nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
 *   const nextMonthKey = `${nextMonthDate.getFullYear()}-${...}`;
 *
 * @param {string} monthKey   — YYYY-MM
 * @returns {string}          — YYYY-MM
 */
function getNextMonthKey(monthKey) {
  _requireMonthKey(monthKey, "getNextMonthKey");

  const [year, month] = monthKey.split("-").map(Number);
  // Using Date for correct year-wrap (Dec → Jan)
  const next = new Date(year, month - 1, 1);
  next.setMonth(next.getMonth() + 1);

  const y = next.getFullYear();
  const m = String(next.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// getPreviousMonthKey
// ---------------------------------------------------------------------------

/**
 * Computes the YYYY-MM key for the month preceding the given one.
 *
 * @param {string} monthKey   — YYYY-MM
 * @returns {string}          — YYYY-MM
 */
function getPreviousMonthKey(monthKey) {
  _requireMonthKey(monthKey, "getPreviousMonthKey");

  const [year, month] = monthKey.split("-").map(Number);
  const prev = new Date(year, month - 1, 1);
  prev.setMonth(prev.getMonth() - 1);

  const y = prev.getFullYear();
  const m = String(prev.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ---------------------------------------------------------------------------
// monthKeyFromDate
// ---------------------------------------------------------------------------

/**
 * Extracts the YYYY-MM key from a YYYY-MM-DD date string.
 *
 * @param {string} dateStr   — YYYY-MM-DD
 * @returns {string}         — YYYY-MM
 */
function monthKeyFromDate(dateStr) {
  if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(
      `monthKeyFromDate: expected YYYY-MM-DD, got "${dateStr}"`
    );
  }
  return dateStr.slice(0, 7);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function _requireMonthKey(value, fnName) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) {
    throw new Error(`${fnName}: monthKey must be YYYY-MM, got "${value}"`);
  }
}

/**
 * Returns a shallow copy of `obj` without the listed keys.
 * Used to strip known fields before spreading "extra" fields.
 *
 * @param {Object}   obj
 * @param {string[]} keys
 * @returns {Object}
 */
function _omit(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj)) {
    if (!keys.includes(k)) out[k] = obj[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSDoc typedef
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} MonthDoc
 * @property {string}   currentMonth   — YYYY-MM
 * @property {number}   tbb            — To Be Budgeted (float pesos)
 * @property {Array}    categories     — budget categories for this month
 * @property {Array}    transactions   — transactions recorded in this month
 */
