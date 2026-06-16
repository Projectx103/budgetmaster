/**
 * scripts/migration/backfillSummaries.js
 *
 * Phase 0 migration utility — additive, zero-destructive.
 *
 * PURPOSE
 * -------
 * Not every month document in Firestore has an `availableBalance` field.
 * The field is only written by `renderBudget()` the first time the user
 * views that month after that code path was added.  Older months (and months
 * on accounts that haven't been navigated to recently) have availableBalance
 * = undefined / null.
 *
 * Phase 6 of the refactor makes `availableBalance` the primary source of
 * truth (instead of recomputing it from scratch on every render).  Before
 * that can happen, every existing month doc must have a correct value.
 *
 * This script computes `availableBalance` using the EXACT same formula as
 * `renderBudget()` in script.js (lines 421-515) — so the result is byte-
 * identical to what `renderBudget()` would write on the user's next visit.
 *
 * It writes `availableBalance` using `{merge: true}` so it never clobbers
 * any other field, and it skips months that already have a non-null value
 * (idempotent).
 *
 * USAGE
 * -----
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json \
 *   node scripts/migration/backfillSummaries.js \
 *     --uids uid1,uid2 \         # Comma-separated UIDs, or omit to process ALL users
 *     --project budget-monitoringv2 \
 *     --dryRun                   # Print what would be written without writing
 *
 * DRY RUN (safe default)
 * ----------------------
 * When --dryRun is present, no writes occur — only the computed values and
 * which documents would be updated are logged.  Always run --dryRun first.
 *
 * WHAT IT COMPUTES
 * ----------------
 * Mirrors renderBudget(data) (script.js lines 421-516):
 *
 *   accountOutflow       = sum of outflow for Deposit/Withdrawal/Transfer category txns
 *                        + sum of outflow for isLiabilityPayment txns
 *                        (excluding fromAsset and fromLiability txns)
 *
 *   assetFundedSpent     = sum of amount for fromAsset expense txns
 *   liabilityFundedSpent = sum of amount for fromLiability expense txns
 *
 *   totalIncome          = sum of (amount || inflow) for income-type txns
 *                          (excluding fromAsset, fromLiability)
 *
 *   totalSpentForBalance = (categories.reduce spent) - assetFundedSpent
 *                          - liabilityFundedSpent + accountOutflow
 *
 *   availableBalance     = totalIncome - totalSpentForBalance
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Core formula — mirrors renderBudget() arithmetic exactly
// ---------------------------------------------------------------------------

/**
 * Compute availableBalance for a month document using the exact renderBudget formula.
 *
 * @param {object} monthData - Raw Firestore month document data.
 * @returns {number}         - The computed available balance.
 */
function computeAvailableBalance(monthData) {
  const categories   = monthData.categories   || [];
  const transactions = monthData.transactions || [];

  // Sum of all categories' spent
  const spent = categories.reduce((sum, c) => sum + (c.spent || 0), 0);

  // --- accountOutflow (lines 435-448 of script.js) ---
  let accountOutflow = 0;
  transactions.forEach((t) => {
    if (t.fromAsset)    return; // excluded
    if (t.fromLiability) return; // excluded

    const isAccountTransaction =
      t.category === "Deposit" ||
      t.category === "Withdrawal" ||
      t.category === "Transfer";

    if (t.outflow && t.outflow > 0 && isAccountTransaction) {
      accountOutflow += t.outflow;
    }
    if (t.isLiabilityPayment && t.outflow && t.outflow > 0) {
      accountOutflow += t.outflow;
    }
  });

  // --- assetFundedSpent (lines 468-473) ---
  let assetFundedSpent = 0;
  transactions.forEach((t) => {
    if (t.fromAsset && t.type === "expense" && t.amount > 0) {
      assetFundedSpent += t.amount;
    }
  });

  // --- liabilityFundedSpent (lines 478-483) ---
  let liabilityFundedSpent = 0;
  transactions.forEach((t) => {
    if (t.fromLiability && t.type === "expense" && t.amount > 0) {
      liabilityFundedSpent += t.amount;
    }
  });

  // --- totalIncome (lines 493-501) ---
  let totalIncome = 0;
  transactions.forEach((t) => {
    if (t.fromAsset)    return;
    if (t.fromLiability) return;
    if (t.type === "income" || (t.inflow && t.inflow > 0)) {
      totalIncome += t.amount || t.inflow || 0;
    }
  });

  // --- totalSpentForBalance (line 491) ---
  const totalSpentForBalance =
    (spent - assetFundedSpent - liabilityFundedSpent) + accountOutflow;

  // --- availableBalance (line 504) ---
  return totalIncome - totalSpentForBalance;
}

// ---------------------------------------------------------------------------
// Per-user backfill
// ---------------------------------------------------------------------------

/**
 * Backfill `availableBalance` for every month document of one user.
 *
 * @param {object}  db          - Firestore admin instance.
 * @param {string}  uid
 * @param {boolean} dryRun      - When true, no writes.
 * @param {object}  [logger]    - Object with .log() and .warn() (defaults to console).
 * @returns {Promise<{ processed: number, written: number, skipped: number }>}
 */
async function backfillUser(db, uid, dryRun = true, logger = console) {
  const budgetRef = db.collection("budget").doc(uid);
  const monthsSnap = await budgetRef.collection("months").get();

  let processed = 0;
  let written   = 0;
  let skipped   = 0;

  for (const doc of monthsSnap.docs) {
    processed++;
    const data = doc.data();

    if (data.availableBalance != null && typeof data.availableBalance === "number") {
      // Already populated — skip (idempotent).
      skipped++;
      logger.log(
        `  [${uid}] ${doc.id} — SKIP (availableBalance already set: ${data.availableBalance})`
      );
      continue;
    }

    const computed = computeAvailableBalance(data);

    if (dryRun) {
      logger.log(
        `  [${uid}] ${doc.id} — DRY RUN would set availableBalance = ${computed}`
      );
    } else {
      await doc.ref.set({ availableBalance: computed }, { merge: true });
      written++;
      logger.log(
        `  [${uid}] ${doc.id} — WRITTEN availableBalance = ${computed}`
      );
    }
  }

  return { processed, written, skipped };
}

// ---------------------------------------------------------------------------
// Batch runner over multiple UIDs (or all users)
// ---------------------------------------------------------------------------

/**
 * Backfill all given UIDs, or every user in the budget collection if
 * `uids` is empty/falsy.
 *
 * @param {object}   db
 * @param {string[]} uids    - Specific UIDs to process.  If empty, process all.
 * @param {boolean}  dryRun
 * @param {object}   logger
 */
async function backfillAll(db, uids = [], dryRun = true, logger = console) {
  let targetUids = uids;

  if (!targetUids || targetUids.length === 0) {
    logger.log("No UIDs specified — fetching all users from budget collection…");
    const allBudgets = await db.collection("budget").get();
    targetUids = allBudgets.docs.map((d) => d.id);
    logger.log(`Found ${targetUids.length} user(s).`);
  }

  const results = {};
  let totalProcessed = 0;
  let totalWritten   = 0;
  let totalSkipped   = 0;

  for (const uid of targetUids) {
    logger.log(`\n--- Backfilling uid: ${uid} ---`);
    const r = await backfillUser(db, uid, dryRun, logger);
    results[uid] = r;
    totalProcessed += r.processed;
    totalWritten   += r.written;
    totalSkipped   += r.skipped;
  }

  logger.log(`\n========================================`);
  logger.log(`Backfill ${dryRun ? "(DRY RUN) " : ""}complete.`);
  logger.log(`Users:     ${targetUids.length}`);
  logger.log(`Month docs processed: ${totalProcessed}`);
  logger.log(`Written:  ${totalWritten}`);
  logger.log(`Skipped:  ${totalSkipped}`);

  return results;
}

// ---------------------------------------------------------------------------
// Verification helper — run after backfill to confirm values match formula
// ---------------------------------------------------------------------------

/**
 * After a real backfill run, verify that every month doc's stored
 * `availableBalance` matches the formula's output.  Returns an array
 * of discrepancy objects (empty = all good).
 *
 * @param {object}  db
 * @param {string}  uid
 * @returns {Promise<{ monthKey: string, stored: number, computed: number }[]>}
 */
async function verifyBackfill(db, uid) {
  const budgetRef  = db.collection("budget").doc(uid);
  const monthsSnap = await budgetRef.collection("months").get();
  const discrepancies = [];

  for (const doc of monthsSnap.docs) {
    const data     = doc.data();
    const stored   = data.availableBalance;
    const computed = computeAvailableBalance(data);

    // Allow a tiny floating-point epsilon (< $0.001)
    if (typeof stored !== "number" || Math.abs(stored - computed) > 0.001) {
      discrepancies.push({
        monthKey: doc.id,
        stored,
        computed,
        delta: computed - (stored ?? 0),
      });
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function runCLI(argv) {
  let admin;
  try {
    admin = require("firebase-admin");
  } catch {
    console.error("firebase-admin is not installed. Run: npm install firebase-admin");
    process.exit(1);
  }

  const args   = _parseArgs(argv.slice(2));
  const uids   = args.uids ? args.uids.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const dryRun = "dryRun" in args;

  if (!admin.apps.length) {
    admin.initializeApp({ projectId: args.project || "budget-monitoringv2" });
  }

  const db = admin.firestore();

  if (dryRun) {
    console.log("=== DRY RUN — no writes will occur ===\n");
  }

  await backfillAll(db, uids, dryRun);

  if (!dryRun && uids.length > 0) {
    console.log("\n=== Running verification pass ===");
    for (const uid of uids) {
      const issues = await verifyBackfill(db, uid);
      if (issues.length === 0) {
        console.log(`  ✅ ${uid} — all month docs verified`);
      } else {
        console.warn(`  ❌ ${uid} — ${issues.length} discrepancies:`);
        issues.forEach((d) =>
          console.warn(`     ${d.monthKey}: stored=${d.stored}, computed=${d.computed}, delta=${d.delta}`)
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function _parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
      if (out[argv[i].slice(2)] !== true) i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    computeAvailableBalance,   // exported for unit tests
    backfillUser,
    backfillAll,
    verifyBackfill,
  };
}

if (require.main === module) {
  runCLI(process.argv).catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
