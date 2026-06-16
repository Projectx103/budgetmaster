/**
 * scripts/migration/snapshotProduction.js
 *
 * Phase 0 verification baseline.
 *
 * Run this against 5-10 representative staging/test accounts BEFORE any
 * production code changes.  The output JSON files in tests/fixtures/golden/
 * become the ground truth that every subsequent phase diffs against.
 *
 * What is captured
 * ----------------
 *   accounts[]              — name + balance (the fields that move during transactions)
 *   months[YYYY-MM]         — tbb, availableBalance, categories[], transactionCount,
 *                             transactionIds[] (sorted)
 *   goals[]                 — id + currentAmount
 *   reportAggregates        — spending totals and income/expense totals, computed
 *                             using the CURRENT script.js formula logic so that
 *                             any phase that changes report output is caught.
 *
 * Usage (Node.js, needs firebase-admin in your dev environment)
 * -------------------------------------------------------------
 *   GOOGLE_APPLICATION_CREDENTIALS=./serviceAccount.json \
 *   node scripts/migration/snapshotProduction.js \
 *     --uids uid1,uid2,uid3 \
 *     --project budget-monitoringv2 \
 *     --outDir tests/fixtures/golden
 *
 * Or from code:
 *   const { snapshotUser, snapshotAll } = require('./scripts/migration/snapshotProduction');
 *   const snap = await snapshotUser(db, 'uid123');
 *
 * Diff usage in later phases
 * --------------------------
 *   const { diffSnapshot } = require('./scripts/migration/snapshotProduction');
 *   const baseline = JSON.parse(fs.readFileSync('tests/fixtures/golden/uid123.json'));
 *   const current  = await snapshotUser(db, 'uid123');
 *   const diff     = diffSnapshot(baseline, current);
 *   if (diff.length) throw new Error('Snapshot diverged:\n' + JSON.stringify(diff, null, 2));
 *
 * All fields in the snapshot are plain numbers/strings — no Firestore types.
 */

"use strict";

const fs   = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Core snapshot function — matches the spec in REFACTOR_PLAN.md exactly
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic golden snapshot for one user.
 *
 * @param {FirebaseFirestore.Firestore} db  - Firestore admin instance.
 * @param {string}                      uid - User UID.
 * @returns {Promise<object>}               - Snapshot object (serialisable to JSON).
 */
async function snapshotUser(db, uid) {
  const budgetRef = db.collection("budget").doc(uid);

  const [rootSnap, monthsSnap, goalsSnap] = await Promise.all([
    budgetRef.get(),
    budgetRef.collection("months").get(),
    budgetRef.collection("goals").get(),
  ]);

  if (!rootSnap.exists) {
    throw new Error(`No budget document found for uid: ${uid}`);
  }

  const root = rootSnap.data();

  // --- accounts ---
  const accounts = (root.accounts || []).map((a) => ({
    name:    a.name,
    balance: a.balance,
  }));

  // --- months ---
  const months = Object.fromEntries(
    monthsSnap.docs.map((d) => {
      const data = d.data();
      const txns = data.transactions || [];
      return [
        d.id,
        {
          tbb:              data.tbb              ?? null,
          availableBalance: data.availableBalance ?? null,
          categories: (data.categories || []).map((c) => ({
            name:     c.name,
            assigned: c.assigned,
            spent:    c.spent,
            balance:  c.balance,
          })),
          transactionCount: txns.length,
          transactionIds:   txns.map((t) => t.id).filter(Boolean).sort(),
        },
      ];
    })
  );

  // --- goals ---
  const goals = goalsSnap.docs.map((g) => ({
    id:            g.id,
    currentAmount: g.data().currentAmount,
  }));

  // --- report aggregates --- (mirrors current script.js logic exactly)
  const reportAggregates = computeCurrentReportAggregates(monthsSnap.docs);

  return {
    uid,
    snapshotAt: new Date().toISOString(),
    accounts,
    months,
    goals,
    reportAggregates,
  };
}

// ---------------------------------------------------------------------------
// computeCurrentReportAggregates
// ---------------------------------------------------------------------------
// Replicates the exact arithmetic from script.js's report functions so that
// if the report logic changes the output changes too, and the golden diff
// catches it.
//
// Functions mirrored:
//   loadSpendingReport()         — category-level spending totals
//   getMonthlyIncomeExpense()    — per-month income / expense totals
//   getMonthlySpending()         — per-month spending totals (no deposits/withdrawals/transfers)
//   loadNetWorthReport()         — totalAssets, totalLiabilities (derived from accounts — left to caller to pass accounts or pass as part of snapshot args)
//
// NOTE: Net Worth is account-balance-derived, not transaction-derived.
//       We compute it from the snapshot's accounts[] field instead.
// ---------------------------------------------------------------------------

/**
 * @param {FirebaseFirestore.QueryDocumentSnapshot[]} monthDocs
 * @returns {object} reportAggregates
 */
function computeCurrentReportAggregates(monthDocs) {
  // Build a budgetData.months-like map (mirrors loadData() in script.js line 3010-3021)
  const monthsMap = {};
  monthDocs.forEach((doc) => {
    monthsMap[doc.id] = doc.data();
  });

  // --- Spending by category (mirrors loadSpendingReport, lines 3173-3193) ---
  const categoryTotals = {};
  let totalSpending = 0;

  Object.entries(monthsMap).forEach(([, monthData]) => {
    (monthData.transactions || []).forEach((t) => {
      const isAccountTransaction =
        t.category === "Deposit" ||
        t.category === "Withdrawal" ||
        t.category === "Transfer";

      if (t.type === "expense" && !isAccountTransaction) {
        const cat = t.category || "Uncategorized";
        categoryTotals[cat] = (categoryTotals[cat] || 0) + t.amount;
        totalSpending += t.amount;
      }
    });
  });

  // --- Monthly income / expense totals (mirrors getMonthlyIncomeExpense, lines 4086-4129) ---
  const monthlyIncome   = {};
  const monthlyExpenses = {};

  Object.entries(monthsMap).forEach(([monthKey, monthData]) => {
    let inc = 0;
    let exp = 0;
    (monthData.transactions || []).forEach((t) => {
      const isAccountTransaction =
        t.category === "Deposit" ||
        t.category === "Withdrawal" ||
        t.category === "Transfer";
      if (!isAccountTransaction) {
        if (t.type === "income")   inc += t.amount || 0;
        if (t.type === "expense")  exp += t.amount || 0;
      }
    });
    monthlyIncome[monthKey]   = inc;
    monthlyExpenses[monthKey] = exp;
  });

  const allIncome   = Object.values(monthlyIncome).reduce((a, b) => a + b, 0);
  const allExpenses = Object.values(monthlyExpenses).reduce((a, b) => a + b, 0);

  return {
    totalSpending,
    categoryTotals,           // { [categoryName]: number }
    totalIncome:  allIncome,
    totalExpenses: allExpenses,
    netIncome:    allIncome - allExpenses,
    monthlyIncome,            // { [YYYY-MM]: number }
    monthlyExpenses,          // { [YYYY-MM]: number }
  };
}

// ---------------------------------------------------------------------------
// Snapshot diffing
// ---------------------------------------------------------------------------

/**
 * Compare a baseline snapshot against a current snapshot.
 * Returns an array of difference descriptors.  Empty array = identical.
 *
 * Only fields that the refactor plan designates as "blocking failure" are
 * compared:
 *   accounts[].balance
 *   months[].tbb
 *   months[].availableBalance
 *   months[].categories[*].{assigned,spent,balance}
 *   months[].transactionIds (sorted — order-independent membership check)
 *   reportAggregates.totalSpending
 *   reportAggregates.totalIncome / totalExpenses / netIncome
 *   reportAggregates.categoryTotals[*]
 *   goals[].currentAmount
 *
 * transactionCount is informational (not a blocking diff by itself) and is
 * included in the diff output but does not increment the error count.
 *
 * @param {object} baseline - Golden snapshot from Phase 0.
 * @param {object} current  - Freshly computed snapshot.
 * @returns {{ path: string, baseline: *, current: *, blocking: boolean }[]}
 */
function diffSnapshot(baseline, current) {
  const diffs = [];

  function record(pathStr, bVal, cVal, blocking = true) {
    if (!_strictEqual(bVal, cVal)) {
      diffs.push({ path: pathStr, baseline: bVal, current: cVal, blocking });
    }
  }

  // --- accounts ---
  const bAccMap = _indexBy(baseline.accounts || [], "name");
  const cAccMap = _indexBy(current.accounts  || [], "name");
  const allAccNames = new Set([...Object.keys(bAccMap), ...Object.keys(cAccMap)]);
  allAccNames.forEach((name) => {
    const bAcc = bAccMap[name];
    const cAcc = cAccMap[name];
    if (!bAcc) { diffs.push({ path: `accounts["${name}"]`, baseline: undefined, current: cAcc, blocking: true }); return; }
    if (!cAcc) { diffs.push({ path: `accounts["${name}"]`, baseline: bAcc, current: undefined, blocking: true }); return; }
    record(`accounts["${name}"].balance`, bAcc.balance, cAcc.balance);
  });

  // --- months ---
  const allMonthKeys = new Set([
    ...Object.keys(baseline.months || {}),
    ...Object.keys(current.months  || {}),
  ]);
  allMonthKeys.forEach((mk) => {
    const bm = (baseline.months || {})[mk];
    const cm = (current.months  || {})[mk];
    if (!bm || !cm) {
      diffs.push({ path: `months["${mk}"]`, baseline: bm, current: cm, blocking: true });
      return;
    }

    record(`months["${mk}"].tbb`,              bm.tbb,              cm.tbb);
    record(`months["${mk}"].availableBalance`,  bm.availableBalance, cm.availableBalance);
    record(`months["${mk}"].transactionCount`,  bm.transactionCount, cm.transactionCount, false /* informational */);

    // transaction ids — set equality
    const bIds = new Set(bm.transactionIds || []);
    const cIds = new Set(cm.transactionIds || []);
    const missing = [...bIds].filter((id) => !cIds.has(id));
    const extra   = [...cIds].filter((id) => !bIds.has(id));
    if (missing.length || extra.length) {
      diffs.push({
        path: `months["${mk}"].transactionIds`,
        baseline: { count: bIds.size, missing, extra },
        current:  { count: cIds.size },
        blocking: true,
      });
    }

    // categories — by name
    const bCatMap = _indexBy(bm.categories || [], "name");
    const cCatMap = _indexBy(cm.categories || [], "name");
    const allCatNames = new Set([...Object.keys(bCatMap), ...Object.keys(cCatMap)]);
    allCatNames.forEach((cn) => {
      const bc = bCatMap[cn];
      const cc = cCatMap[cn];
      if (!bc || !cc) {
        diffs.push({ path: `months["${mk}"].categories["${cn}"]`, baseline: bc, current: cc, blocking: true });
        return;
      }
      ["assigned", "spent", "balance"].forEach((field) => {
        record(`months["${mk}"].categories["${cn}"].${field}`, bc[field], cc[field]);
      });
    });
  });

  // --- goals ---
  const bGoalMap = _indexBy(baseline.goals || [], "id");
  const cGoalMap = _indexBy(current.goals  || [], "id");
  const allGoalIds = new Set([...Object.keys(bGoalMap), ...Object.keys(cGoalMap)]);
  allGoalIds.forEach((id) => {
    const bg = bGoalMap[id];
    const cg = cGoalMap[id];
    if (!bg || !cg) {
      diffs.push({ path: `goals["${id}"]`, baseline: bg, current: cg, blocking: true });
      return;
    }
    record(`goals["${id}"].currentAmount`, bg.currentAmount, cg.currentAmount);
  });

  // --- reportAggregates ---
  const ba = baseline.reportAggregates || {};
  const ca = current.reportAggregates  || {};
  ["totalSpending", "totalIncome", "totalExpenses", "netIncome"].forEach((field) => {
    record(`reportAggregates.${field}`, ba[field], ca[field]);
  });
  const allCats = new Set([
    ...Object.keys(ba.categoryTotals || {}),
    ...Object.keys(ca.categoryTotals || {}),
  ]);
  allCats.forEach((cn) => {
    record(
      `reportAggregates.categoryTotals["${cn}"]`,
      (ba.categoryTotals || {})[cn],
      (ca.categoryTotals || {})[cn]
    );
  });

  return diffs;
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

async function runCLI(argv) {
  // Lazy-require firebase-admin so the module can be required in tests
  // without needing the admin SDK installed.
  let admin;
  try {
    admin = require("firebase-admin");
  } catch {
    console.error("firebase-admin is not installed. Run: npm install firebase-admin");
    process.exit(1);
  }

  const args  = _parseArgs(argv.slice(2));
  const uids  = (args.uids || "").split(",").map((s) => s.trim()).filter(Boolean);
  const outDir = args.outDir || "tests/fixtures/golden";

  if (uids.length === 0) {
    console.error("Usage: --uids uid1,uid2 [--project projectId] [--outDir path]");
    process.exit(1);
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      projectId: args.project || "budget-monitoringv2",
    });
  }
  const db = admin.firestore();

  fs.mkdirSync(outDir, { recursive: true });

  for (const uid of uids) {
    console.log(`Snapshotting uid: ${uid} …`);
    try {
      const snap = await snapshotUser(db, uid);
      const outPath = path.join(outDir, `${uid}.json`);
      fs.writeFileSync(outPath, JSON.stringify(snap, null, 2));
      console.log(`  ✅ Written: ${outPath}`);
    } catch (err) {
      console.error(`  ❌ Failed for ${uid}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function _indexBy(arr, key) {
  return Object.fromEntries((arr || []).map((item) => [item[key], item]));
}

function _strictEqual(a, b) {
  // Deep equality for primitives and plain objects (no Firestore types here).
  return JSON.stringify(a) === JSON.stringify(b);
}

function _parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1] || true;
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    snapshotUser,
    computeCurrentReportAggregates,
    diffSnapshot,
    // Exported for tests
    _indexBy,
    _strictEqual,
  };
}

// Run as CLI
if (require.main === module) {
  runCLI(process.argv).catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
