// ============================================
// BudgetMaster JavaScript
// Extracted from inline <script> blocks
// ============================================

// --- Boot Loader controller -------------------------------------------
// Keeps the full-page "B" loader visible from first paint until the
// real app data (budget/accounts/theme/etc.) has actually finished
// loading, so the user never sees a blank page after login/refresh.
const BootLoader = (function () {
  let hidden = false;
  let safetyTimer = null;

  function setStatus(text) {
    const el = document.getElementById("bmBootLoaderStatus");
    if (el && text) el.textContent = text;
  }

  function hide() {
    if (hidden) return; // idempotent — safe to call from multiple code paths
    hidden = true;
    if (safetyTimer) clearTimeout(safetyTimer);
    const el = document.getElementById("bmBootLoader");
    if (!el) return;
    el.classList.add("bm-boot-loader-hidden");
    // Remove from DOM after the fade-out transition finishes
    setTimeout(() => el.remove(), 500);
  }

  function init() {
    // Hard safety net: never let the loader hang forever if some
    // unexpected error skips past our normal hide() calls.
    safetyTimer = setTimeout(() => {
      console.warn("[BootLoader] Safety timeout reached — forcing hide.");
      hide();
    }, 12000);
  }

  return { setStatus, hide, init };
})();
BootLoader.init();

// --- Summary cards animation/interaction patch ---
(function(){
  const _origUpdate = window.updateSummary;
  const bmCardIds = ['tbb','assigned','remaining','spent','overspent'];

  function bmAnimateVal(el, target, duration){
    const isNeg = target < 0;
    const abs = Math.abs(target);
    const start = performance.now();
    const sym = isNeg ? '-' : '';
    const update = now => {
      const p = Math.min((now-start)/duration,1);
      const ease = 1-Math.pow(1-p,4);
      const cur = Math.round(abs*ease);
      el.textContent = sym + (window.formatCurrency ? window.formatCurrency(isNeg?-cur:cur) : '₱'+cur.toLocaleString());
      if(p<1) requestAnimationFrame(update);
    };
    requestAnimationFrame(update);
  }

  function bmRefreshBars(){
    const vals = bmCardIds.map(id=>{
      const el = document.getElementById(id);
      if(!el) return 0;
      const raw = el.textContent.replace(/[^0-9.\-]/g,'');
      return Math.abs(parseFloat(raw)||0);
    });
    const mx = Math.max(...vals,1);
    vals.forEach((v,i)=>{
      const bar = document.getElementById('bar-'+bmCardIds[i]);
      if(bar) setTimeout(()=>{ bar.style.width=(v/mx*100)+'%'; },300+i*60);
    });
  }

  const _origUpdateDashboard = window.updateDashboard;
  window.updateDashboard = function(){
    if(_origUpdateDashboard) _origUpdateDashboard.apply(this,arguments);
    setTimeout(bmRefreshBars,400);
  };

  const observer = new MutationObserver(()=>bmRefreshBars());
  bmCardIds.forEach(id=>{
    const el = document.getElementById(id);
    if(el) observer.observe(el,{characterData:true,subtree:true,childList:true});
  });

  document.querySelectorAll('.bm-sc').forEach(card=>{
    let sprinting;
    card.addEventListener('mouseenter',()=>{
      sprinting = setInterval(()=>{
        const sp = card.querySelector('.bm-spark-layer');
        if(!sp) return;
        const d=document.createElement('div');
        d.className='bm-sp';
        d.style.left=Math.random()*90+'%';
        d.style.top=Math.random()*80+'%';
        sp.appendChild(d);
        d.animate([
          {opacity:0,transform:'scale(0) translateY(0)'},
          {opacity:1,transform:'scale(1.8) translateY(-8px)',offset:0.4},
          {opacity:0,transform:'scale(0.5) translateY(-18px)'}
        ],{duration:700,easing:'ease-out'}).onfinish=()=>d.remove();
      },100);
    });
    card.addEventListener('mouseleave',()=>clearInterval(sprinting));
  });

  const tip = document.getElementById('bmGlobalTip');
  if(tip){
    document.querySelectorAll('.bm-sc').forEach(card=>{
      card.addEventListener('mouseenter',()=>{ tip.textContent=card.dataset.tip||''; tip.style.opacity='1'; });
      card.addEventListener('mousemove',e=>{ tip.style.left=(e.clientX+14)+'px'; tip.style.top=(e.clientY-38)+'px'; });
      card.addEventListener('mouseleave',()=>{ tip.style.opacity='0'; });
    });
  }
})();


// --- Main application logic (Firebase, budgeting, UI) ---
  // ==== Firebase Config ====
  const firebaseConfig = {
    apiKey: "AIzaSyA1txE-ewGSTwVrNk7gVz3z8yLeYTdwYwk",
    authDomain: "budget-monitoringv2.firebaseapp.com",
    projectId: "budget-monitoringv2",
    storageBucket: "budget-monitoringv2.firebasestorage.app",
    messagingSenderId: "539949688092",
    appId: "1:539949688092:web:0655e0318504c6a4e946d9",
    measurementId: "G-M8DLXRV0DW"
  };
  firebase.initializeApp(firebaseConfig);
  const auth = firebase.auth();
  const db = firebase.firestore();
  const logoutLink = document.querySelector('.logout-link');

  let currentUser = null;
  let accounts = []; // Will hold user accounts
  let editingIndex = null; // Track which account is being edited
  let transactionAccountIndex = null;
  let selectedCategoryIndex = null; // Currently selected category for modal
  let spendingChart, netWorthChart, incomeExpensesChart;
  let goals = [];
  let editingGoalId = null;
  let userSettings = {};
  let userCurrency = "Php";
  window.userCurrency = userCurrency; // expose to currency.js
  let lastRolloverDate = null; // Track last rollover to prevent multiple rollovers in same month

  // ==== Guard against stale page shown via browser back/forward (bfcache) ====
  // After logout, hitting the browser "back" button can restore index.html
  // from the bfcache as a frozen snapshot, without re-running auth checks.
  // This forces a fresh auth check (and reload) whenever that happens.
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      const user = firebase.auth().currentUser;
      if (!user) {
        window.location.replace("auth.html");
      } else {
        window.location.reload();
      }
    }
  });

// ==== Phase 2 Feature Flags ====
// Flip individual flags to false to instantly revert to the old inline path.
// All flags default OFF until the phase is verified on staging.
const FEATURE_FLAGS = {
  useEngineForIncome:          true,  // Phase 2 — set true after staging smoke test
  useEngineForCategoryAssign:  true,  // Phase 3 — set true after staging smoke test
  useEngineForExpense:         true,  // Phase 4 — set true after staging smoke test
  useEngineForAssignEdit:      true,  // Phase 5 — set true after staging smoke test
  useEngineForAccountTxn:      true,  // Phase 6 — set true after staging smoke test
  useEngineForDelete:          true,  // Phase 7 — set true after staging smoke test
  engineOwnsAvailableBalance:  true,  // Phase 8 — set true after staging smoke test
};

let currentSort = { column: 'date', direction: 'desc' };
let allTransactions = []; // Store all transactions for filtering
let filteredTransactions = []; // Store filtered results





  document.addEventListener("DOMContentLoaded", () => {
    const sidebarLinks = document.querySelectorAll(".sidebar a");
    const sections = document.querySelectorAll(".section");

    // Hide all sections first
    sections.forEach(s => s.style.display = "none");

    // Show Dashboard by default
    const defaultSection = document.querySelector("#dashboard");
    if (defaultSection) defaultSection.style.display = "block";

 sidebarLinks.forEach(link => {
  link.addEventListener("click", async (e) => { // ✅ Make async
    e.preventDefault();

    // ── Tour guard: block navigation while a tour is active ──────────────
    // The tour overlay blocks CSS clicks but the sidebar links are inside
    // it via z-index, so we guard here in JS as well.
    const _dashActive    = typeof DashboardTour    !== "undefined" && DashboardTour.isActive();
    const _accountsActive = typeof AccountsTour    !== "undefined" && AccountsTour.isActive();
    if (_dashActive || _accountsActive) {
      return; // silently block — the tour overlay visual already signals this
    }

    // Remove active class from all links
    sidebarLinks.forEach(l => l.classList.remove("active"));
    link.classList.add("active");

    // Hide all sections
    sections.forEach(s => s.style.display = "none");

    // Show the clicked section
    const targetId = link.getAttribute("href").substring(1); // remove #
    const targetSection = document.getElementById(targetId);
    if (targetSection) targetSection.style.display = "block";
    
    // ✅ Reload reports data when Reports section is opened
    if (targetId === "reports") {
      console.log("🔄 Reloading reports data...");
      await loadData(); // Refresh all report data
      console.log("✅ Reports reloaded");
    }

    // ✅ Load profile data when Settings section is opened
    if (targetId === "settings" && currentUser) {
      await loadProfileSection();
      // Also activate the profile tab by default
      const profileTab = document.querySelector('.settings-sidebar li[data-section="profileSection"]');
      if (profileTab) profileTab.click();
    }

    // Launch accounts tour on first visit to Accounts section
    if (targetId === "accounts" && currentUser && typeof AccountsTour !== "undefined") {
      setTimeout(() => AccountsTour.checkAndStart(), 400);
    }

    // Launch dashboard tour on first visit to Dashboard section
    if (targetId === "dashboard" && currentUser && typeof DashboardTour !== "undefined") {
      setTimeout(() => DashboardTour.checkAndStart(), 400);
    }
  });
});
  });








// ==== Render Functions ====

// Canonical category balance: carried-forward starting balance + assigned - spent.
// startingBalance is set by rollover (Cover carries a negative deficit forward;
// positive leftovers carry forward positive). Categories that never rolled over
// have no startingBalance, so it defaults to 0 and this reduces to assigned-spent.
function categoryBalance(c) {
  const starting = Number(c.startingBalance) || 0;
  const assigned = Number(c.assigned) || 0;
  const spent    = Number(c.spent) || 0;
  return starting + assigned - spent;
}

function renderCategories(categories) {
  const div = document.getElementById("categories");
  const select = document.getElementById("transactionCategory");
  div.innerHTML = "";
  select.innerHTML = "";

  categories.forEach((c, index) => {
    const balance = categoryBalance(c);
    const starting = Number(c.startingBalance) || 0;
    const monthLabel = c.month ? `<span class="pill">${c.month}</span>` : "";
    // Show a small note when a category started the month with a carried balance
    const startNote = starting !== 0
      ? `<div class="small" style="color:${starting < 0 ? '#ef4444' : '#10b981'};margin-top:2px;">
           ${starting < 0 ? 'Carried over' : 'Rolled in'}: ${formatCurrency(starting)}
         </div>`
      : "";

    div.innerHTML += `
      <div class="budget-item">
        <div class="item-header">
          <span class="font-bold">${c.name}</span>
          ${monthLabel}
        </div>
        <div class="amounts">
          <div>
            <div class="small">Assigned</div>
            <div>
              <span class="assigned-value" id="assigned-${index}" 
                onclick="editAssigned(${index}, ${c.assigned})">
                ${formatCurrency(c.assigned)}
              </span>
            </div>
          </div>
          <div>
            <div class="small">Spent</div>
            <div>${formatCurrency(c.spent)}</div>
          </div>
          <div>
            <div class="small">Balance</div>
            <div style="color:${balance < 0 ? 'red' : 'green'}">
              ${formatCurrency(balance)}
            </div>
            ${startNote}
          </div>
        </div>
      </div>
    `;

    select.innerHTML += `<option value="${c.name}">${c.name}</option>`;
  });
}

// formatCurrency is defined in helpers/currency.js (Phase 9 — single source of truth)
// All calls below use the global formatCurrency loaded from helpers/currency.js

function renderTransactions(transactions) {
  allTransactions = transactions; // Store for filtering
  filteredTransactions = [...transactions]; // Clone for filtering
  
  // Populate category filter dropdown
  populateCategoryFilter();
  
  // Apply filters and sort
  applyTransactionFilters();
}

function populateCategoryFilter() {
  const select = document.getElementById("filterCategory");
  const categories = [...new Set(allTransactions.map(t => t.category).filter(Boolean))];
  
  select.innerHTML = '<option value="">All Categories</option>';
  categories.sort().forEach(cat => {
    select.innerHTML += `<option value="${cat}">${cat}</option>`;
  });
}

function applyTransactionFilters() {
  const searchTerm = document.getElementById("searchTransactions")?.value.toLowerCase() || '';
  const categoryFilter = document.getElementById("filterCategory")?.value || '';
  const dateFrom = document.getElementById("filterDateFrom")?.value || '';
  const dateTo = document.getElementById("filterDateTo")?.value || '';
  
  // Filter transactions
  filteredTransactions = allTransactions.filter(t => {
    const matchesSearch = !searchTerm || 
      (t.name || '').toLowerCase().includes(searchTerm) ||
      (t.payee || '').toLowerCase().includes(searchTerm) ||
      (t.category || '').toLowerCase().includes(searchTerm);
    
    const matchesCategory = !categoryFilter || t.category === categoryFilter;
    
    const matchesDateFrom = !dateFrom || t.date >= dateFrom;
    const matchesDateTo = !dateTo || t.date <= dateTo;
    
    return matchesSearch && matchesCategory && matchesDateFrom && matchesDateTo;
  });
  
  // Sort transactions
  sortTransactionsArray();
  
  // Render filtered and sorted transactions
  renderTransactionsTable();
}

function sortTransactions(column) {
  if (currentSort.column === column) {
    currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
  } else {
    currentSort.column = column;
    currentSort.direction = 'desc';
  }
  
  // Update sort indicators
  document.querySelectorAll('.sort-indicator').forEach(el => el.textContent = '');
  const indicator = document.getElementById(`sort-${column}`);
  if (indicator) {
    indicator.textContent = currentSort.direction === 'asc' ? '▲' : '▼';
  }
  
  applyTransactionFilters();
}

function sortTransactionsArray() {
  filteredTransactions.sort((a, b) => {
    let aVal, bVal;
    
    switch(currentSort.column) {
      case 'date':
        aVal = new Date(a.date || 0);
        bVal = new Date(b.date || 0);
        break;
      case 'payee':
        aVal = (a.name || a.payee || '').toLowerCase();
        bVal = (b.name || b.payee || '').toLowerCase();
        break;
      case 'category':
        aVal = (a.category || '').toLowerCase();
        bVal = (b.category || '').toLowerCase();
        break;
      case 'outflow':
        aVal = (a.outflow || 0);
        bVal = (b.outflow || 0);
        break;
      case 'inflow':
        aVal = (a.inflow || 0);
        bVal = (b.inflow || 0);
        break;
      default:
        aVal = a.date;
        bVal = b.date;
    }
    
    if (aVal < bVal) return currentSort.direction === 'asc' ? -1 : 1;
    if (aVal > bVal) return currentSort.direction === 'asc' ? 1 : -1;
    return 0;
  });
}

function renderTransactionsTable() {
  const tbody = document.getElementById("transactionsBody");
  tbody.innerHTML = "";

  filteredTransactions.forEach(t => {
    let outflow = "";
    let inflow = "";

    if (typeof t.outflow === "number" && t.outflow > 0) {
      outflow = formatCurrency(t.outflow, true);
    }
    if (typeof t.inflow === "number" && t.inflow > 0) {
      inflow = formatCurrency(t.inflow, false);
    }

    if (t.type === "expense") {
      outflow = formatCurrency(t.amount, true);
    } else if (t.type === "income") {
      inflow = formatCurrency(t.amount, false);
    } else if (t.type === "transfer") {
      outflow = t.fromAccount ? formatCurrency(t.amount, true) : "";
      inflow = t.toAccount ? formatCurrency(t.amount, false) : "";
    }

    // --- Determine "Source" label ---
    let sourceLabel = "";
    let sourceBadgeClass = "txn-source-badge";

    if (t.isLiabilityPayment) {
      sourceLabel = `Payment from Available Balance`;
      sourceBadgeClass += " txn-source-available";
    } else if (t.fromLiability && t.fromAccount) {
      sourceLabel = `Charged to ${t.fromAccount}`;
      sourceBadgeClass += " txn-source-liability";
    } else if (t.fromAsset && t.fromAccount) {
      sourceLabel = `Deducted from ${t.fromAccount}`;
      sourceBadgeClass += " txn-source-asset";
    } else if (t.type === "transfer" && (t.fromAccount || t.toAccount)) {
      if (t.fromAccount && t.toAccount) {
        sourceLabel = `${t.fromAccount} → ${t.toAccount}`;
      } else if (t.fromAccount) {
        sourceLabel = `From ${t.fromAccount}`;
      } else {
        sourceLabel = `To ${t.toAccount}`;
      }
      sourceBadgeClass += " txn-source-transfer";
    } else if (t.type === "income") {
      sourceLabel = `Added to Available Balance`;
      sourceBadgeClass += " txn-source-available";
    } else {
      sourceLabel = `Deducted from Available Balance`;
      sourceBadgeClass += " txn-source-available";
    }

    tbody.innerHTML += `
      <tr>
        <td>${t.date ? t.date.slice(0, 10) : ""}</td>
        <td>${t.name || t.payee || ""}</td>
        <td>${t.category || ""}</td>
        <td class="amount-outflow">${outflow}</td>
        <td class="amount-inflow">${inflow}</td>
        <td><span class="${sourceBadgeClass}">${sourceLabel}</span></td>
      </tr>
    `;
  });
  
  // Show count
  if (filteredTransactions.length !== allTransactions.length) {
    console.log(`Showing ${filteredTransactions.length} of ${allTransactions.length} transactions`);
  }
}

function clearTransactionFilters() {
  document.getElementById("searchTransactions").value = '';
  document.getElementById("filterCategory").value = '';
  document.getElementById("filterDateFrom").value = '';
  document.getElementById("filterDateTo").value = '';
  
  currentSort = { column: 'date', direction: 'desc' };
  document.querySelectorAll('.sort-indicator').forEach(el => el.textContent = '');
  document.getElementById('sort-date').textContent = '▼';
  
  applyTransactionFilters();
}

async function renderBudget(data) {
  if (!data) return;
  const categories = data.categories || [];
  const transactions = data.transactions || [];
  const tbb = data.tbb || 0;
  const assigned = categories.reduce((sum, c) => sum + c.assigned, 0);
  const spent = categories.reduce((sum, c) => sum + c.spent, 0);
  
  // ✅ Calculate account outflows ONLY for non-category transactions (Deposit/Withdrawal/Transfer)
  // Expense transactions that hit a budget category are already counted in `spent` via categories[].spent
  // so we must NOT include them here to avoid double-deducting from Available Balance.
  // Transactions tagged fromAsset:true or fromLiability:true are also excluded — those expenses are
  // paid from an asset's own balance or charged to a liability, which are tracked separately.
  // Including them would incorrectly reduce Available Balance even though no budget money was spent.
  let accountOutflow = 0;
  transactions.forEach(t => {
    if (t.fromAsset) return;    // Asset-paid expenses never touch Available Balance
    if (t.fromLiability) return; // Liability-charged expenses never touch Available Balance
    const isAccountTransaction = t.category === 'Deposit' ||
                                 t.category === 'Withdrawal' ||
                                 t.category === 'Transfer';

    // Deposit: cash goes INTO account FROM budget → Available Balance decreases
    if (t.category === 'Deposit' && t.outflow && t.outflow > 0) {
      accountOutflow += t.outflow;
    }
    // Withdrawal: cash comes OUT of account BACK TO budget → Available Balance increases
    if (t.category === 'Withdrawal' && t.inflow && t.inflow > 0) {
      accountOutflow -= t.inflow;
    }
    // Transfer: money moves between accounts only — NO effect on Available Balance
    // Liability payments are real cash outflows from Available Balance
    if (t.isLiabilityPayment && t.outflow && t.outflow > 0) {
      accountOutflow += t.outflow;
    }
  });
  
  // ✅ Calculate account outflows EXCLUDING deposits (for Total Spent display)
  let actualSpendingOutflow = 0;
  transactions.forEach(t => {
    if (t.fromAsset) return; // ✅ Asset-paid expenses excluded from display spending too
    if (t.fromLiability) return; // ✅ Liability-charged expenses excluded from display spending too
    const isAccountTransaction = t.category === 'Deposit' || 
                                 t.category === 'Withdrawal' || 
                                 t.category === 'Transfer';
    
    if (t.outflow && t.outflow > 0 && !isAccountTransaction) {
      actualSpendingOutflow += t.outflow;
    }
  });

  // ✅ For the Available Balance formula, we also need to exclude fromAsset AND fromLiability expenses
  // from `spent` (categories[].spent) since those were funded by the asset/liability, not the budget.
  // We subtract them out here so they don't reduce the Available Balance.
  let assetFundedSpent = 0;
  transactions.forEach(t => {
    if (t.fromAsset && t.type === 'expense' && t.amount > 0) {
      assetFundedSpent += t.amount;
    }
  });

  // ✅ Liability-funded expenses (credit card charges) also must NOT reduce Available Balance.
  // The category[].spent is still updated for budgeting visibility, but the Available Balance
  // formula must offset it — the actual cash outflow only happens when the card is paid off.
  let liabilityFundedSpent = 0;
  transactions.forEach(t => {
    if (t.fromLiability && t.type === 'expense' && t.amount > 0) {
      liabilityFundedSpent += t.amount;
    }
  });
  
  // ✅ Total spent for DISPLAY — sum of ALL category spending regardless of payment source.
  // Asset-funded and liability-funded expenses DO update categories[].spent (correct — you spent
  // from that category), so they SHOULD appear in Total Spent. Only account-only transactions
  // (Deposit/Withdrawal/Transfer) that have no category impact are excluded.
  const totalSpentDisplay = spent;

  // ✅ Total spent for REMAINING BALANCE (Available Balance) calculation.
  // Asset-funded and liability-funded expenses must be EXCLUDED here because no budget money
  // actually left — the cash came from an account or was charged to a liability.
  // Available Balance only decreases when budget money (TBB pool) is spent.
  const totalSpentForBalance = (spent - assetFundedSpent - liabilityFundedSpent) + accountOutflow;
  
  // ✅ Calculate total income (inflows) — only real income transactions.
  // Withdrawals have type:"income" and inflow>0 in the legacy shape but they are NOT
  // real income — they move money out of the budget. Exclude them via category check.
  // Transfers also use inflow/outflow but are excluded via isAccountTransaction guard.
  let totalIncome = 0;
  transactions.forEach(t => {
    if (t.fromAsset) return;    // Asset transactions don't count as income
    if (t.fromLiability) return; // Liability transactions don't count as income
    const isAccountTransaction = t.category === 'Deposit' ||
                                 t.category === 'Withdrawal' ||
                                 t.category === 'Transfer';
    if (isAccountTransaction) return; // Deposits/Withdrawals/Transfers are not income
    if (t.isLiabilityPayment) return; // Liability payments are not income
    if (t.type === "income" || (t.inflow && t.inflow > 0)) {
      totalIncome += t.amount || t.inflow || 0;
    }
  });
  
  // ✅ Calculate remaining balance (Available Balance = income - non-asset spending)
  const remainingBalance = totalIncome - totalSpentForBalance;
  
// Save Available Balance to database.
  // Phase 8: when engineOwnsAvailableBalance is true, the engine already wrote
  // the correct value atomically — renderBudget's write is skipped to avoid
  // a stale async overwrite racing against the engine's fresh value.
  if (currentUser && !FEATURE_FLAGS.engineOwnsAvailableBalance) {
    const docRef = db.collection("budget").doc(currentUser.uid);
    const selectedMonth = availableMonths[currentMonthIndex] || data.currentMonth || new Date().toISOString().slice(0,7);
    const monthDocRef = docRef.collection("months").doc(selectedMonth);
    monthDocRef.set({
      availableBalance: remainingBalance
    }, { merge: true }).catch(err => console.error("Error saving Available Balance:", err));
  }







  const overspent = categories
    .filter(c => c.spent > c.assigned)
    .reduce((sum, c) => sum + (c.spent - c.assigned), 0);
  const tbbElement = document.getElementById("tbb");
  tbbElement.innerText = formatCurrency(tbb);
  
  tbbElement.style.background = 'none';
  tbbElement.style.padding = '0';
  tbbElement.style.borderRadius = '0';
  tbbElement.style.boxShadow = 'none';
  tbbElement.style.animation = 'none';
  
  if (tbb < 0) {
    tbbElement.style.color = '#e74c3c';
    tbbElement.style.fontWeight = '700';
    tbbElement.title = '⚠️ WARNING: You have over-budgeted!';
  } else if (tbb === 0) {
    tbbElement.style.color = 'var(--text)';
    tbbElement.style.fontWeight = '600';
    tbbElement.title = '✅ All money assigned';
  } else {
    tbbElement.style.color = '#16a085';
    tbbElement.style.fontWeight = '600';
    tbbElement.title = '💰 Money available to budget';
  }
  document.getElementById("assigned").innerText = formatCurrency(assigned);
  document.getElementById("spent").innerText = formatCurrency(totalSpentDisplay); // ✅ Uses version WITHOUT deposits
  document.getElementById("overspent").innerText = formatCurrency(overspent);
  
  // ✅ Update remaining balance with color coding
  const remainingElement = document.getElementById("remaining");
  remainingElement.innerText = formatCurrency(remainingBalance);
  remainingElement.style.background = 'none';
  remainingElement.style.padding = '0';
  remainingElement.style.borderRadius = '0';
  remainingElement.style.boxShadow = 'none';
  
  if (remainingBalance < 0) {
    remainingElement.style.color = '#e74c3c'; // Red for negative
    remainingElement.style.fontWeight = '700';
  } else if (remainingBalance === 0) {
    remainingElement.style.color = 'var(--text)'; // Normal for zero
    remainingElement.style.fontWeight = '600';
  } else {
    remainingElement.style.color = '#16a085'; // Green for positive
    remainingElement.style.fontWeight = '600';
  }
  renderCategories(categories);
  renderTransactions(transactions);
}


  // ==== Edit Assigned ====
  async function editAssigned(index, oldValue) {
    const span = document.getElementById(`assigned-${index}`);
    span.outerHTML = `
      <input type="number" id="assigned-input-${index}" value="${oldValue}" 
        style="width:80px; border:1px solid #ccc; border-radius:4px;" 
        onblur="saveAssigned(${index}, this.value)" 
        onkeydown="if(event.key==='Enter'){this.blur()}">
    `;
    document.getElementById(`assigned-input-${index}`).focus();
  }

async function saveAssigned(index, newValue) {
  if (!currentUser) return;

  // ── Validation (unchanged) ───────────────────────────────────────────────
  const val = parseFloat(newValue);
  if (isNaN(val) || val < 0) { showToast("Please enter a valid number.", "error"); return; }

  // ── Load root + month data (needed for both paths) ───────────────────────
  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  const data = docSnap.data() || {};

  const selectedMonth = availableMonths[currentMonthIndex] || data.currentMonth || new Date().toISOString().slice(0, 7);

  const monthDocRef = docRef.collection("months").doc(selectedMonth);
  const monthSnap  = await monthDocRef.get();
  let monthData    = monthSnap.exists
    ? monthSnap.data()
    : { categories: JSON.parse(JSON.stringify(data.categories || [])), transactions: [], tbb: data.tbb || 0, currentMonth: selectedMonth };

  if (!monthData.categories[index]) return;

  const oldValue = monthData.categories[index].assigned || 0;
  const diff     = val - oldValue;
  const newTBB   = monthData.tbb - diff;

  // No change — nothing to do
  if (diff === 0) { renderBudget(monthData); return; }

  // ── A3: Hard block on over-assignment ───────────────────────────────────
  // Assigning more than TBB = budgeting money you don't have. Hard stop.
  if (newTBB < 0 && diff > 0) {
    const maxCanAssign = (monthData.tbb || 0) + (oldValue || 0);
    showToast(
      `❌ Cannot assign ${formatCurrency(val)} — only ${formatCurrency(maxCanAssign)} available. ` +
      `Add more income first, or assign a smaller amount.`,
      "error"
    );
    renderBudget(monthData); // resets the input field
    return;
  }

  // ── Engine path (Phase 5) ────────────────────────────────────────────────
  if (FEATURE_FLAGS.useEngineForAssignEdit) {
    const categoryName = monthData.categories[index].name;
    // diff > 0 = assigning more money TO the category (TBB decreases)
    // diff < 0 = removing money FROM the category (TBB increases)
    const intentType   = diff > 0 ? "assign" : "unassign";
    const intentAmount = Math.abs(diff);  // engine always takes a positive amount

    try {
      await persistFinancialTransaction(
        {
          type:     intentType,
          amount:   intentAmount,
          date:     new Date().toISOString().slice(0, 10),
          monthKey: selectedMonth,
          category: categoryName,
          meta:     { isNewCategory: false },  // editing existing — never create placeholder
        },
        db,
        currentUser.uid
      );
      // Re-read the saved month to render accurate state
      const refreshed = await monthDocRef.get();
      renderBudget(refreshed.exists ? refreshed.data() : monthData);
    } catch (err) {
      console.error("[Phase 5] Engine saveAssigned error:", err);
      showToast("Failed to update budget. Please try again.", "error");
      renderBudget(monthData);
      return;
    }
  } else {
    // ── Legacy inline path (original code, untouched) ────────────────────
    monthData.categories[index].assigned = val;
    monthData.categories[index].balance  = (Number(monthData.categories[index].startingBalance) || 0) +
      val - monthData.categories[index].spent;
    monthData.tbb = newTBB;

    await monthDocRef.set(monthData);
    renderBudget(monthData);
  }

}

  // ==== Update Budget ====
 async function updateBudget(updates) {
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  const data = docSnap.data() || {};
  const currentMonth = data.currentMonth || new Date().toISOString().slice(0,7);

  const monthDocRef = docRef.collection("months").doc(currentMonth);
  const monthSnap = await monthDocRef.get();
  let monthData = monthSnap.exists ? monthSnap.data() : { ...data, categories: [], transactions: [], currentMonth };

  monthData = { ...monthData, ...updates };
  await monthDocRef.set(monthData);

  renderBudget(monthData);
}

// Load accounts automatically after login
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    await loadAccounts();
  }
}); 
// ==== Auth & Load Data ====
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    BootLoader.hide(); // not logged in — redirecting, no point showing the loader
    return window.location.href = "auth.html";
  }
  currentUser = user;

  try {
    BootLoader.setStatus("Checking your account…");
    const userDoc = await db.collection("users").doc(user.uid).get();
    const userData = userDoc.data();
    
    // ✅ Set global currency from user profile
    if (userDoc.exists && userData?.currency) {
      userCurrency = userData.currency;
      window.userCurrency = userCurrency; // keep in sync with currency.js
      //console.log("✅ Currency loaded:", userCurrency);
    } else {
      userCurrency = "USD";
      window.userCurrency = userCurrency;
      console.log("⚠️ No currency found, using default: USD");
    }
    
    if (userDoc.exists && userData?.approved === true) {
      document.getElementById("appSection").style.display = "block";
      BootLoader.setStatus("Loading your budget…");
      await loadAvailableMonths();
      await loadBudget();
      BootLoader.setStatus("Loading your accounts…");
      await loadAccounts();
      await loadRolloverSettings();
      await loadGoals();
      // A4: load category colors from Firestore and sync to localStorage
      if (typeof loadCatColorsFromFirestore === "function") {
        await loadCatColorsFromFirestore();
      }
      // A4: load theme from Firestore (currentUser is set here — safe to read)
      if (window.themeManager && typeof window.themeManager.loadThemeFromFirestore === "function") {
        await window.themeManager.loadThemeFromFirestore();
      }

      // Show onboarding wizard if this is a new user
      await Onboarding.checkAndShow();

      // Show accounts setup prompt if user has no accounts
      if (typeof AccountsPrompt !== "undefined") await AccountsPrompt.checkAndRender();

      // Run any due recurring rules (auto-create salary, rent, etc.)
      if (typeof Recurring !== "undefined") {
        try { await Recurring.runDueRules(); } catch (e) { console.warn("[Recurring] runDueRules:", e); }
      }

      // ✅ Everything the user needs to see is ready — reveal the app
      BootLoader.hide();

    } else {
      showToast("Your account is pending approval. Please contact the admin.", "error");
      BootLoader.hide(); // nothing more will load — don't leave the user staring at the loader
      await auth.signOut();
    }
  } catch (err) {
    console.error("Error fetching user:", err);
    BootLoader.hide(); // fail safe — never trap the user behind the loader on error
  }
});




  async function loadBudget() {
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  if (!docSnap.exists) {
    await docRef.set({ tbb: 0, categories: [], transactions: [], currentMonth: new Date().toISOString().slice(0, 7) });
  }

  const data = (await docRef.get()).data();

  const currentMonthKey = data.currentMonth || new Date().toISOString().slice(0, 7);

  // Check if month document exists
  const monthDocRef = docRef.collection("months").doc(currentMonthKey);
  const monthSnap = await monthDocRef.get();

  if (monthSnap.exists) {
    renderBudget(monthSnap.data());
  } else {
    renderBudget(data);
  }
}


async function addIncome() {
  // ── Read DOM inputs (unchanged) ──────────────────────────────────────────
  const amount      = parseFloat(document.getElementById("incomeAmount").value);
  const description = document.getElementById("incomeDescription").value.trim();
  const date        = document.getElementById("incomeDate").value || new Date().toISOString().slice(0, 10);
  const selectedMonth = availableMonths[currentMonthIndex] || null;

  // ── Validation (unchanged) ───────────────────────────────────────────────
  if (isNaN(amount) || amount <= 0) { showToast("Please enter a valid income amount.", "error"); return; }

  // ── Determine target month (unchanged) ──────────────────────────────────
  const docRef  = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  const data    = docSnap.data();
  const targetMonth = selectedMonth || data.currentMonth || new Date().toISOString().slice(0, 7);

  // ── Engine path (Phase 2) ────────────────────────────────────────────────
  if (FEATURE_FLAGS.useEngineForIncome) {
    try {
      await persistFinancialTransaction(
        {
          type:     "income",
          amount,
          date,
          monthKey: targetMonth,
          name:     description || "Income",
          category: "Income",
          meta:     {},
        },
        db,
        currentUser.uid
      );
    } catch (err) {
      console.error("[Phase 2] Engine income error:", err);
      showToast("Failed to save income. Please try again.", "error");
      return;
    }
  } else {
    // ── Legacy inline path (original code, untouched) ────────────────────
    const monthsRef   = docRef.collection("months");
    const monthDocRef = monthsRef.doc(targetMonth);
    const monthSnap   = await monthDocRef.get();
    let monthData     = monthSnap.exists
      ? monthSnap.data()
      : { categories: JSON.parse(JSON.stringify(data.categories || [])), transactions: [], tbb: data.tbb || 0, currentMonth: targetMonth };

    // Add income transaction
    monthData.transactions.push({
      name: description || "Income",
      amount,
      category: "Income",
      type: "income",
      date
    });

    // Update To Be Budgeted
    monthData.tbb = (monthData.tbb || 0) + amount;

    // Save month data
    await monthDocRef.set(monthData);
  }

  // ── Post-save (unchanged — runs for both paths) ───────────────────────
  await loadMonthData(availableMonths[currentMonthIndex]);

  // Reset modal
  document.getElementById("incomeAmount").value = "";
  document.getElementById("incomeDescription").value = "";
  document.getElementById("incomeDate").value = "";

  // Show success message
  showToast(`Income of ${formatCurrency(amount)} added successfully`, "success");
}

async function addCategory() {
  // ── Read DOM inputs (unchanged) ──────────────────────────────────────────
  const name         = document.getElementById("categoryName").value.trim();
  const assignAmount = parseFloat(document.getElementById("categoryBudget").value);
  const selectedMonth = availableMonths[currentMonthIndex] || null;

  // ── Validation (unchanged) ───────────────────────────────────────────────
  if (!name || isNaN(assignAmount) || assignAmount < 0) { showToast("Please enter a category name and valid amount.", "error"); return; }

  // ── Load root + month data (needed for both paths) ───────────────────────
  const docRef  = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  const data    = docSnap.exists ? docSnap.data() : { tbb: 0, categories: [], transactions: [], currentMonth: new Date().toISOString().slice(0, 7) };
  if (!docSnap.exists) await docRef.set(data);
  const monthsRef = docRef.collection("months");

  const targetMonth = selectedMonth || data.currentMonth || new Date().toISOString().slice(0, 7);

  const monthDocRef = monthsRef.doc(targetMonth);
  const monthSnap   = await monthDocRef.get();
  let monthData     = monthSnap.exists
    ? monthSnap.data()
    : { categories: JSON.parse(JSON.stringify(data.categories || [])), transactions: [], tbb: data.tbb || 0, currentMonth: targetMonth };

  if (!monthData.categories)   monthData.categories = [];
  if (!monthData.transactions)  monthData.transactions = [];

  // ── A3: Hard block on over-assignment ───────────────────────────────────
  const newTBB = monthData.tbb - assignAmount;
  if (newTBB < 0) {
    showToast(
      `❌ Cannot assign ${formatCurrency(assignAmount)} to "${name}" — ` +
      `only ${formatCurrency(monthData.tbb || 0)} available in To Be Budgeted. ` +
      `Add more income first, or assign a smaller amount.`,
      "error"
    );
    return;
  }

  // ── Duplicate-name check — stays in UI layer for both paths ─────────────
  // (engine doesn't know "duplicate category" as a business rule)
  if (monthData.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    { showToast("Category already exists. Please use a different name.", "error"); return; }
  }

  // ── Engine path (Phase 3) ────────────────────────────────────────────────
  if (FEATURE_FLAGS.useEngineForCategoryAssign) {
    try {
      await persistFinancialTransaction(
        {
          type:     "assign",
          amount:   assignAmount,
          date:     new Date().toISOString().slice(0, 10),
          monthKey: targetMonth,
          category: name,
          meta:     { isNewCategory: true },
        },
        db,
        currentUser.uid
      );
    } catch (err) {
      console.error("[Phase 3] Engine category error:", err);
      showToast("Failed to save category. Please try again.", "error");
      return;
    }
  } else {
    // ── Legacy inline path (original code, untouched) ────────────────────
    monthData.categories.push({
      name,
      assigned: assignAmount,
      spent:    0,
      balance:  assignAmount,
      monthly:  { [targetMonth]: { assigned: assignAmount, spent: 0 } }
    });

    monthData.tbb = newTBB;
    await monthDocRef.set(monthData);
  }

  // ── Post-save (unchanged — runs for both paths) ───────────────────────
  await loadMonthData(availableMonths[currentMonthIndex]);

  document.getElementById("categoryName").value = "";
  document.getElementById("categoryBudget").value = "";

}

async function addTransaction() {
  // ── Read DOM inputs (unchanged) ──────────────────────────────────────────
  const name     = document.getElementById("transactionName").value.trim();
  const amount   = parseFloat(document.getElementById("transactionAmount").value);
  const category = document.getElementById("transactionCategory").value;
  const date     = document.getElementById("transactionDate").value;
  const selectedMonth = availableMonths[currentMonthIndex] || null;

  // ── Validation (unchanged) ───────────────────────────────────────────────
  if (!name || isNaN(amount) || amount <= 0) { showToast("Please enter a valid transaction name and amount.", "error"); return; }
  if (!date) { showToast("Please select a date.", "error"); return; }

  // ── Resolve target month (unchanged) ─────────────────────────────────────
  const docRef  = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  const data    = docSnap.data();
  const targetMonth = selectedMonth || data.currentMonth || new Date().toISOString().slice(0, 7);

  // ── Available Balance guard ───────────────────────────────────────────────
  // RULE: Only block if the transaction exceeds the TOTAL INCOME received
  // this month — meaning the user is spending money that literally does not
  // exist anywhere in their budget.
  //
  // We do NOT block when a transaction exceeds a category's assigned amount.
  // That creates an "overspent" state, which is valid and intentional —
  // it's exactly what the A1 rollover logic carries forward to next month.
  //
  // Example:
  //   Income: ₱10,000 | Groceries assigned: ₱2,000 | Groceries spent: ₱1,800
  //   → User adds ₱500 expense to Groceries
  //   → Groceries spent = ₱2,300 (₱300 overspent) — ALLOWED ✅
  //   → Available Balance drops but total income still covers it
  //
  //   Income: ₱10,000 | Total spent across all categories: ₱9,800
  //   → User tries to add ₱500 expense
  //   → Would exceed total income by ₱300 — BLOCKED ❌
  //
  const _monthSnap   = await docRef.collection("months").doc(targetMonth).get();
  const _monthData   = _monthSnap.exists ? _monthSnap.data() : {};
  const _txns        = _monthData.transactions || [];

  // Total income received this month
  const _totalIncome = _txns
    .filter(t => t.type === "income" || (t.inflow && t.inflow > 0))
    .reduce((s, t) => s + (t.amount || t.inflow || 0), 0);

  // Total spent across all budget categories this month
  const _totalSpent = _txns
    .filter(t => t.type === "expense" && !t.isAccountOnlyTxn && !t.fromAsset && !t.fromLiability)
    .reduce((s, t) => s + (t.amount || 0), 0);

  // Only block if the expense would push total spending beyond total income
  // (i.e. spending money that was never received)
  if (_totalIncome === 0) {
    showToast(
      "❌ No income recorded this month. Add income before logging expenses.",
      "error"
    );
    return;
  }

  if (_totalSpent + amount > _totalIncome) {
    const remaining = Math.max(0, _totalIncome - _totalSpent);
    showToast(
      `❌ This expense exceeds your total available funds. ` +
      `You have ${formatCurrency(remaining)} left from ` +
      `${formatCurrency(_totalIncome)} income this month.`,
      "error"
    );
    return;
  }

  // ── Engine path (Phase 4) ────────────────────────────────────────────────
  if (FEATURE_FLAGS.useEngineForExpense) {
    try {
      await persistFinancialTransaction(
        {
          type:     "expense",
          amount,
          date,
          monthKey: targetMonth,
          name,
          category,
          source:   "available",  // dashboard expenses always from available balance
          meta:     {},
        },
        db,
        currentUser.uid
      );
    } catch (err) {
      console.error("[Phase 4] Engine expense error:", err);
      showToast("Failed to save transaction. Please try again.", "error");
      return;
    }
  } else {
    // ── Legacy inline path (original code, untouched) ────────────────────
    const monthsRef   = docRef.collection("months");
    const monthDocRef = monthsRef.doc(targetMonth);
    const monthSnap   = await monthDocRef.get();
    let monthData     = monthSnap.exists
      ? monthSnap.data()
      : {
          categories:   JSON.parse(JSON.stringify(data.categories || [])),
          transactions: [],
          tbb:          data.tbb || 0,
          currentMonth: targetMonth
        };

    // Update category spent
    const catIndex = monthData.categories.findIndex(c => c.name === category);
    if (catIndex !== -1) {
      monthData.categories[catIndex].spent  += amount;
      monthData.categories[catIndex].balance =
        (Number(monthData.categories[catIndex].startingBalance) || 0) +
        monthData.categories[catIndex].assigned - monthData.categories[catIndex].spent;
    }

    // Add transaction with unique ID
    const transactionId = Date.now().toString();
    monthData.transactions.push({
      id:       transactionId,
      name,
      amount,
      category,
      type:     "expense",
      date,
      source:   "dashboard"
    });

    // Save month data
    await monthDocRef.set(monthData);

    // Update root document's currentMonth pointer
    await docRef.update({ currentMonth: targetMonth });
  }

  // ── Post-save (unchanged — runs for both paths) ───────────────────────
  await loadBudget();
  await loadBudgetSection();

  // Reset modal
  document.getElementById("transactionName").value = "";
  document.getElementById("transactionAmount").value = "";
  document.getElementById("transactionDate").value = "";
}




// NOTE: The old fake initiateRollover() (button animation that did nothing)
// was removed. The real initiateRollover() is defined further below and opens
// the rollover modal with per-category Cover/Absorb choices.

// Ripple click effect on the rollover button (visual only)
(function attachRolloverRipple() {
  const btn = document.getElementById('rolloverBtn');
  if (!btn) return;
  btn.addEventListener('click', function (e) {
    const ripple = document.createElement('span');
    const rect = this.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const x = e.clientX - rect.left - size / 2;
    const y = e.clientY - rect.top - size / 2;
    ripple.style.cssText = `
      position: absolute;
      width: ${size}px;
      height: ${size}px;
      left: ${x}px;
      top: ${y}px;
      background: rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      transform: scale(0);
      animation: ripple 1.2s ease-out forwards;
      pointer-events: none;
      z-index: 0;
    `;
    this.appendChild(ripple);
    setTimeout(() => ripple.remove(), 1200);
  });
})();





// Toggle rollover settings visibility
function toggleRolloverSettings() {
  const mode = document.getElementById("rolloverMode").value;
  const automaticDayGroup = document.getElementById("automaticDayGroup");
  const rolloverButton = document.querySelector('button[onclick="initiateRollover()"]');
  
  if (mode === "automatic") {
    automaticDayGroup.style.display = "block";
    if (rolloverButton) {
      rolloverButton.style.display = "none";
    }
  } else {
    automaticDayGroup.style.display = "none";
    if (rolloverButton) {
      rolloverButton.style.display = "inline-block";
    }
  }
}

// Load rollover settings from Firebase
async function loadRolloverSettings() {
  if (!currentUser) return;
  
  try {
    const doc = await firebase.firestore().collection("users").doc(currentUser.uid).get();
    if (doc.exists && doc.data().rolloverSettings) {
      const settings = doc.data().rolloverSettings;
      document.getElementById("rolloverMode").value = settings.mode || "manual";
      if (settings.automaticDay) {
        document.getElementById("automaticRolloverDay").value = settings.automaticDay;
      }
      lastRolloverDate = settings.lastRollover || null;
      toggleRolloverSettings();
    }
  } catch (error) {
    console.error("Error loading rollover settings:", error);
  }
}

// Save rollover settings
document.getElementById("saveRolloverBtn").addEventListener("click", async () => {
  if (!currentUser) return;
  
  const mode = document.getElementById("rolloverMode").value;
  const settings = {
    mode: mode,
    lastRollover: lastRolloverDate
  };
  
  if (mode === "automatic") {
    settings.automaticDay = document.getElementById("automaticRolloverDay").value;
  } else {
    // Remove automatic settings if switching to manual
    settings.automaticDay = null;
  }
  
  try {
    await firebase.firestore().collection("users").doc(currentUser.uid).update({
      rolloverSettings: settings
    });
    
    // Update rollover button visibility in dashboard
    const rolloverButton = document.querySelector('button[onclick="initiateRollover()"]');
    if (rolloverButton) {
      rolloverButton.style.display = mode === "manual" ? "inline-block" : "none";
    }
    
    // If automatic mode, set up automatic rollover check
    if (mode === "automatic") {
      setupAutomaticRollover(settings.automaticDay);
    }
    
    showToast("Rollover settings saved.", "success");
  } catch (error) {
    console.error("Error saving rollover settings:", error);
    showToast("Failed to save settings. Please try again.", "error");
  }
});

// Initiate manual rollover (called from dashboard button)
// ════════════════════════════════════════════════════════════════════════════
// ROLLOVER — with per-category Cover / Absorb choices for overspent categories
// ════════════════════════════════════════════════════════════════════════════
//
//   Cover  → carry the deficit forward as a NEGATIVE starting balance next month
//            (you must assign new money next month to clear it)
//   Absorb → reset the category to ₱0 next month, and reduce next month's TBB
//            by the overspent amount (the pool eats the loss now)
//
// Positive leftover balances always carry forward. The choice only applies to
// categories where spent > assigned.

// Holds the scan result between opening the modal and confirming
let _rolloverPlan = null;

async function initiateRollover() {
  if (!currentUser) return;

  // Guard: one rollover per month
  if (lastRolloverDate) {
    const lastRollover = new Date(lastRolloverDate);
    const now = new Date();
    if (lastRollover.getFullYear() === now.getFullYear() &&
        lastRollover.getMonth() === now.getMonth()) {
      showToast("Rollover already performed this month. Only one rollover per month is allowed.", "warning");
      return;
    }
  }

  // Load the current month so we can scan for overspent categories
  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  if (!docSnap.exists) { showToast("Budget not found.", "error"); return; }

  const data = docSnap.data();
  const baseMonthKey = data.currentMonth || new Date().toISOString().slice(0, 7);
  const monthSnap = await docRef.collection("months").doc(baseMonthKey).get();
  if (!monthSnap.exists) { showToast("Current month data not found.", "error"); return; }

  const monthData = monthSnap.data();
  const categories = monthData.categories || [];

  // Identify overspent categories (spent > assigned)
  const overspentCategories = categories
    .filter(c => (c.spent || 0) > (c.assigned || 0))
    .map(c => ({
      name: c.name,
      assigned: c.assigned || 0,
      spent: c.spent || 0,
      deficit: (c.spent || 0) - (c.assigned || 0),
    }));

  // Stash the plan for proceedWithRollover()
  _rolloverPlan = {
    baseMonthKey,
    overspentCategories,
    // default every overspent category to "cover"
    choices: Object.fromEntries(overspentCategories.map(c => [c.name, "cover"])),
  };

  _renderRolloverModal();
  document.getElementById("rolloverModal").style.display = "flex";
}

// Builds the modal body dynamically based on the scan
function _renderRolloverModal() {
  const body = document.getElementById("rolloverModalBody");
  if (!body || !_rolloverPlan) return;

  const { overspentCategories } = _rolloverPlan;

  // No overspending → simple confirm
  if (overspentCategories.length === 0) {
    body.innerHTML = `
      <p class="bm-ro-intro">
        Roll the current month over to next month. Positive category balances
        carry forward, and your available balance becomes next month's
        starting <strong>To Be Budgeted</strong>.
      </p>
      <p class="bm-ro-note">This action cannot be undone.</p>
    `;
    return;
  }

  // Overspending → per-category choice
  const rows = overspentCategories.map(c => `
    <div class="bm-ro-row" data-cat="${_escapeHtml(c.name)}">
      <div class="bm-ro-row-head">
        <span class="bm-ro-cat">${_escapeHtml(c.name)}</span>
        <span class="bm-ro-deficit">−${formatCurrency(c.deficit)}</span>
      </div>
      <div class="bm-ro-choices">
        <label class="bm-ro-choice">
          <input type="radio" name="ro-${_escapeHtml(c.name)}" value="cover" checked
                 onchange="_setRolloverChoice('${_escapeHtmlAttr(c.name)}','cover')">
          <span class="bm-ro-choice-label">
            <strong>Cover</strong>
            <small>Carry the −${formatCurrency(c.deficit)} into next month. You'll
            assign new money to clear it.</small>
          </span>
        </label>
        <label class="bm-ro-choice">
          <input type="radio" name="ro-${_escapeHtml(c.name)}" value="absorb"
                 onchange="_setRolloverChoice('${_escapeHtmlAttr(c.name)}','absorb')">
          <span class="bm-ro-choice-label">
            <strong>Absorb</strong>
            <small>Reset to ₱0 and take ${formatCurrency(c.deficit)} from next
            month's To Be Budgeted now.</small>
          </span>
        </label>
      </div>
    </div>
  `).join("");

  const totalDeficit = overspentCategories.reduce((s, c) => s + c.deficit, 0);

  body.innerHTML = `
    <p class="bm-ro-intro">
      You overspent in <strong>${overspentCategories.length}</strong>
      ${overspentCategories.length === 1 ? "category" : "categories"}
      (total <strong>−${formatCurrency(totalDeficit)}</strong>).
      Choose how to handle each one:
    </p>
    <div class="bm-ro-list">${rows}</div>
    <p class="bm-ro-note">Positive balances carry forward automatically. This action cannot be undone.</p>
  `;
}

// Called by the radio buttons
function _setRolloverChoice(catName, choice) {
  if (_rolloverPlan && _rolloverPlan.choices) {
    _rolloverPlan.choices[catName] = choice;
  }
}

// Small HTML escapers so category names can't break the markup
function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]
  ));
}
function _escapeHtmlAttr(s) {
  return String(s).replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

// Close rollover modal
function closeRolloverModal() {
  document.getElementById("rolloverModal").style.display = "none";
}

// Proceed with rollover after confirmation
async function proceedWithRollover() {
  closeRolloverModal();

  // Request reauthentication
  const authenticated = await reauthenticateUserModal();
  if (!authenticated) return;

  await performRollover();
}


// Updated rollover function with tracking
async function performRollover() {
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  if (!docSnap.exists) return;

  const data = docSnap.data();
  const baseMonthKey = data.currentMonth || new Date().toISOString().slice(0,7);

  // Load current month doc
  const currentMonthDocRef = docRef.collection("months").doc(baseMonthKey);
  const currentMonthSnap = await currentMonthDocRef.get();
  if (!currentMonthSnap.exists) { showToast("Current month data not found.", "error"); return; }

  const currentMonthData = currentMonthSnap.data();
  const categories = currentMonthData.categories || [];

  // Available Balance is the carry-forward pool (source of truth)
  const availableBalance = currentMonthData.availableBalance || 0;

  // Use the choices captured when the modal opened (default to "cover")
  const choices = (_rolloverPlan && _rolloverPlan.choices) ? _rolloverPlan.choices : {};

  // Save a snapshot of the closing month
  await currentMonthDocRef.set({ ...currentMonthData, savedAt: new Date().toISOString() });

  // ── Build next month's categories based on each category's situation ──────
  // Positive balance   → carries forward as a positive starting balance
  // Overspent + cover  → carries forward as a NEGATIVE starting balance
  // Overspent + absorb → resets to 0, and we subtract the deficit from TBB
  let tbbAdjustment = 0;        // total absorbed (reduces next month's TBB)
  const auditDecisions = [];

  const newCategories = categories.map(c => {
    const assigned = c.assigned || 0;
    const spent    = c.spent || 0;
    const balance  = assigned - spent;

    if (balance >= 0) {
      // Not overspent — carry the leftover forward as starting balance
      auditDecisions.push({
        categoryName: c.name, previousAssigned: assigned, previousSpent: spent,
        previousBalance: balance, action: "carry_positive",
        carriedForward: balance, absorbedFromTbb: 0,
      });
      return { name: c.name, assigned: 0, spent: 0, balance: balance, startingBalance: balance };
    }

    // Overspent
    const deficit = Math.abs(balance);
    const choice = choices[c.name] || "cover";

    if (choice === "absorb") {
      tbbAdjustment += deficit;
      auditDecisions.push({
        categoryName: c.name, previousAssigned: assigned, previousSpent: spent,
        previousBalance: balance, action: "absorb",
        carriedForward: 0, absorbedFromTbb: deficit,
      });
      return { name: c.name, assigned: 0, spent: 0, balance: 0, startingBalance: 0 };
    }

    // Cover (default): carry the deficit forward as a negative starting balance
    auditDecisions.push({
      categoryName: c.name, previousAssigned: assigned, previousSpent: spent,
      previousBalance: balance, action: "cover",
      carriedForward: balance, absorbedFromTbb: 0,
    });
    return { name: c.name, assigned: 0, spent: 0, balance: balance, startingBalance: balance };
  });

  // Next month's TBB = carried available balance, minus anything absorbed
  const nextMonthTbb = availableBalance - tbbAdjustment;

  // Compute next month key
  const [year, month] = baseMonthKey.split("-").map(Number);
  const nextMonthDate = new Date(year, month - 1, 1);
  nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
  const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}`;

  const rolloverDate = new Date().toISOString().slice(0, 10);

  // Carry-forward shows up as a "BALANCE FROM LAST MONTH" income line
  const rolloverTransaction = {
    id: `rollover-${Date.now()}`,
    amount: nextMonthTbb,
    category: "BALANCE FROM LAST MONTH",
    date: rolloverDate,
    name: "ROLLOVER AMOUNT",
    type: "income",
    inflow: nextMonthTbb,
    outflow: 0
  };
  const transactions = nextMonthTbb !== 0 ? [rolloverTransaction] : [];

  // Create / overwrite next month
  const nextMonthDocRef = docRef.collection("months").doc(nextMonthKey);
  await nextMonthDocRef.set({
    categories: newCategories,
    transactions: transactions,
    tbb: nextMonthTbb,
    availableBalance: nextMonthTbb,
    currentMonth: nextMonthKey
  });

  // Write a rollover-history audit record for the closing month
  const totalCarried = auditDecisions.reduce((s, d) => s + (d.carriedForward > 0 ? d.carriedForward : 0), 0);
  await docRef.collection("rolloverHistory").doc(baseMonthKey).set({
    monthKey: baseMonthKey,
    rolledOverAt: new Date().toISOString(),
    decisions: auditDecisions,
    totalAbsorbed: tbbAdjustment,
    totalCarriedForward: totalCarried,
    nextMonthTbbStart: nextMonthTbb,
    triggeredBy: "manual",
  });

  // Update main doc pointer
  await docRef.update({ currentMonth: nextMonthKey });

  // Update last rollover date
  lastRolloverDate = new Date().toISOString();
  await firebase.firestore().collection("users").doc(currentUser.uid).update({
    "rolloverSettings.lastRollover": lastRolloverDate
  });

  // Clear the plan
  _rolloverPlan = null;

  // Reload and navigate to the new month
  await loadAvailableMonths();
  currentMonthIndex = availableMonths.indexOf(nextMonthKey);
  if (currentMonthIndex === -1) currentMonthIndex = availableMonths.length - 1;
  updateMonthDisplay();
  await loadMonthData(nextMonthKey);

  // Summary toast
  if (tbbAdjustment > 0) {
    showToast(`Rollover complete. ${formatCurrency(tbbAdjustment)} absorbed from next month's budget.`, "success");
  } else {
    showToast("Rollover completed successfully!", "success");
  }
}

// Setup automatic rollover checking
function setupAutomaticRollover(rolloverDay) {
  // This function would be called periodically to check if automatic rollover should occur
  // You would typically call this on app load and set up a daily check
  
  setInterval(async () => {
    await checkAndPerformAutomaticRollover(rolloverDay);
  }, 86400000); // Check once per day
  
  // Also check immediately on setup
  checkAndPerformAutomaticRollover(rolloverDay);
}

// Check and perform automatic rollover if needed
async function checkAndPerformAutomaticRollover(rolloverDay) {
  if (!currentUser) return;
  
  const now = new Date();
  const currentDay = now.getDate();
  const lastDayOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  
  let shouldRollover = false;
  
  if (rolloverDay === "last") {
    shouldRollover = currentDay === lastDayOfMonth;
  } else {
    const targetDay = parseInt(rolloverDay);
    shouldRollover = currentDay === targetDay;
  }
  
  if (!shouldRollover) return;
  
  // Check if already rolled over this month
  if (lastRolloverDate) {
    const lastRollover = new Date(lastRolloverDate);
    if (lastRollover.getFullYear() === now.getFullYear() && 
        lastRollover.getMonth() === now.getMonth()) {
      return; // Already rolled over this month
    }
  }
  
  // Perform automatic rollover
  await performRollover();
}

// ✅ Load ALL months into filter (dynamic, works with rollover)
// ===== YNAB-Style Month Navigation =====
let availableMonths = [];
let currentMonthIndex = 0;

// Load available months for navigation
async function loadAvailableMonths() {
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const monthsRef = docRef.collection("months");
  const snapshot = await monthsRef.get();

  availableMonths = snapshot.docs.map(doc => doc.id).sort();
  
  const docSnap = await docRef.get();
  const currentMonth = docSnap.data()?.currentMonth || new Date().toISOString().slice(0, 7);
  
  currentMonthIndex = availableMonths.indexOf(currentMonth);
  if (currentMonthIndex === -1) {
    availableMonths.push(currentMonth);
    availableMonths.sort();
    currentMonthIndex = availableMonths.indexOf(currentMonth);
  }
  
  updateMonthDisplay();
}

// Change month (direction: -1 for previous, 1 for next)
async function changeMonth(direction) {
  currentMonthIndex += direction;
  
  // Clamp to valid range
  if (currentMonthIndex < 0) currentMonthIndex = 0;
  if (currentMonthIndex >= availableMonths.length) currentMonthIndex = availableMonths.length - 1;
  
  updateMonthDisplay();
  await loadMonthData(availableMonths[currentMonthIndex]);
}

// Update month display
function updateMonthDisplay() {
  const monthKey = availableMonths[currentMonthIndex];
  const date = new Date(monthKey + '-01');
  const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  
  document.getElementById('currentMonthLabel').textContent = monthName;
  
  // Load and display note preview
  loadMonthNotePreview(monthKey);
}

// Load month data
async function loadMonthData(monthKey) {
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const monthRef = docRef.collection("months").doc(monthKey);
  const monthSnap = await monthRef.get();

  if (monthSnap.exists) {
    const monthData = monthSnap.data();
    renderBudget(monthData);
    renderBudgetSection(monthData.categories || [], monthData.transactions || []);
  } else {
    // Month doc may have just been created — fall back to root doc for display
    const rootSnap = await docRef.get();
    if (rootSnap.exists) renderBudget(rootSnap.data());
  }
}

// Open month note modal
async function openMonthNoteModal() {
  const monthKey = availableMonths[currentMonthIndex];
  const date = new Date(monthKey + '-01');
  const monthName = date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  
  document.getElementById('noteModalTitle').textContent = `${monthName} Note`;
  
  // Load existing note
  const docRef = db.collection("budget").doc(currentUser.uid);
  const monthRef = docRef.collection("months").doc(monthKey);
  const monthSnap = await monthRef.get();
  
  const note = monthSnap.exists ? monthSnap.data().note || '' : '';
  document.getElementById('monthNoteText').value = note;
  
  openModal('monthNoteModal');
}

// Save month note
async function saveMonthNote() {
  const monthKey = availableMonths[currentMonthIndex];
  const note = document.getElementById('monthNoteText').value.trim();
  
  const docRef = db.collection("budget").doc(currentUser.uid);
  const monthRef = docRef.collection("months").doc(monthKey);
  
  await monthRef.set({ note }, { merge: true });
  
  closeModal('monthNoteModal');
  loadMonthNotePreview(monthKey);
  showToast('Note saved successfully', 'success');
}

// Load month note preview
async function loadMonthNotePreview(monthKey) {
  const docRef = db.collection("budget").doc(currentUser.uid);
  const monthRef = docRef.collection("months").doc(monthKey);
  const monthSnap = await monthRef.get();
  
  const note = monthSnap.exists ? monthSnap.data().note || '' : '';
  const preview = document.getElementById('notePreview');
  
  if (note) {
    preview.textContent = note.slice(0, 30) + (note.length > 30 ? '...' : '');
    preview.classList.add('has-note');
  } else {
    preview.textContent = 'Enter a note...';
    preview.classList.remove('has-note');
  }
}

// Update auth listener to load months
auth.onAuthStateChanged(async (user) => {
  if (!user) return window.location.href = "auth.html";
  currentUser = user;
  
  try {
    const userDoc = await db.collection("users").doc(user.uid).get();
    const userData = userDoc.data();
    
    if (userDoc.exists && userData?.currency) {
      userCurrency = userData.currency;
      window.userCurrency = userCurrency;
    } else {
      userCurrency = "USD";
      window.userCurrency = userCurrency;
    }
    
    if (userDoc.exists && userData?.approved === true) {
      document.getElementById("appSection").style.display = "block";
      await loadAvailableMonths(); // Add this line
      await loadBudget();
      await loadAccounts();  
    } else {
      showToast("Your account is pending approval. Please contact the admin.", "error");
      await auth.signOut();
    }
  } catch (err) {
    console.error("Error fetching user:", err);
  }
});


////////ACCOUNT SECTION

// Render accounts
// Account type configuration
// Professional SVG Icons
const ACCOUNT_ICONS = {
  checking: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
  savings: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  cash: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="10" rx="2"/><circle cx="12" cy="12" r="3"/><path d="M18.09 10.37a4 4 0 0 1 0 3.26M5.91 13.63a4 4 0 0 1 0-3.26"/></svg>',
  investment: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  retirement: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
  'other-asset': '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  'credit-card': '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>',
  loan: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  mortgage: '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
  'line-of-credit': '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="12" y1="2" x2="12" y2="6"/></svg>',
  'other-liability': '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>'
};

// Account type configuration
const ACCOUNT_TYPES = {
  // Assets
  'checking': { label: 'Checking', category: 'asset', color: '#005ca9' },
  'savings': { label: 'Savings', category: 'asset', color: '#16a085' },
  'cash': { label: 'Cash', category: 'asset', color: '#27ae60' },
  'investment': { label: 'Investment', category: 'asset', color: '#8e44ad' },
  'retirement': { label: 'Retirement', category: 'asset', color: '#2980b9' },
  'other-asset': { label: 'Other Asset', category: 'asset', color: '#34495e' },
  // Liabilities
  'credit-card': { label: 'Credit Card', category: 'liability', color: '#e74c3c' },
  'loan': { label: 'Loan', category: 'liability', color: '#c0392b' },
  'mortgage': { label: 'Mortgage', category: 'liability', color: '#d35400' },
  'line-of-credit': { label: 'Line of Credit', category: 'liability', color: '#e67e22' },
  'other-liability': { label: 'Other Liability', category: 'liability', color: '#95a5a6' }
};

// Render accounts with separation
function renderAccounts(list) {
  const assetsList = document.getElementById("assets-list");
  const liabilitiesList = document.getElementById("liabilities-list");
  const assetsCount = document.getElementById("assets-count");
  const liabilitiesCount = document.getElementById("liabilities-count");
  
  assetsList.innerHTML = "";
  liabilitiesList.innerHTML = "";

  if (!list || list.length === 0) {
    assetsList.innerHTML = "<p class='acc-empty'>No asset accounts yet.</p>";
    liabilitiesList.innerHTML = "<p class='acc-empty'>No liability accounts yet.</p>";
    if (assetsCount) assetsCount.textContent = "0";
    if (liabilitiesCount) liabilitiesCount.textContent = "0";
    updateNetWorthSummary(list);
    return;
  }

  const assets = list.filter(acc => {
    const type = ACCOUNT_TYPES[acc.type];
    return type && type.category === 'asset';
  });

  const liabilities = list.filter(acc => {
    const type = ACCOUNT_TYPES[acc.type];
    return type && type.category === 'liability';
  });

  if (assetsCount) assetsCount.textContent = assets.length;
  if (liabilitiesCount) liabilitiesCount.textContent = liabilities.length;

  // Render assets
  if (assets.length === 0) {
    assetsList.innerHTML = "<p class='acc-empty'>No asset accounts yet.</p>";
  } else {
    assets.forEach((acc, index) => {
      const originalIndex = list.indexOf(acc);
      const typeInfo = ACCOUNT_TYPES[acc.type] || { icon: '💰', label: 'Account' };
      assetsList.innerHTML += createAccountCard(acc, originalIndex, typeInfo);
    });
  }

  // Render liabilities
  if (liabilities.length === 0) {
    liabilitiesList.innerHTML = "<p class='acc-empty'>No liability accounts yet.</p>";
  } else {
    liabilities.forEach((acc, index) => {
      const originalIndex = list.indexOf(acc);
      const typeInfo = ACCOUNT_TYPES[acc.type] || { icon: '💳', label: 'Account' };
      liabilitiesList.innerHTML += createAccountCard(acc, originalIndex, typeInfo);
    });
  }

  updateNetWorthSummary(list);

  // Update the zero-accounts prompt banner
  if (typeof AccountsPrompt !== "undefined") AccountsPrompt.syncWithAccounts();
}

// Create account card HTML — compact row design
// Create account card HTML — compact row design
function createAccountCard(acc, index, typeInfo) {
  const isLiability = typeInfo.category === 'liability';
  const isCreditCard = acc.type === 'credit-card';
  const icon = ACCOUNT_ICONS[acc.type] || ACCOUNT_ICONS['other-asset'];

  const creditLimit  = acc.creditLimit || 0;
  const amountOwed   = Math.abs(acc.balance || 0);
  const availCredit  = isCreditCard ? Math.max(0, creditLimit - amountOwed) : 0;
  const usagePct     = (isCreditCard && creditLimit > 0) ? Math.min(100, (amountOwed / creditLimit) * 100) : 0;
  const barColor     = usagePct > 80 ? '#ef4444' : usagePct > 50 ? '#f59e0b' : '#10b981';

  // Due date
  let dueBadge = '';
  if (isCreditCard && acc.dueDay) {
    const today  = new Date();
    const dueDay = parseInt(acc.dueDay);
    let dueDate;
    if (acc.nextDueOverride) {
      dueDate = new Date(acc.nextDueOverride + 'T00:00:00');
    } else {
      dueDate = new Date(today.getFullYear(), today.getMonth(), dueDay);
      if (dueDate <= today) dueDate = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
    }
    const daysUntil   = Math.ceil((dueDate - today) / 86400000);
    const urgColor    = daysUntil <= 3 ? '#ef4444' : daysUntil <= 7 ? '#f59e0b' : '#10b981';
    const dueDateStr  = dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const paidBadge   = acc.lastPaidDate ? ' ✓' : '';
    dueBadge = `<span class="acc-due-badge" style="background:${urgColor}18; color:${urgColor};">
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="${urgColor}" stroke-width="2.5"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      Due ${dueDateStr}${paidBadge} · ${daysUntil > 0 ? daysUntil + 'd' : 'Today'}
    </span>`;
  }

  // Credit usage bar
  let creditBar = '';
  if (isCreditCard) {
    creditBar = `<div class="acc-credit-bar-wrap">
      <div class="acc-credit-bar-track">
        <div class="acc-credit-bar-fill" style="width:${usagePct.toFixed(1)}%; background:${barColor};"></div>
      </div>
      <span class="acc-credit-pct">${usagePct.toFixed(0)}% used</span>
    </div>`;
  }

  // Balance display
  let balanceMain, balanceSub = '';
  if (isCreditCard) {
    balanceMain = `<span class="acc-balance-main" style="color:#ef4444;">${formatCurrency(amountOwed)}</span>`;
    balanceSub  = `<span class="acc-balance-sub">Avail: ${formatCurrency(availCredit)}</span>`;
  } else if (isLiability) {
    balanceMain = `<span class="acc-balance-main" style="color:#ef4444;">${formatCurrency(amountOwed)}</span>`;
  } else {
    const col = (acc.balance || 0) >= 0 ? '#10b981' : '#ef4444';
    balanceMain = `<span class="acc-balance-main" style="color:${col};">${formatCurrency(Math.abs(acc.balance || 0))}</span>`;
  }

  return `
    <div class="account-item" id="account-item-${index}">
      <div class="acc-icon" style="background:${typeInfo.color}18; color:${typeInfo.color};">${icon}</div>
      <div class="acc-info">
        <div class="acc-name">${acc.name}</div>
        <div class="acc-type-label">${typeInfo.label}</div>
        ${creditBar}
        ${dueBadge}
      </div>
      <div class="acc-balance-col">
        ${balanceMain}
        ${balanceSub}
      </div>
      <div class="account-actions">
        <button class="btn-recent" onclick="toggleAccountHistory(${index})" id="btn-recent-${index}" title="View recent transactions">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button class="btn-sm btn-outline bm-desktop-only-btn" onclick="openTransactionPanel(${index})" title="Add Transaction">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="btn-sm btn-outline bm-desktop-only-btn" onclick="editAccount(${index})" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-sm btn-danger bm-desktop-only-btn" onclick="deleteAccount(${index})" title="Delete">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
    <div class="acct-txn-history" id="acct-txn-history-${index}" style="display:none;padding:8px 12px 12px;border-top:1px solid var(--ynab-border);background:var(--ynab-light-gray);">
      <div id="acct-txn-history-body-${index}"><em style="color:var(--text-light);font-size:12px;">Loading…</em></div>
    </div>
    <div class="txn-panel-wrapper" id="txn-panel-wrapper-${index}">
      <!-- inline transaction panel injected by openTransactionPanel() -->
    </div>
  `;
}

// Update net worth summary
function updateNetWorthSummary(list) {
  if (!list || list.length === 0) {
    document.getElementById('total-assets-summary').textContent = formatCurrency(0);
    document.getElementById('total-liabilities-summary').textContent = formatCurrency(0);
    document.getElementById('net-worth-summary').textContent = formatCurrency(0);
    return;
  }

  let totalAssets = 0;
  let totalLiabilities = 0;

  list.forEach(acc => {
    const type = ACCOUNT_TYPES[acc.type];
    if (type && type.category === 'asset') {
      totalAssets += acc.balance;
    } else if (type && type.category === 'liability') {
      totalLiabilities += Math.abs(acc.balance);
    }
  });

  const netWorth = totalAssets - totalLiabilities;

  document.getElementById('total-assets-summary').textContent = formatCurrency(totalAssets);
  document.getElementById('total-liabilities-summary').textContent = formatCurrency(totalLiabilities);
  document.getElementById('net-worth-summary').textContent = formatCurrency(netWorth);
}





// Load accounts from Firestore
async function loadAccounts() {
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  const data = docSnap.exists ? docSnap.data() : null;

  accounts = data?.accounts || [];
  renderAccounts(accounts);
}

// Open modal for Add or Edit
// Update balance hint based on account type
document.getElementById("account-type").addEventListener("change", (e) => {
  const type = e.target.value;
  const typeInfo = ACCOUNT_TYPES[type];
  const hint = document.getElementById("balance-hint");
  const ccFields = document.getElementById("credit-card-fields");
  const balLabel = document.getElementById("account-balance-label");
  
  if (type === 'credit-card') {
    hint.textContent = "Enter current amount owed (will be stored as a positive number)";
    hint.style.color = "var(--ynab-red)";
    balLabel.textContent = "Current Amount Owed";
    ccFields.style.display = "block";
  } else if (typeInfo && typeInfo.category === 'liability') {
    hint.textContent = "For debts, enter as positive number (e.g., 5000 for ₱5,000 owed)";
    hint.style.color = "var(--ynab-red)";
    balLabel.textContent = "Current Balance";
    ccFields.style.display = "none";
  } else {
    hint.textContent = "Enter the current balance of this account";
    hint.style.color = "var(--text-light)";
    balLabel.textContent = "Current Balance";
    ccFields.style.display = "none";
  }
});

// Open modal for Add or Edit
document.getElementById("add-account-btn").addEventListener("click", () => {
  editingIndex = null;
  // resetAccountModal clears all fields, errors, type grid, char counter, CC fields
  if (typeof resetAccountModal === "function") resetAccountModal();
  const titleEl  = document.getElementById("account-modal-title");
  const eyebrowEl = document.getElementById("account-modal-eyebrow");
  if (titleEl)   titleEl.innerText   = "Add Account";
  if (eyebrowEl) eyebrowEl.textContent = "New account";
  openModal("account-modal");
});

// Edit account function
async function editAccount(index) {
  const account = accounts[index];
  if (!account) return;

  editingIndex = index;
  if (typeof resetAccountModal === "function") resetAccountModal();

  const titleEl   = document.getElementById("account-modal-title");
  const eyebrowEl = document.getElementById("account-modal-eyebrow");
  if (titleEl)   titleEl.innerText    = "Edit Account";
  if (eyebrowEl) eyebrowEl.textContent = "Editing account";

  document.getElementById("account-type").value    = account.type || "checking";
  document.getElementById("account-name").value    = account.name;
  document.getElementById("account-balance").value = Math.abs(account.balance || 0);
  document.getElementById("account-notes").value   = account.notes || "";
  document.getElementById("account-credit-limit").value = account.creditLimit || "";
  document.getElementById("account-due-date").value     = account.dueDay || "";

  // Sync segmented control to match the account type
  if (typeof syncAccountTypeGrid === "function") syncAccountTypeGrid(account.type || "checking");

  // Update char counter
  const nameEl  = document.getElementById("account-name");
  const counter = document.getElementById("acct-name-count");
  if (nameEl && counter) counter.textContent = `${nameEl.value.length} / 40`;

  openModal("account-modal");
}

// Save account (add or edit)
document.getElementById("save-account-btn").addEventListener("click", async () => {
  const type = document.getElementById("account-type").value;
  const name = document.getElementById("account-name").value.trim();
  const balance = parseFloat(document.getElementById("account-balance").value);
  const notes = document.getElementById("account-notes").value.trim();
  const creditLimitRaw = document.getElementById("account-credit-limit").value;
  const dueDayRaw = document.getElementById("account-due-date").value;
  
  // Use inline modal validation (shows errors inside the modal, not toast)
  if (typeof validateAccountModal === "function" && !validateAccountModal()) return;

  if (!type) { showToast("Please select an account type.", "error"); return; }
  if (!name) { showToast("Please enter an account name.", "error"); return; }
  if (isNaN(balance)) { showToast("Please enter a valid balance.", "error"); return; }
  
  // Credit card validation
  if (type === 'credit-card') {
    if (!creditLimitRaw || isNaN(parseFloat(creditLimitRaw)) || parseFloat(creditLimitRaw) <= 0) {
      { showToast("Please enter a valid Credit Limit for this credit card.", "error"); return; }
    }
    if (!dueDayRaw) {
      { showToast("Please select a Due Date for this credit card.", "error"); return; }
    }
  }
  
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  let data = docSnap.exists ? docSnap.data() : { 
    accounts: [], 
    tbb: 0, 
    categories: [], 
    transactions: [], 
    currentMonth: new Date().toISOString().slice(0,7) 
  };

  // Prevent duplicate names (except when editing same account)
  const isDuplicate = data.accounts?.some((a, idx) => 
    a.name.toLowerCase() === name.toLowerCase() && idx !== editingIndex
  );
  
  if (isDuplicate) {
    { showToast("An account with this name already exists.", "error"); return; }
  }

// ✅ Check if balance changed during edit
  if (editingIndex !== null) {
    const oldBalance = data.accounts[editingIndex].balance;
    const newBalanceValue = type === 'credit-card' ? balance : balance;
    const balanceChanged = Math.abs(oldBalance) !== newBalanceValue;

    if (balanceChanged) {
      // ✅ Show warning
      const confirmChange = await showConfirm(
        `⚠️ Manually changing the account balance is not recommended.<br><br>` +
        `Current Balance: <strong>${formatCurrency(Math.abs(oldBalance))}</strong><br>` +
        `New Balance: <strong>${formatCurrency(newBalanceValue)}</strong><br><br>` +
        `Tip: Use "Add Transaction" instead to properly track deposits and withdrawals.<br><br>` +
        `Do you still want to proceed?`,
        { confirmText: "Override Balance", cancelText: "Cancel", type: "warning" }
      );

      if (!confirmChange) {
        return;
      }

      // ✅ Require password verification
      const authenticated = await reauthenticateUserModal();
      if (!authenticated) {
        return showToast("Incorrect password. Balance change cancelled.", "error");
      }
    }
  }

  const accountData = {
    type,
    name,
    balance,  // For credit cards: stored as positive = amount owed
    notes: notes || "",
    updatedAt: new Date().toISOString()
  };

  // Save credit card specific fields
  if (type === 'credit-card') {
    accountData.creditLimit = parseFloat(creditLimitRaw);
    accountData.dueDay = parseInt(dueDayRaw);
  }

  if (editingIndex !== null) {
    // Update existing account
    data.accounts[editingIndex] = {
      ...data.accounts[editingIndex],
      ...accountData
    };
    showToast("Account updated successfully", "success");
  } else {
    // Add new account
    data.accounts = data.accounts || [];
    accountData.createdAt = new Date().toISOString();
    data.accounts.push(accountData);
    showToast("Account added successfully", "success");
  }

await docRef.set(data);
  accounts = data.accounts;
  renderAccounts(accounts);

  // ✅ Reload accounts only, no TBB changes
  closeModal("account-modal");
});
// Delete account
async function deleteAccount(index) {
  const account = accounts[index];
  if (!account) return;
  
  const _confirmDelAccount = await showConfirm(
    `Delete <strong>${account.name}</strong>?<br><br>This will also delete all transactions for this account. This cannot be undone.`,
    { confirmText: "Delete", cancelText: "Cancel", type: "danger" }
  );
  if (!_confirmDelAccount) return;
  
  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  let data = docSnap.exists ? docSnap.data() : null;
  if (!data) return;

  // Remove account
  data.accounts.splice(index, 1);

  // Remove related transactions from root
  if (data.transactions) {
    data.transactions = data.transactions.filter(t => 
      t.fromAccount !== account.name && t.toAccount !== account.name && t.name !== account.name
    );
  }

  await docRef.set(data);
  accounts = data.accounts;
  renderAccounts(accounts);
  
  showToast(`Account "${account.name}" deleted`, "success");
}

/////// TRANSACTIONS ////////

// Open Transaction Modal
// ===== Inline Transaction Panel Logic =====

let activePanelIndex = null; // currently open panel account index

const TXN_TYPE_META = {
  deposit:    { icon: '⬆️', desc: 'Adds money into this account.' },
  withdrawal: { icon: '⬇️', desc: 'Removes money from this account and returns it to your budget.' },
  transfer:   { icon: '↔️', desc: 'Moves money between two accounts.' },
  expense:    { icon: '🧾', desc: 'Deducts from this account and records as a categorized expense on the Dashboard.' },
};

function closeTransactionPanel() {
  if (activePanelIndex === null) return;
  const wrapper    = document.getElementById(`txn-panel-wrapper-${activePanelIndex}`);
  const accountItem= document.getElementById(`account-item-${activePanelIndex}`);
  const btn        = document.getElementById(`add-txn-btn-${activePanelIndex}`);
  const popover    = wrapper ? wrapper.querySelector('.txn-popover') : null;

  if (popover) popover.classList.remove('open');
  if (accountItem) accountItem.classList.remove('txn-active');
  if (btn) {
    btn.classList.remove('open');
    // Restore the + icon
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    btn.title = 'Add Transaction';
  }
  activePanelIndex = null;
}

async function openTransactionPanel(index) {
  // Toggle: clicking same button closes it
  if (activePanelIndex === index) {
    closeTransactionPanel();
    return;
  }

  // Close any previously open popover
  closeTransactionPanel();

  transactionAccountIndex = index;
  activePanelIndex = index;

  const wrapper     = document.getElementById(`txn-panel-wrapper-${index}`);
  const accountItem = document.getElementById(`account-item-${index}`);
  const btn         = document.getElementById(`add-txn-btn-${index}`);
  if (!wrapper) return;

  // Inject popover from template
  const template = document.getElementById('txn-panel-template');
  const clone    = template.content.cloneNode(true);
  wrapper.innerHTML = '';
  wrapper.appendChild(clone);

  const popover = wrapper.querySelector('.txn-popover');

  // Detect if this is a liability account
  const acc = accounts[index];
  const typeInfo = ACCOUNT_TYPES[acc.type];
  const isLiability = typeInfo && typeInfo.category === 'liability';
  const isCreditCard = acc.type === 'credit-card';

  // Show correct tab set
  const assetTabs     = wrapper.querySelector('#txn-tabs-asset');
  const liabilityTabs = wrapper.querySelector('#txn-tabs-liability');
  if (isLiability) {
    assetTabs.style.display = 'none';
    liabilityTabs.style.display = 'flex';
    popover.setAttribute('data-active', 'expense');
  } else {
    assetTabs.style.display = 'flex';
    liabilityTabs.style.display = 'none';
    popover.setAttribute('data-active', 'deposit');
  }

  // Default date = today
  wrapper.querySelector('#transaction-date').value = new Date().toISOString().slice(0, 10);

  // Tab click — update data-active + show/hide conditional fields
  wrapper.querySelectorAll('.txn-pop-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      // Only toggle within visible tab group
      const parentTabs = tab.closest('.txn-pop-tabs');
      parentTabs.querySelectorAll('.txn-pop-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const type = tab.dataset.type;
      popover.setAttribute('data-active', type);
      wrapper.querySelector('#transfer-target-group').style.display = type === 'transfer' ? 'flex' : 'none';
      wrapper.querySelector('#expense-category-group').style.display = type === 'expense'  ? 'flex' : 'none';
    });
  });

  // For liability default = expense tab → show category
  if (isLiability) {
    wrapper.querySelector('#expense-category-group').style.display = 'flex';
  }

  // Populate transfer target dropdown
  const targetSelect = wrapper.querySelector('#transfer-target');
  targetSelect.innerHTML = '';
  accounts.forEach((a, i) => {
    if (i !== index) targetSelect.innerHTML += `<option value="${i}">${a.name}</option>`;
  });

  // Populate expense category dropdown from Firestore
  try {
    const docRef   = db.collection("budget").doc(currentUser.uid);
    const docSnap  = await docRef.get();
    if (docSnap.exists) {
      const data         = docSnap.data();
      const currentMonth = data.currentMonth || new Date().toISOString().slice(0, 7);
      const monthSnap    = await docRef.collection("months").doc(currentMonth).get();
      const monthData    = monthSnap.exists ? monthSnap.data() : null;
      const categories   = (monthData && monthData.categories) ? monthData.categories : (data.categories || []);
      const catSelect    = wrapper.querySelector('#expense-category');
      catSelect.innerHTML = `<option value="">— Select category —</option>`;
      categories.forEach((cat, i) => {
        catSelect.innerHTML += `<option value="${i}">${cat.name}</option>`;
      });
    }
  } catch (err) {
    console.error("Failed to load categories:", err);
  }

  // Save button — full transaction logic
  wrapper.querySelector('#save-transaction-btn').addEventListener('click', async () => {
    // Determine active tab from whichever tab set is visible
    const visibleTabSet = isLiability ? liabilityTabs : assetTabs;
    const activeTab = visibleTabSet.querySelector('.txn-pop-tab.active');
    const type      = activeTab ? activeTab.dataset.type : (isLiability ? 'expense' : 'deposit');
    const amount    = parseFloat(wrapper.querySelector('#transaction-amount').value);
    const dateInput = wrapper.querySelector('#transaction-date').value;
    const date      = dateInput || new Date().toISOString().slice(0, 10);
    const reason    = wrapper.querySelector('#transaction-reason').value.trim();

    if (isNaN(amount) || amount <= 0) { showToast("Please enter a valid amount.", "error"); return; }

    if (type === "expense") {
      const catIndexVal = wrapper.querySelector('#expense-category').value;
      if (catIndexVal === "") { showToast("Please select a budget category for this expense.", "error"); return; }
    }

    const docRef  = db.collection("budget").doc(currentUser.uid);
    const docSnap = await docRef.get();
    let data      = docSnap.exists ? docSnap.data() : null;
    if (!data) return;

    const transactionId  = `tx-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const sourceAccount  = data.accounts[transactionAccountIndex];
    const currentMonth   = availableMonths[currentMonthIndex] || data.currentMonth || new Date().toISOString().slice(0, 7);

    // ── Engine path (Phase 6) ──────────────────────────────────────────────
    if (FEATURE_FLAGS.useEngineForAccountTxn) {
      try {
        let flatIntent = null;

        if (type === 'pay') {
          // Credit card payment — liability payment type
          const monthDocRef = docRef.collection("months").doc(currentMonth);
          const monthSnap   = await monthDocRef.get();
          const monthData   = monthSnap.exists ? monthSnap.data() : { availableBalance: 0 };
          const currentAvailableBalance = monthData.availableBalance || 0;
          if (currentAvailableBalance < amount) {
            const _okPay1 = await showConfirm(
              `Paying ${formatCurrency(amount)} exceeds your Available Balance of ${formatCurrency(currentAvailableBalance)}. Proceed anyway?`,
              { confirmText: "Proceed", cancelText: "Cancel", type: "warning" }
            );
            if (!_okPay1) return;
          }
          // Advance due date (UI logic stays here — engine only handles money)
          const dueDay = data.accounts[transactionAccountIndex].dueDay;
          if (dueDay) {
            const today = new Date();
            let nextDue = new Date(today.getFullYear(), today.getMonth(), dueDay);
            if (nextDue <= today) nextDue = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
            nextDue = new Date(nextDue.getFullYear(), nextDue.getMonth() + 1, dueDay);
            data.accounts[transactionAccountIndex].lastPaidDate    = today.toISOString().slice(0, 10);
            data.accounts[transactionAccountIndex].nextDueOverride = nextDue.toISOString().slice(0, 10);
            await docRef.update({ accounts: data.accounts });
            accounts = data.accounts;
          }
          flatIntent = {
            type:            'liability_payment',
            amount,
            date,
            monthKey:        currentMonth,
            name:            reason || `Payment — ${sourceAccount.name}`,
            sourceAccountId: sourceAccount.name,
            accountName:     sourceAccount.name,
            meta:            { liabilityAccountName: sourceAccount.name },
          };

        } else if (type === 'expense' && isLiability) {
          // Credit card charge — expense from liability
          const catIndex     = parseInt(wrapper.querySelector('#expense-category').value);
          const monthDocRef  = docRef.collection("months").doc(currentMonth);
          const monthSnap    = await monthDocRef.get();
          const monthData    = monthSnap.exists ? monthSnap.data() : { categories: [] };
          const categoryName = (monthData.categories[catIndex] && monthData.categories[catIndex].name) || "Uncategorized";
          flatIntent = {
            type:        'expense',
            amount,
            date,
            monthKey:    currentMonth,
            name:        reason || sourceAccount.name,
            category:    categoryName,
            source:      'liability',
            accountName: sourceAccount.name,
            meta:        {},
          };

        } else if (type === 'deposit') {
          flatIntent = {
            type:        'deposit',
            amount,
            date,
            monthKey:    currentMonth,
            name:        reason || sourceAccount.name,
            accountName: sourceAccount.name,
            meta:        {},
          };

        } else if (type === 'withdrawal') {
          if (data.accounts[transactionAccountIndex].balance < amount) { showToast("Insufficient balance — not enough funds in this account.", "error"); return; }
          flatIntent = {
            type:        'withdrawal',
            amount,
            date,
            monthKey:    currentMonth,
            name:        reason || sourceAccount.name,
            accountName: sourceAccount.name,
            meta:        {},
          };

        } else if (type === 'transfer') {
          const targetIndex = parseInt(wrapper.querySelector('#transfer-target').value);
          if (data.accounts[transactionAccountIndex].balance < amount) { showToast("Insufficient balance — not enough funds in this account.", "error"); return; }
          flatIntent = {
            type:            'transfer',
            amount,
            date,
            monthKey:        currentMonth,
            name:            reason || `Transfer`,
            accountName:     sourceAccount.name,
            fromAccountName: sourceAccount.name,
            toAccountName:   data.accounts[targetIndex].name,
            meta:            {},
          };

        } else if (type === 'expense' && !isLiability) {
          // Expense from asset account
          if (data.accounts[transactionAccountIndex].balance < amount) { showToast("Insufficient balance — not enough funds in this account.", "error"); return; }
          const catIndex     = parseInt(wrapper.querySelector('#expense-category').value);
          const monthDocRef  = docRef.collection("months").doc(currentMonth);
          const monthSnap    = await monthDocRef.get();
          const monthData    = monthSnap.exists ? monthSnap.data() : { categories: [] };
          const categoryName = (monthData.categories[catIndex] && monthData.categories[catIndex].name) || "Uncategorized";
          flatIntent = {
            type:        'expense',
            amount,
            date,
            monthKey:    currentMonth,
            name:        reason || sourceAccount.name,
            category:    categoryName,
            source:      'asset',
            accountName: sourceAccount.name,
            meta:        {},
          };
        }

        if (!flatIntent) { showToast("Unknown transaction type.", "error"); return; }

        await persistFinancialTransaction(flatIntent, db, currentUser.uid);

        accounts = (await docRef.get()).data().accounts;
        closeTransactionPanel();
        renderAccounts(accounts);
        // Force immediate recompute of Available Balance on the dashboard
        await loadMonthData(currentMonth);
        await loadBudget();

        if (type === 'pay')        showToast(`${formatCurrency(amount)} payment recorded for ${sourceAccount.name}. Due date advanced.`, "success");
        else if (type === 'deposit')    showToast(`${formatCurrency(amount)} deposited to ${sourceAccount.name}`, "success");
        else if (type === 'withdrawal') showToast(`${formatCurrency(amount)} withdrawn from ${sourceAccount.name}`, "success");
        else if (type === 'transfer')   showToast(`${formatCurrency(amount)} transferred successfully`, "success");
        else if (type === 'expense' && isLiability) {
          const catIndex     = parseInt(wrapper.querySelector('#expense-category').value);
          const monthDocRef  = docRef.collection("months").doc(currentMonth);
          const monthSnap    = await monthDocRef.get();
          const monthData    = monthSnap.exists ? monthSnap.data() : { categories: [] };
          const categoryName = (monthData.categories[catIndex] && monthData.categories[catIndex].name) || "Uncategorized";
          showToast(`${formatCurrency(amount)} expense on "${categoryName}" charged to ${sourceAccount.name}`, "success");
        } else {
          showToast(`${formatCurrency(amount)} expense recorded from ${sourceAccount.name}`, "success");
        }
        return;

      } catch (err) {
        console.error("[Phase 6] Engine account txn error:", err);
        showToast("Failed to save transaction. Please try again.", "error");
        return;
      }
    }
    // ── End engine path ───────────────────────────────────────────────────

    // ===== PAY (Credit Card Payment) =====
    if (type === 'pay') {
      // Deduct from Dashboard Available Balance (not TBB)
      const currentMonth = availableMonths[currentMonthIndex] || data.currentMonth || new Date().toISOString().slice(0, 7);
      const monthDocRef  = docRef.collection("months").doc(currentMonth);
      const monthSnap    = await monthDocRef.get();
      let monthData      = monthSnap.exists
        ? monthSnap.data()
        : { categories: [], transactions: [], tbb: data.tbb || 0, availableBalance: 0, currentMonth };

      // ✅ Use availableBalance (real cash on hand), NOT tbb (unbudgeted money)
      const currentAvailableBalance = monthData.availableBalance || 0;
      if (currentAvailableBalance < amount) {
        const _okPay2 = await showConfirm(
          `Paying ${formatCurrency(amount)} exceeds your Available Balance of ${formatCurrency(currentAvailableBalance)}. Proceed anyway?`,
          { confirmText: "Proceed", cancelText: "Cancel", type: "warning" }
        );
        if (!_okPay2) return;
      }

      // Reduce the liability balance (paying off debt)
      data.accounts[transactionAccountIndex].balance = Math.max(0, (data.accounts[transactionAccountIndex].balance || 0) - amount);

      // Advance due date if paid
      const dueDay = data.accounts[transactionAccountIndex].dueDay;
      if (dueDay) {
        const today = new Date();
        let nextDue = new Date(today.getFullYear(), today.getMonth(), dueDay);
        if (nextDue <= today) nextDue = new Date(today.getFullYear(), today.getMonth() + 1, dueDay);
        // Payment made — advance to next cycle
        nextDue = new Date(nextDue.getFullYear(), nextDue.getMonth() + 1, dueDay);
        data.accounts[transactionAccountIndex].lastPaidDate = today.toISOString().slice(0, 10);
        data.accounts[transactionAccountIndex].nextDueOverride = nextDue.toISOString().slice(0, 10);
      }

      // ✅ Deduct from availableBalance (real cash), NOT from tbb
      monthData.availableBalance = currentAvailableBalance - amount;

      const payTransaction = {
        id: transactionId,
        date,
        name: reason || `Payment — ${sourceAccount.name}`,
        category: sourceAccount.name,   // liability account name as category
        amount,
        type: 'expense',
        outflow: amount,
        inflow: 0,
        isLiabilityPayment: true,
        liabilityAccount: sourceAccount.name,
        isAccountOnlyTxn: true,
        accountName: sourceAccount.name
      };

      monthData.transactions.push(payTransaction);
      await docRef.update({ accounts: data.accounts });
      await monthDocRef.set(monthData);

      accounts = data.accounts;
      closeTransactionPanel();
      renderAccounts(accounts);
      await loadMonthData(currentMonth);
      await loadBudget();
      showToast(`${formatCurrency(amount)} payment recorded for ${sourceAccount.name}. Due date advanced.`, "success");
      return;
    }

    // ===== EXPENSE from LIABILITY (credit card charge) =====
    if (type === 'expense' && isLiability) {
      const catIndex = parseInt(wrapper.querySelector('#expense-category').value);

      const currentMonth = availableMonths[currentMonthIndex] || data.currentMonth || new Date().toISOString().slice(0, 7);
      const monthDocRef  = docRef.collection("months").doc(currentMonth);
      const monthSnap    = await monthDocRef.get();
      let monthData      = monthSnap.exists
        ? monthSnap.data()
        : { categories: [], transactions: [], tbb: data.tbb || 0, currentMonth };

      const categoryName = (monthData.categories[catIndex] && monthData.categories[catIndex].name) || "Uncategorized";

      // Increase the liability balance (spending on credit = more owed)
      data.accounts[transactionAccountIndex].balance = (data.accounts[transactionAccountIndex].balance || 0) + amount;

      // Deduct from budget category spent
      if (monthData.categories[catIndex]) {
        monthData.categories[catIndex].spent   = (monthData.categories[catIndex].spent || 0) + amount;
        monthData.categories[catIndex].balance = (Number(monthData.categories[catIndex].startingBalance) || 0) +
          monthData.categories[catIndex].assigned - monthData.categories[catIndex].spent;
      }

      const expenseTransaction = {
        id: transactionId,
        date,
        name: reason || sourceAccount.name,
        category: categoryName,
        amount,
        type: 'expense',
        outflow: amount,
        inflow: 0,
        fromLiability: true,
        fromAccount: sourceAccount.name,   // liability account name
        fromAsset: false
      };

      monthData.transactions.push(expenseTransaction);
      await docRef.update({ accounts: data.accounts });
      await monthDocRef.set(monthData);

      accounts = data.accounts;
      closeTransactionPanel();
      renderAccounts(accounts);
      await loadMonthData(currentMonth);
      await loadBudget();
      showToast(`${formatCurrency(amount)} expense on "${categoryName}" charged to ${sourceAccount.name}`, "success");
      return;
    }

    // ===== ASSET account transactions (deposit / withdrawal / transfer / expense) =====
    let newTransaction = {
      id: transactionId,
      date,
      name: reason || sourceAccount.name,
      category: type === "deposit" ? "Deposit" : type === "withdrawal" ? "Withdrawal" : type === "transfer" ? "Transfer" : "",
      amount,
      type: type === "withdrawal" ? "income" : type === "transfer" ? "transfer" : "expense",
      inflow: 0, outflow: 0, fromAccount: null, toAccount: null,
      isAccountOnlyTxn: (type === 'deposit' || type === 'withdrawal' || type === 'transfer'),
      accountName: sourceAccount.name
    };

    if (type === "deposit") {
      data.accounts[transactionAccountIndex].balance += amount;
      newTransaction.outflow = amount;
      newTransaction.type    = "expense";

    } else if (type === "withdrawal") {
      if (data.accounts[transactionAccountIndex].balance < amount) { showToast("Insufficient balance — not enough funds in this account.", "error"); return; }
      data.accounts[transactionAccountIndex].balance -= amount;
      newTransaction.inflow = amount;
      newTransaction.type   = "income";

    } else if (type === "transfer") {
      const targetIndex = parseInt(wrapper.querySelector('#transfer-target').value);
      if (data.accounts[transactionAccountIndex].balance < amount) { showToast("Insufficient balance — not enough funds in this account.", "error"); return; }
      data.accounts[transactionAccountIndex].balance  -= amount;
      data.accounts[targetIndex].balance              += amount;
      newTransaction.outflow     = amount;
      newTransaction.inflow      = amount;
      newTransaction.fromAccount = data.accounts[transactionAccountIndex].name;
      newTransaction.toAccount   = data.accounts[targetIndex].name;

    } else if (type === "expense") {
      if (data.accounts[transactionAccountIndex].balance < amount) { showToast("Insufficient balance — not enough funds in this account.", "error"); return; }
      const catIndex = parseInt(wrapper.querySelector('#expense-category').value);

      const currentMonth = availableMonths[currentMonthIndex] || data.currentMonth || new Date().toISOString().slice(0, 7);
      const monthDocRef  = docRef.collection("months").doc(currentMonth);
      const monthSnap    = await monthDocRef.get();
      let monthData      = monthSnap.exists
        ? monthSnap.data()
        : { categories: JSON.parse(JSON.stringify(data.categories || [])), transactions: [], tbb: data.tbb || 0, currentMonth };

      const categoryName = (monthData.categories[catIndex] && monthData.categories[catIndex].name) || "Uncategorized";
      data.accounts[transactionAccountIndex].balance -= amount;

      if (monthData.categories[catIndex]) {
        monthData.categories[catIndex].spent   = (monthData.categories[catIndex].spent || 0) + amount;
        monthData.categories[catIndex].balance = (Number(monthData.categories[catIndex].startingBalance) || 0) +
          monthData.categories[catIndex].assigned - monthData.categories[catIndex].spent;
      }

      newTransaction.category = categoryName;
      newTransaction.outflow  = amount;
      newTransaction.type     = "expense";

      const sourceAccountType = ACCOUNT_TYPES[data.accounts[transactionAccountIndex].type];
      if (sourceAccountType && sourceAccountType.category === 'asset') {
        newTransaction.fromAsset    = true;
        newTransaction.fromAccount  = data.accounts[transactionAccountIndex].name;
      }

      monthData.transactions.push(newTransaction);

      await docRef.update({ accounts: data.accounts });
      await monthDocRef.set(monthData);

      accounts = data.accounts;
      closeTransactionPanel();
      renderAccounts(accounts);
      await loadMonthData(currentMonth);
      await loadBudget();

      showToast(`${formatCurrency(amount)} expense under "${categoryName}" recorded from ${data.accounts[transactionAccountIndex].name}`, "success");
      return;
    }

    // deposit / withdrawal / transfer shared path
    await docRef.update({ accounts: data.accounts });

    // currentMonth already declared above — reuse it here
    const monthDocRef  = docRef.collection("months").doc(currentMonth);
    const monthSnap    = await monthDocRef.get();
    let monthData      = monthSnap.exists
      ? monthSnap.data()
      : { categories: JSON.parse(JSON.stringify(data.categories || [])), transactions: [], tbb: data.tbb || 0, currentMonth };

    if (type === "withdrawal") monthData.tbb = (monthData.tbb || 0) - amount;

    monthData.transactions.push(newTransaction);
    await monthDocRef.set(monthData);

    accounts = data.accounts;
    closeTransactionPanel();
    renderAccounts(accounts);
    await loadMonthData(currentMonth);
    await loadBudget();

    if (type === "deposit")         showToast(`${formatCurrency(amount)} deposited to ${data.accounts[transactionAccountIndex].name}`, "success");
    else if (type === "withdrawal") showToast(`${formatCurrency(amount)} withdrawn from ${data.accounts[transactionAccountIndex].name}`, "success");
    else if (type === "transfer")   showToast(`${formatCurrency(amount)} transferred successfully`, "success");
  });

  // Highlight + button and account row
  if (accountItem) accountItem.classList.add('txn-active');
  if (btn) {
    btn.classList.add('open');
    // Swap + to × while open
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    btn.title = 'Close';
  }

  // Close when clicking outside the popover
  const outsideHandler = (e) => {
    if (!wrapper.contains(e.target) && !btn.contains(e.target)) {
      closeTransactionPanel();
      document.removeEventListener('mousedown', outsideHandler);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', outsideHandler), 50);

  // Animate open
  requestAnimationFrame(() => {
    popover.classList.add('open');
    setTimeout(() => wrapper.querySelector('#transaction-amount')?.focus(), 180);
  });
}

// Legacy alias — kept so any other code referencing openTransactionModal still works
const openTransactionModal = openTransactionPanel;


// Load accounts automatically after login
auth.onAuthStateChanged(async (user) => {
  if (user) {
    currentUser = user;
    await loadAccounts();
  }
});


///// BUDGET SECTION - Google-style with Modal //////
function renderBudgetSection(categories, transactions) {
  const tbody = document.getElementById("budget-table-body");
  tbody.innerHTML = ""; // Clear previous rows

  if (categories.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="bm-empty-row">
      No categories yet. Tap <strong>+ Category</strong> on the dashboard to add your first one.
    </td></tr>`;
  } else {
    categories.forEach((c, index) => {
      const balance = categoryBalance(c);
      const row = document.createElement("tr");
      row.innerHTML = `
        <td><input type="checkbox" class="category-checkbox" data-index="${index}" /></td>
        <td>${c.name}</td>
        <td>${formatCurrency(c.assigned)}</td>
        <td>${formatCurrency(c.spent)}</td>
        <td style="color:${balance<0?'red':'green'}">${formatCurrency(balance)}</td>
      `;
      tbody.appendChild(row);
    });

    document.querySelectorAll(".category-checkbox").forEach(cb => {
      cb.checked = false;
      cb.addEventListener("change", async (e) => {
        if (!e.target.checked) return;
        const idx = parseInt(e.target.dataset.index);
        selectedCategoryIndex = idx;
        await openCategoryModal(categories[idx], transactions);
        e.target.checked = false;
      });
    });
  }

  // Also render the Income This Month list
  renderIncomeList(transactions);
}

// ── Render income transactions as a minimal table inside Budget section ───
function renderIncomeList(transactions) {
  const listEl = document.getElementById("bm-income-list");
  if (!listEl) return;

  const incomes = (transactions || []).filter(t =>
    t.type === "income" && !t.isAccountOnlyTxn &&
    t.category !== "BALANCE FROM LAST MONTH"
  );

  if (incomes.length === 0) {
    listEl.innerHTML = `
      <div class="bm-income-empty">
        No income recorded this month. Add income from the dashboard to see entries here.
      </div>`;
    return;
  }

  // Sort newest first
  const sorted = [...incomes].sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const total = sorted.reduce((s, t) => s + (t.amount || t.inflow || 0), 0);

  listEl.innerHTML = `
    <table class="bm-income-table">
      <thead>
        <tr>
          <th>Description</th>
          <th>Date</th>
          <th class="bm-num">Amount</th>
          <th class="bm-actions-col"></th>
        </tr>
      </thead>
      <tbody>
        ${sorted.map(t => {
          const id   = t.id || "";
          const name = (t.name || "Income").replace(/</g, "&lt;").replace(/"/g, "&quot;");
          const amt  = formatCurrency(t.amount || t.inflow || 0);
          const dt   = t.date ? formatDate(t.date) : "—";
          return `
          <tr data-tx-id="${id}">
            <td class="bm-income-name">${name}</td>
            <td class="bm-income-date">${dt}</td>
            <td class="bm-num bm-income-amount">${amt}</td>
            <td class="bm-actions-col">
              <button class="bm-row-action bm-income-edit"   data-tx-id="${id}" aria-label="Edit" title="Edit">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
              </button>
              <button class="bm-row-action bm-income-delete" data-tx-id="${id}" aria-label="Delete" title="Delete">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="2" class="bm-income-total-label">Total · ${sorted.length} entr${sorted.length === 1 ? "y" : "ies"}</td>
          <td class="bm-num bm-income-total-amount">${formatCurrency(total)}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;

  listEl.querySelectorAll(".bm-income-edit").forEach(btn => {
    btn.addEventListener("click", () => editIncome(btn.dataset.txId, sorted));
  });
  listEl.querySelectorAll(".bm-income-delete").forEach(btn => {
    btn.addEventListener("click", () => deleteTransaction("Income", btn.dataset.txId));
  });
}

// ── Edit existing income — opens the same modal in edit mode ──────────────
function editIncome(txId, incomes) {
  const tx = incomes.find(t => t.id === txId);
  if (!tx) { showToast("Income entry not found.", "error"); return; }

  document.getElementById("income-modal-title").textContent = "Edit Income";
  document.getElementById("incomeEditId").value     = tx.id || "";
  document.getElementById("incomeAmount").value      = tx.amount || tx.inflow || "";
  document.getElementById("incomeDescription").value = tx.name || "";
  document.getElementById("incomeDate").value        = tx.date || new Date().toISOString().slice(0, 10);
  openModal("incomeModal");
}

// ── Unified save: branches between add and edit based on incomeEditId ────
async function saveIncome() {
  const editId = (document.getElementById("incomeEditId").value || "").trim();
  if (!editId) {
    // New income — existing flow
    await addIncome();
    closeModal("incomeModal");
    resetIncomeModal();
    return;
  }

  // Edit flow: delete the old entry, then add the new one
  // Both operations use the engine path so they\'re atomic + auditable
  const amount      = parseFloat(document.getElementById("incomeAmount").value);
  const description = document.getElementById("incomeDescription").value.trim();
  const date        = document.getElementById("incomeDate").value || new Date().toISOString().slice(0, 10);

  if (isNaN(amount) || amount <= 0) {
    showToast("Please enter a valid income amount.", "error");
    return;
  }

  try {
    // Delete the old transaction (this reverses its TBB effect)
    await _deleteIncomeSilent(editId);
    // Add a fresh one with the new values
    await addIncome();
    closeModal("incomeModal");
    resetIncomeModal();
    showToast("Income updated successfully.", "success");
  } catch (err) {
    console.error("[Income edit] failed:", err);
    showToast("Failed to update income. Please try again.", "error");
  }
}

// Internal: reverse an income transaction without showing the confirm dialog
async function _deleteIncomeSilent(txId) {
  if (!currentUser) throw new Error("No user");
  const docRef    = db.collection("budget").doc(currentUser.uid);
  const monthKey  = availableMonths[currentMonthIndex] || new Date().toISOString().slice(0, 7);
  const monthRef  = docRef.collection("months").doc(monthKey);

  await runWithRetry(db, async (txn) => {
    const monthSnap = await txn.get(monthRef);
    if (!monthSnap.exists) throw new Error("Month data not found");
    const m = monthSnap.data();
    const idx = (m.transactions || []).findIndex(t => t.id === txId);
    if (idx === -1) throw new Error("Transaction not found");
    const tx = m.transactions[idx];

    // Reverse TBB
    m.tbb = Math.max(0, (m.tbb || 0) - (tx.amount || tx.inflow || 0));
    // Reverse availableBalance (engine owns this)
    m.availableBalance = Math.max(0, (m.availableBalance || 0) - (tx.amount || tx.inflow || 0));
    // Remove the transaction
    m.transactions.splice(idx, 1);
    txn.set(monthRef, m);
  });
}

function resetIncomeModal() {
  document.getElementById("income-modal-title").textContent = "Add Income";
  document.getElementById("incomeEditId").value     = "";
  document.getElementById("incomeAmount").value      = "";
  document.getElementById("incomeDescription").value = "";
  document.getElementById("incomeDate").value        = "";
}


async function loadBudgetSection() {
  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();

  // ✅ If root doc doesn't exist, initialize
  if (!docSnap.exists) {
    const initData = { 
      tbb: 0, 
      categories: [], 
      transactions: [], 
      currentMonth: new Date().toISOString().slice(0, 7) 
    };
    await docRef.set(initData);
  }

  const data = (await docRef.get()).data();
  // ✅ Respect selected filter (like filterByMonth)
  const selectedMonth = availableMonths[currentMonthIndex];
  const targetMonth = selectedMonth || data.currentMonth || new Date().toISOString().slice(0, 7);

  const monthRef = docRef.collection("months").doc(targetMonth);
  const monthSnap = await monthRef.get();

  let monthData;
  if (monthSnap.exists) {
    monthData = monthSnap.data();
  } else {
    // ✅ If month doc doesn’t exist, clone root categories
    monthData = {
      categories: JSON.parse(JSON.stringify(data.categories || [])),
      transactions: [],
      tbb: data.tbb || 0,
      currentMonth: targetMonth,
    };
    await monthRef.set(monthData);
  }

  // Reset selection on reload
  selectedCategoryIndex = null;

  renderBudgetSection(monthData.categories || [], monthData.transactions || []);
}







// Format the date in a more readable format (e.g., "Sep 10, 2025")
function formatDate(date) {
  const options = { year: 'numeric', month: 'short', day: 'numeric' };
  return new Date(date).toLocaleDateString('en-US', options);
}






// Open category modal and render transactions in YNAB style
async function openCategoryModal(category, transactions) {
  // Populate name input
  document.getElementById("category-name-input").value = category.name;

  // Update header
  document.getElementById("cat-modal-display-name").textContent = category.name;

  // Summary bar
  const assigned = category.assigned || 0;
  const spent    = category.spent    || 0;
  const balance  = assigned - spent;
  document.getElementById("cat-sum-assigned").textContent = formatCurrency(assigned);
  document.getElementById("cat-sum-spent").textContent    = formatCurrency(spent);
  const balEl = document.getElementById("cat-sum-balance");
  balEl.textContent  = formatCurrency(balance);
  balEl.style.color  = balance < 0 ? 'var(--ynab-red)' : balance === 0 ? 'var(--text)' : 'var(--ynab-green)';

  // Filter transactions
  const catTxns = transactions.filter(t => t.category === category.name);

  // Subtitle
  document.getElementById("cat-modal-subtitle").textContent =
    catTxns.length === 0 ? 'No transactions' :
    catTxns.length === 1 ? '1 transaction' : `${catTxns.length} transactions`;

  // Build transaction list
  const txList  = document.getElementById("category-transactions-list");
  const emptyEl = document.getElementById("cat-txn-empty");
  txList.innerHTML = "";

  if (catTxns.length === 0) {
    emptyEl.style.display = 'flex';
  } else {
    emptyEl.style.display = 'none';

    // Sort by date descending
    const sorted = [...catTxns].sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    sorted.forEach(t => {
      const isExpense   = t.type === 'expense';
      const amountClass = isExpense ? 'outflow' : 'inflow';
      const sign        = isExpense ? '−' : '+';
      const formattedAmt = sign + formatCurrency(t.amount);

      // SVG icon for transaction type
      const dotSvg = isExpense
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>`;

      // Payee / description name
      const payee = t.name || t.payee || category.name;

      // Source chip — text only, no emoji
      let chipLabel = '', chipClass = 'available';
      if (t.fromLiability && t.fromAccount) {
        chipLabel = t.fromAccount;
        chipClass = 'liability';
      } else if (t.fromAsset && t.fromAccount) {
        chipLabel = t.fromAccount;
        chipClass = 'asset';
      } else {
        chipLabel = 'Available Balance';
        chipClass = 'available';
      }

      // Date nicely formatted: "Jun 5, 2026"
      let dateStr = '';
      try {
        dateStr = new Date(t.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      } catch(e) { dateStr = t.date || ''; }

      const li = document.createElement('li');
      li.className = 'cat-txn-item';
      li.innerHTML = `
        <div class="cat-txn-dot ${isExpense ? 'expense' : 'income'}">${dotSvg}</div>
        <div class="cat-txn-body">
          <div class="cat-txn-name">${payee}</div>
          <div class="cat-txn-meta">
            <span class="cat-txn-date">${dateStr}</span>
            <span class="cat-txn-source-chip ${chipClass}">${chipLabel}</span>
          </div>
        </div>
        <div class="cat-txn-right">
          <span class="cat-txn-amount ${amountClass}">${formattedAmt}</span>
          <button class="cat-txn-delete delete-tx-btn" data-id="${t.id}" title="Delete transaction">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      `;
      txList.appendChild(li);
    });
  }

  // Attach delete handlers
  document.querySelectorAll(".delete-tx-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const txId = e.currentTarget.dataset.id;
      await deleteTransaction(category.name, txId);
    });
  });

  openModal("category-modal");
}



document.getElementById("save-category-btn").addEventListener("click", async () => {
  if (selectedCategoryIndex === null) return;

  const newName = document.getElementById("category-name-input").value.trim();
  if (!newName) return showToast("Enter a category name", "error");

  if (!currentUser) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
const selectedMonth = availableMonths[currentMonthIndex] || new Date().toISOString().slice(0, 7);
  const monthRef = docRef.collection("months").doc(selectedMonth);
  const monthSnap = await monthRef.get();
  if (!monthSnap.exists) return showToast("Month data not found", "error");

  let monthData = monthSnap.data();
  if (!monthData.categories[selectedCategoryIndex]) return showToast("Category not found", "error");

  const oldName = monthData.categories[selectedCategoryIndex].name;
  monthData.categories[selectedCategoryIndex].name = newName;

  // ✅ Update transactions with new name
  monthData.transactions = monthData.transactions.map(t =>
    t.category === oldName ? { ...t, category: newName } : t
  );

  await monthRef.set(monthData);

  closeModal("category-modal");
  await loadBudgetSection();

  showToast(`Category renamed from "${oldName}" to "${newName}"`, "success");
});

// ✅ Delete category
document.getElementById("delete-category-btn").addEventListener("click", async () => {
  const _okDelCat = await showConfirm(
    "Delete this category? This cannot be undone.",
    { confirmText: "Delete", cancelText: "Cancel", type: "danger" }
  );
  if (!_okDelCat) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  let data = docSnap.exists ? docSnap.data() : null;
  if (!data) return;

  const currentMonth = data.currentMonth || new Date().toISOString().slice(0, 7);
  const monthRef = docRef.collection("months").doc(currentMonth);
  const monthSnap = await monthRef.get();
  let monthData = monthSnap.exists ? monthSnap.data() : { categories: [], transactions: [], tbb: data.tbb };

  if (selectedCategoryIndex == null || !monthData.categories[selectedCategoryIndex]) return;

  const cat = monthData.categories[selectedCategoryIndex];
  const catName = cat.name;

  // ✅ Return assigned to TBB
  monthData.tbb += (cat.assigned || 0);

  // ✅ Remove category
  monthData.categories.splice(selectedCategoryIndex, 1);

  // ✅ Remove related transactions
  monthData.transactions = monthData.transactions.filter(t => t.category !== catName);

  await monthRef.set(monthData);

  closeModal("category-modal");

  // Refresh both Budget section AND Dashboard so deletion reflects everywhere immediately
  await loadBudgetSection();
  await loadMonthData(availableMonths[currentMonthIndex] || currentMonth);
  await loadBudget();

  showToast(`Category "${catName}" deleted successfully`, "success");
});

// ✅ Delete transaction (and return amount to category)
async function deleteTransaction(categoryName, txId) {
  const _okDelTxn = await showConfirm(
    "Delete this transaction? This cannot be undone.",
    { confirmText: "Delete", cancelText: "Cancel", type: "danger" }
  );
  if (!_okDelTxn) return;
  if (!currentUser) return;

  const docRef       = db.collection("budget").doc(currentUser.uid);
  const selectedMonth = availableMonths[currentMonthIndex] || new Date().toISOString().slice(0, 7);
  const monthRef     = docRef.collection("months").doc(selectedMonth);

  // ── Engine path (Phase 7) — atomic runWithRetry ──────────────────────────
  if (FEATURE_FLAGS.useEngineForDelete) {
    try {
      let tx = null;

      await runWithRetry(db, async (txn) => {
        const [monthSnap, rootSnap] = await Promise.all([
          txn.get(monthRef),
          txn.get(docRef),
        ]);
        if (!monthSnap.exists) throw new Error("Month data not found");

        const monthData = monthSnap.data();
        const rootData  = rootSnap.exists ? rootSnap.data() : { accounts: [] };

        const txIndex = monthData.transactions.findIndex(t => t.id === txId);
        if (txIndex === -1) throw new Error("Transaction not found");
        tx = monthData.transactions[txIndex];

        // ── Reverse category effects ────────────────────────────────────────
        const cat = monthData.categories.find(c => c.name === categoryName);

        if (tx.type === "expense" && !tx.isAccountOnlyTxn) {
          // Reverse expense: restore category spent and balance
          if (cat) {
            cat.spent   = Math.max(0, (cat.spent || 0) - tx.amount);
            cat.balance = (Number(cat.startingBalance) || 0) + cat.assigned - cat.spent;
          }
        } else if (tx.type === "income" && !tx.isAccountOnlyTxn) {
          // A5 fix: income always goes to TBB — restore it regardless of whether
          // categoryName matches a real budget category ("Income" is never in categories[])
          monthData.tbb = Math.max(0, (monthData.tbb || 0) - tx.amount);
        }

        // ── Reverse account effects ─────────────────────────────────────────
        const updatedAccounts = rootData.accounts.map(a => ({ ...a }));

        if (tx.fromAsset && tx.fromAccount) {
          // Reverse asset-funded expense: restore asset balance
          const i = updatedAccounts.findIndex(a => a.name === tx.fromAccount);
          if (i !== -1) updatedAccounts[i].balance = (updatedAccounts[i].balance || 0) + tx.amount;
        }

        if (tx.fromLiability && tx.fromAccount) {
          // Reverse liability charge: reduce amount owed
          const i = updatedAccounts.findIndex(a => a.name === tx.fromAccount);
          if (i !== -1) updatedAccounts[i].balance = Math.max(0, (updatedAccounts[i].balance || 0) - tx.amount);
        }

        if (tx.isLiabilityPayment) {
          // Reverse liability payment: restore liability balance + restore TBB
          const accName = tx.liabilityAccount || tx.fromAccount || tx.accountName;
          const i = updatedAccounts.findIndex(a => a.name === accName);
          if (i !== -1) {
            updatedAccounts[i].balance = (updatedAccounts[i].balance || 0) + tx.amount;
            if (updatedAccounts[i].nextDueOverride) delete updatedAccounts[i].nextDueOverride;
            if (updatedAccounts[i].lastPaidDate)    delete updatedAccounts[i].lastPaidDate;
          }
          monthData.tbb = (monthData.tbb || 0) + tx.amount;
        }

        // ── Remove transaction ──────────────────────────────────────────────
        monthData.transactions.splice(txIndex, 1);

        // ── Write both docs atomically ──────────────────────────────────────
        txn.set(monthRef, monthData);
        txn.set(docRef, { ...rootData, accounts: updatedAccounts }, { merge: true });
      });

      // ── Refresh UI ────────────────────────────────────────────────────────
      accounts = (await docRef.get()).data().accounts || [];
      await loadBudgetSection();
      renderAccounts(accounts);
      const freshMonth = await monthRef.get();
      renderBudget(freshMonth.exists ? freshMonth.data() : {});
      closeModal("category-modal");

      let toastMsg = "Transaction deleted";
      if (tx && tx.fromAsset)          toastMsg += " — asset balance restored";
      else if (tx && tx.fromLiability) toastMsg += " — liability balance restored";
      else if (tx && tx.isLiabilityPayment) toastMsg += " — payment reversed, liability restored";
      showToast(toastMsg, "success");
      return;

    } catch (err) {
      console.error("[Phase 7] Engine deleteTransaction error:", err);
      showToast(err.message || "Failed to delete transaction.", "error");
      return;
    }
  }

  // ── Legacy inline path (original code, untouched) ────────────────────────
  const monthSnap = await monthRef.get();
  if (!monthSnap.exists) return showToast("Month data not found", "error");

  let monthData = monthSnap.data();
  const txIndex = monthData.transactions.findIndex((t) => t.id === txId);
  if (txIndex === -1) { showToast("Transaction not found.", "error"); return; }

  const tx = monthData.transactions[txIndex];

  const cat = monthData.categories.find((c) => c.name === categoryName);

  if (tx.type === "expense" && !tx.isAccountOnlyTxn) {
    // Reverse expense: restore category spent and balance
    if (cat) {
      cat.spent -= tx.amount;
      if (cat.spent < 0) cat.spent = 0;
      cat.balance = (Number(cat.startingBalance) || 0) + cat.assigned - cat.spent;
    }
  } else if (tx.type === "income" && !tx.isAccountOnlyTxn) {
    // A5 fix: income goes to TBB — restore it directly, not via category
    // (the old code reduced cat.assigned which was wrong and had no effect
    //  since "Income" is never a real budget category)
    monthData.tbb = Math.max(0, (monthData.tbb || 0) - tx.amount);
  }

  const rootSnap = await docRef.get();
  let rootData = rootSnap.exists ? rootSnap.data() : null;

  if (tx.fromAsset && tx.fromAccount && rootData) {
    const accIdx = rootData.accounts.findIndex(a => a.name === tx.fromAccount);
    if (accIdx !== -1) {
      rootData.accounts[accIdx].balance += tx.amount;
      await docRef.update({ accounts: rootData.accounts });
      accounts = rootData.accounts;
    }
  }

  if (tx.fromLiability && tx.fromAccount && rootData) {
    const accIdx = rootData.accounts.findIndex(a => a.name === tx.fromAccount);
    if (accIdx !== -1) {
      rootData.accounts[accIdx].balance = Math.max(0, (rootData.accounts[accIdx].balance || 0) - tx.amount);
      await docRef.update({ accounts: rootData.accounts });
      accounts = rootData.accounts;
    }
  }

  if (tx.isLiabilityPayment && tx.liabilityAccount && rootData) {
    const accIdx = rootData.accounts.findIndex(a => a.name === tx.liabilityAccount);
    if (accIdx !== -1) {
      rootData.accounts[accIdx].balance = (rootData.accounts[accIdx].balance || 0) + tx.amount;
      if (rootData.accounts[accIdx].nextDueOverride) {
        delete rootData.accounts[accIdx].nextDueOverride;
        delete rootData.accounts[accIdx].lastPaidDate;
      }
      await docRef.update({ accounts: rootData.accounts });
      accounts = rootData.accounts;
    }
    monthData.tbb = (monthData.tbb || 0) + tx.amount;
  }

  monthData.transactions.splice(txIndex, 1);
  await monthRef.set(monthData);
  await loadBudgetSection();
  renderAccounts(accounts);
  renderBudget(monthData);
  closeModal("category-modal");

  let toastMsg = "Transaction deleted";
  if (tx.fromAsset) toastMsg += " — asset balance restored";
  else if (tx.fromLiability) toastMsg += " — liability balance restored";
  else if (tx.isLiabilityPayment) toastMsg += " — payment reversed, liability restored";
  showToast(toastMsg, "success");
}









// ===== Account Transaction History (Deposit / Withdraw / Transfer / Pay) =====

async function toggleAccountHistory(index) {
  const panel = document.getElementById(`acct-txn-history-${index}`);
  const btn   = document.getElementById(`btn-recent-${index}`);
  if (!panel) return;
  if (panel.style.display === 'none' || panel.style.display === '') {
    panel.style.display = 'block';
    if (btn) btn.classList.add('open');
    await loadAccountTransactionHistory(index);
  } else {
    panel.style.display = 'none';
    if (btn) btn.classList.remove('open');
  }
}

async function loadAccountTransactionHistory(index) {
  if (!currentUser) return;
  const body = document.getElementById(`acct-txn-history-body-${index}`);
  if (!body) return;
  const acc = accounts[index];
  if (!acc) return;

  const docRef = db.collection("budget").doc(currentUser.uid);
  let acctTxns = [];

  for (const monthKey of availableMonths) {
    const monthSnap = await docRef.collection("months").doc(monthKey).get();
    if (!monthSnap.exists) continue;
    const txns = monthSnap.data().transactions || [];
    txns.forEach(t => {
      const match = t.isAccountOnlyTxn && (
        t.accountName === acc.name ||
        t.liabilityAccount === acc.name ||
        t.fromAccount === acc.name ||
        t.toAccount === acc.name
      );
      if (match) acctTxns.push({ ...t, _month: monthKey });
    });
  }

  acctTxns.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  if (acctTxns.length === 0) {
    body.innerHTML = '<p style="color:var(--text-light);font-size:12px;margin:4px 0;">No transactions recorded yet.</p>';
    return;
  }

  const rows = acctTxns.map(t => {
    let typeLabel = t.category || 'Transaction';
    let amountStr = '';
    let amtColor  = 'var(--text)';

    if (t.isLiabilityPayment) {
      typeLabel = 'Payment';
      amountStr = '\u2212' + formatCurrency(t.amount);
      amtColor  = '#ef4444';
    } else if (t.category === 'Deposit') {
      typeLabel = 'Deposit';
      amountStr = '+' + formatCurrency(t.amount);
      amtColor  = '#10b981';
    } else if (t.category === 'Withdrawal') {
      typeLabel = 'Withdrawal';
      amountStr = '\u2212' + formatCurrency(t.amount);
      amtColor  = '#ef4444';
    } else if (t.category === 'Transfer') {
      const dir = t.fromAccount === acc.name
        ? '\u2192 ' + t.toAccount
        : '\u2190 ' + t.fromAccount;
      typeLabel  = 'Transfer ' + dir;
      amountStr  = t.fromAccount === acc.name
        ? '\u2212' + formatCurrency(t.amount)
        : '+'       + formatCurrency(t.amount);
      amtColor   = t.fromAccount === acc.name ? '#ef4444' : '#10b981';
    }

    const noteName = (t.name && t.name !== acc.name) ? ' \u00b7 ' + t.name : '';
    let dateStr = '';
    try {
      dateStr = new Date(t.date + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric'
      });
    } catch(e) { dateStr = t.date || ''; }

    return '<div style="display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid var(--ynab-border);">'
      + '<span style="font-size:11px;color:var(--text-light);min-width:84px;flex-shrink:0;">' + dateStr + '</span>'
      + '<span style="font-size:12px;color:var(--text);flex:1;">' + typeLabel + noteName + '</span>'
      + '<span style="font-size:12px;font-weight:700;color:' + amtColor + ';min-width:82px;text-align:right;flex-shrink:0;">' + amountStr + '</span>'
      + '<button onclick="deleteAccountTransaction(\'' + t.id + '\',\'' + t._month + '\',' + index + ')"'
      + ' title="Delete"'
      + ' style="background:none;border:1px solid rgba(239,68,68,.35);border-radius:6px;cursor:pointer;color:#ef4444;'
      + 'width:26px;height:26px;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s,color .15s;"'
      + ' onmouseover="this.style.background=\'#ef4444\';this.style.color=\'#fff\'"'
      + ' onmouseout="this.style.background=\'none\';this.style.color=\'#ef4444\'">'
      + '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">'
      + '<polyline points="3 6 5 6 21 6"/>'
      + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
      + '</svg>'
      + '</button>'
      + '</div>';
  }).join('');

  body.innerHTML =
    '<div style="font-size:10px;font-weight:700;color:var(--text-light);margin-bottom:6px;text-transform:uppercase;letter-spacing:.6px;">Transaction History</div>'
    + rows;
}

async function deleteAccountTransaction(txId, monthKey, accountIndex) {
  const _okDelAcctTxn = await showConfirm(
    "Delete this transaction? The account balance will be reversed. This cannot be undone.",
    { confirmText: "Delete", cancelText: "Cancel", type: "danger" }
  );
  if (!_okDelAcctTxn) return;
  if (!currentUser) return;

  const docRef   = db.collection("budget").doc(currentUser.uid);
  const monthRef = docRef.collection("months").doc(monthKey);

  // ── Engine path (Phase 7) — atomic runWithRetry ──────────────────────────
  if (FEATURE_FLAGS.useEngineForDelete) {
    try {
      await runWithRetry(db, async (txn) => {
        const [monthSnap, rootSnap] = await Promise.all([
          txn.get(monthRef),
          txn.get(docRef),
        ]);
        if (!monthSnap.exists) throw new Error("Month data not found");

        const monthData = monthSnap.data();
        const rootData  = rootSnap.exists ? rootSnap.data() : { accounts: [] };

        const txIndex = monthData.transactions.findIndex(t => t.id === txId);
        if (txIndex === -1) throw new Error("Transaction not found");
        const tx = monthData.transactions[txIndex];

        const updatedAccounts = rootData.accounts.map(a => ({ ...a }));

        if (tx.category === 'Deposit') {
          // Reverse deposit: remove money from account back to budget
          const i = updatedAccounts.findIndex(a => a.name === tx.accountName);
          if (i !== -1) updatedAccounts[i].balance = (updatedAccounts[i].balance || 0) - tx.amount;

        } else if (tx.category === 'Withdrawal') {
          // Reverse withdrawal: put money back into account from budget
          const i = updatedAccounts.findIndex(a => a.name === tx.accountName);
          if (i !== -1) updatedAccounts[i].balance = (updatedAccounts[i].balance || 0) + tx.amount;
          // Also restore TBB (withdrawal decremented it when created)
          monthData.tbb = (monthData.tbb || 0) + tx.amount;

        } else if (tx.category === 'Transfer') {
          // Reverse transfer: restore both accounts
          if (tx.fromAccount) {
            const fi = updatedAccounts.findIndex(a => a.name === tx.fromAccount);
            if (fi !== -1) updatedAccounts[fi].balance = (updatedAccounts[fi].balance || 0) + tx.amount;
          }
          if (tx.toAccount) {
            const ti = updatedAccounts.findIndex(a => a.name === tx.toAccount);
            if (ti !== -1) updatedAccounts[ti].balance = (updatedAccounts[ti].balance || 0) - tx.amount;
          }

        } else if (tx.isLiabilityPayment) {
          // Reverse liability payment: restore liability balance
          const accName = tx.liabilityAccount || tx.accountName;
          const i = updatedAccounts.findIndex(a => a.name === accName);
          if (i !== -1) {
            updatedAccounts[i].balance = (updatedAccounts[i].balance || 0) + tx.amount;
            if (updatedAccounts[i].nextDueOverride) delete updatedAccounts[i].nextDueOverride;
            if (updatedAccounts[i].lastPaidDate)    delete updatedAccounts[i].lastPaidDate;
          }
        }

        monthData.transactions.splice(txIndex, 1);

        // ── Write both docs atomically ────────────────────────────────────
        txn.set(monthRef, monthData);
        txn.set(docRef, { ...rootData, accounts: updatedAccounts }, { merge: true });
      });

      // ── Refresh UI ──────────────────────────────────────────────────────
      accounts = (await docRef.get()).data().accounts || [];
      renderAccounts(accounts);
      await loadAccountTransactionHistory(accountIndex);
      const panel = document.getElementById('acct-txn-history-' + accountIndex);
      if (panel) panel.style.display = 'block';
      const currentMk = availableMonths[currentMonthIndex] || monthKey;
      await loadMonthData(currentMk);
      await loadBudget();
      showToast("Transaction deleted — account balance restored.", "success");
      return;

    } catch (err) {
      console.error("[Phase 7] Engine deleteAccountTransaction error:", err);
      showToast(err.message || "Failed to delete transaction.", "error");
      return;
    }
  }

  // ── Legacy inline path (original code, untouched) ────────────────────────
  const monthSnap = await monthRef.get();
  if (!monthSnap.exists) return showToast("Month data not found", "error");

  let monthData = monthSnap.data();
  const txIndex = monthData.transactions.findIndex(t => t.id === txId);
  if (txIndex === -1) return showToast("Transaction not found", "error");

  const tx       = monthData.transactions[txIndex];
  const rootSnap = await docRef.get();
  let rootData   = rootSnap.exists ? rootSnap.data() : null;
  if (!rootData) return;

  if (tx.category === 'Deposit') {
    const i = rootData.accounts.findIndex(a => a.name === tx.accountName);
    if (i !== -1) rootData.accounts[i].balance = (rootData.accounts[i].balance || 0) - tx.amount;
  } else if (tx.category === 'Withdrawal') {
    const i = rootData.accounts.findIndex(a => a.name === tx.accountName);
    if (i !== -1) rootData.accounts[i].balance = (rootData.accounts[i].balance || 0) + tx.amount;
  } else if (tx.category === 'Transfer') {
    if (tx.fromAccount) {
      const fi = rootData.accounts.findIndex(a => a.name === tx.fromAccount);
      if (fi !== -1) rootData.accounts[fi].balance = (rootData.accounts[fi].balance || 0) + tx.amount;
    }
    if (tx.toAccount) {
      const ti = rootData.accounts.findIndex(a => a.name === tx.toAccount);
      if (ti !== -1) rootData.accounts[ti].balance = (rootData.accounts[ti].balance || 0) - tx.amount;
    }
  } else if (tx.isLiabilityPayment) {
    const i = rootData.accounts.findIndex(a => a.name === tx.liabilityAccount);
    if (i !== -1) {
      rootData.accounts[i].balance = (rootData.accounts[i].balance || 0) + tx.amount;
      if (rootData.accounts[i].nextDueOverride) delete rootData.accounts[i].nextDueOverride;
      if (rootData.accounts[i].lastPaidDate)    delete rootData.accounts[i].lastPaidDate;
    }
    monthData.availableBalance = (monthData.availableBalance || 0) + tx.amount;
  }

  monthData.transactions.splice(txIndex, 1);
  await docRef.update({ accounts: rootData.accounts });
  await monthRef.set(monthData);

  accounts = rootData.accounts;
  renderAccounts(accounts);
  await loadAccountTransactionHistory(accountIndex);
  const panel = document.getElementById('acct-txn-history-' + accountIndex);
  if (panel) panel.style.display = 'block';
  const currentMk = availableMonths[currentMonthIndex] || monthKey;
  await loadMonthData(currentMk);
  await loadBudget();
  showToast("Transaction deleted — account balance restored.", "success");
}


function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  // Animate in
  setTimeout(() => toast.classList.add("show"), 50);

  // Auto remove after 3s
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ── Styled modal replacements for alert() and confirm() ─────────────────
// showAlert(msg, type?)        → Promise<void>   (replaces alert())
// showConfirm(msg, opts?)      → Promise<boolean> (replaces confirm())
//
// Both inject a temporary DOM element and resolve when the user clicks.
// They share one modal container — only one shows at a time.
// type can be: "info" | "success" | "warning" | "error" | "danger"

function showAlert(message, type = "info") {
  return new Promise(resolve => {
    const overlay = _createDialogOverlay();
    const icon = { info:"ℹ️", success:"✅", warning:"⚠️", error:"❌", danger:"🗑️" }[type] || "ℹ️";
    const btnColor = type === "danger" ? "#ef4444"
                   : type === "error"  ? "#ef4444"
                   : type === "warning"? "#f59e0b"
                   : type === "success"? "#10b981"
                   : "var(--primary)";
    overlay.innerHTML = `
      <div class="bm-dialog-box">
        <div class="bm-dialog-icon">${icon}</div>
        <p class="bm-dialog-msg">${message}</p>
        <div class="bm-dialog-actions">
          <button class="bm-dialog-btn bm-dialog-btn-primary" style="background:${btnColor}">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.bm-dialog-btn-primary').addEventListener('click', () => {
      overlay.remove(); resolve();
    });
    overlay.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { overlay.remove(); resolve(); } });
    overlay.querySelector('.bm-dialog-btn-primary').focus();
  });
}

function showConfirm(message, opts = {}) {
  // opts: { confirmText, cancelText, type }
  return new Promise(resolve => {
    const overlay = _createDialogOverlay();
    const type = opts.type || "warning";
    const icon = { info:"ℹ️", warning:"⚠️", error:"❌", danger:"🗑️" }[type] || "⚠️";
    const confirmText = opts.confirmText || "Confirm";
    const cancelText  = opts.cancelText  || "Cancel";
    const btnColor = type === "danger" ? "#ef4444"
                   : type === "error"  ? "#ef4444"
                   : type === "warning"? "#f59e0b"
                   : "var(--primary)";
    overlay.innerHTML = `
      <div class="bm-dialog-box">
        <div class="bm-dialog-icon">${icon}</div>
        <p class="bm-dialog-msg">${message}</p>
        <div class="bm-dialog-actions">
          <button class="bm-dialog-btn bm-dialog-btn-cancel">${cancelText}</button>
          <button class="bm-dialog-btn bm-dialog-btn-primary" style="background:${btnColor}">${confirmText}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('.bm-dialog-btn-primary').addEventListener('click', () => { overlay.remove(); resolve(true); });
    overlay.querySelector('.bm-dialog-btn-cancel').addEventListener('click', () => { overlay.remove(); resolve(false); });
    overlay.addEventListener('keydown', e => {
      if (e.key === 'Enter') { overlay.remove(); resolve(true); }
      if (e.key === 'Escape') { overlay.remove(); resolve(false); }
    });
    overlay.querySelector('.bm-dialog-btn-primary').focus();
  });
}

function _createDialogOverlay() {
  const el = document.createElement('div');
  el.className = 'bm-dialog-overlay';
  el.setAttribute('tabindex', '-1');
  return el;
}



// ── A2: Collision-proof transaction ID (needed by Onboarding and engine paths)
function generateTxnId(prefix = "txn") {
  const ts = Date.now().toString(36);
  let rand;
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    rand = crypto.randomUUID().replace(/-/g, "");
  } else {
    rand = Array.from({ length: 4 }, () =>
      Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, "0")
    ).join("");
  }
  return `${prefix}-${ts}-${rand}`;
}

// ════════════════════════════════════════════════════════════════════════════
// ONBOARDING WIZARD v2 — 2 steps: Categories → Income
// Accounts setup handled separately via AccountsPrompt banner.
// ════════════════════════════════════════════════════════════════════════════

const Onboarding = (() => {
  const TOTAL_STEPS = 2;
  const wizardState = { step: 1, categories: [], income: [] };
  let _beforeUnloadActive = false;

  function _setError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }
  function _clearErrors() {
    document.querySelectorAll(".ob-field-error").forEach(el => {
      el.textContent = ""; el.style.display = "none";
    });
  }
  function _esc(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  async function checkAndShow() {
    if (!currentUser) return;
    try {
      const [userDoc, budgetDoc] = await Promise.all([
        db.collection("users").doc(currentUser.uid).get(),
        db.collection("budget").doc(currentUser.uid).get(),
      ]);
      if (userDoc.exists && userDoc.data().onboardingComplete) return;
      if (budgetDoc.exists) {
        const d = budgetDoc.data();
        if (Array.isArray(d.categories) && d.categories.length > 0) {
          await _markComplete(); return;
        }
      }
      _show();
    } catch (err) { console.warn("[Onboarding] checkAndShow:", err); }
  }

  function _show() {
    wizardState.step = 1;
    wizardState.categories = [];
    wizardState.income = [];
    document.getElementById("onboardingOverlay").style.display = "flex";
    _renderStep(1);
    if (!_beforeUnloadActive) {
      _beforeUnloadActive = true;
      window.addEventListener("beforeunload", _onBeforeUnload);
    }
  }
  function _hide() {
    document.getElementById("onboardingOverlay").style.display = "none";
    _beforeUnloadActive = false;
    window.removeEventListener("beforeunload", _onBeforeUnload);
  }
  function _onBeforeUnload(e) {
    e.preventDefault(); e.returnValue = "Your setup is not complete yet.";
  }

  function _renderStep(step) {
    wizardState.step = step;
    _clearErrors();
    _updateDots(step);
    _updateHeader(step);
    _updateBody(step);
    _updateFooter(step);
    _wireInputs(step);
    _renderList(step);
  }

  function _updateDots(step) {
    for (let i = 1; i <= TOTAL_STEPS; i++) {
      const d = document.getElementById("ob-dot-" + i);
      if (!d) continue;
      d.classList.remove("active","done");
      if (i < step) d.classList.add("done");
      if (i === step) d.classList.add("active");
    }
  }

  function _updateHeader(step) {
    const cfg = {
      1: { eyebrow:"Step 1 of 2 — Monthly Income",
           title:"Add your <span>income</span>",
           sub:"Tell BudgetMaster what you earn this month so it can calculate how much you have to assign." },
      2: { eyebrow:"Step 2 of 2 — Budget Categories",
           title:"Create your <span>budget envelopes</span>",
           sub:"Add categories for your spending — Groceries, Rent, Transport, etc. You can always add more later." },
    };
    const c = cfg[step];
    const ey = document.getElementById("ob-eyebrow");
    const ti = document.getElementById("ob-title");
    const su = document.getElementById("ob-subtitle");
    if (ey) ey.textContent = c.eyebrow;
    if (ti) ti.innerHTML   = c.title;
    if (su) su.textContent = c.sub;
  }

  function _updateBody(step) {
    const body = document.getElementById("ob-body");
    if (!body) return;
    body.innerHTML = step === 1 ? _stepIncomeHTML() : _stepCategoriesHTML();
  }

  // Step 1: Income
  function _stepIncomeHTML() {
    const hint = wizardState.income.length === 0
      ? '<div class="ob-step-hint">Fill in a name and amount, then tap <strong>+</strong> to add it to your list.</div>'
      : '';
    return hint
      + '<div id="ob-income-list" class="ob-item-list"></div>'
      + '<div class="ob-input-row">'
      + '<div class="ob-field"><label for="ob-income-name">Income source</label>'
      + '<input id="ob-income-name" type="text" placeholder="e.g. Monthly Salary" maxlength="50" autocomplete="off">'
      + '<span class="ob-field-error" id="ob-income-name-err" style="display:none"></span></div>'
      + '<div class="ob-field ob-field-narrow"><label for="ob-income-amount">Amount</label>'
      + '<input id="ob-income-amount" type="number" min="0.01" placeholder="0.00" step="0.01">'
      + '<span class="ob-field-error" id="ob-income-amount-err" style="display:none"></span></div>'
      + '<button type="button" class="ob-inline-add" id="ob-income-add" aria-label="Add income" title="Add to list">+'
      + "</button></div>"
      + '<span class="ob-field-error" id="ob-step1-err" style="display:none;margin-top:4px"></span>';
  }

  // Step 2: Categories — chips + manual entry + budget allocation per chip
  function _stepCategoriesHTML() {
    const chips = ["Groceries","Rent","Transport","Utilities","Dining Out","Entertainment","Savings","Healthcare","Education","Personal Care"]
      .map(s => '<button type="button" class="ob-chip" data-chip="' + _esc(s) + '">' + _esc(s) + "</button>").join("");

    const hint = wizardState.categories.length === 0
      ? '<div class="ob-step-hint">Tap a suggestion below to add it instantly, or type a custom name and tap <strong>+</strong>. Set a monthly budget amount in each row.</div>'
      : '<div class="ob-step-hint">Tap the <strong>Budget</strong> field on any row to set a monthly spending limit.</div>';

    return hint
      + '<div class="ob-quick-add">'
      + '<div class="ob-section-label">Suggestions — tap to add</div>'
      + '<div class="ob-chips" id="ob-chips">' + chips + "</div></div>"
      + '<div id="ob-cat-list" class="ob-item-list"></div>'
      + '<div class="ob-input-row">'
      + '<div class="ob-field"><label for="ob-cat-name">Custom category name</label>'
      + '<input id="ob-cat-name" type="text" placeholder="e.g. Pet Care" maxlength="40" autocomplete="off">'
      + '<span class="ob-field-error" id="ob-cat-name-err" style="display:none"></span></div>'
      + '<div class="ob-field ob-field-narrow"><label for="ob-cat-budget">Budget <span class="ob-optional">(optional)</span></label>'
      + '<input id="ob-cat-budget" type="number" min="0" placeholder="0.00" step="0.01">'
      + '<span class="ob-field-error" id="ob-cat-budget-err" style="display:none"></span></div>'
      + '<button type="button" class="ob-inline-add" id="ob-cat-add" aria-label="Add category" title="Add to list">+'
      + "</button></div>"
      + '<span class="ob-field-error" id="ob-step2-err" style="display:none;margin-top:4px"></span>';
  }

  function _updateFooter(step) {
    const back = document.getElementById("ob-back-btn");
    const skip = document.getElementById("ob-skip-btn");
    const next = document.getElementById("ob-next-btn");
    if (back) back.style.display = step > 1 ? "inline-flex" : "none";
    if (step === TOTAL_STEPS) {
      if (skip) skip.textContent = "Skip & Finish";
      if (next) { next.textContent = "Finish Setup ✓"; next.classList.add("ob-next-finish"); }
    } else {
      if (skip) skip.textContent = "Skip step";
      if (next) { next.textContent = "Continue →"; next.classList.remove("ob-next-finish"); }
    }
  }

  function _wireInputs(step) {
    if (step === 1) {
      // Income step
      const addBtn = document.getElementById("ob-income-add");
      const amtEl  = document.getElementById("ob-income-amount");
      if (addBtn) addBtn.addEventListener("click", _addIncome);
      if (amtEl)  amtEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); _addIncome(); } });
    }
    if (step === 2) {
      // Categories step
      document.querySelectorAll(".ob-chip").forEach(btn =>
        btn.addEventListener("click", () => _addCategoryChip(btn.dataset.chip)));
      const addBtn = document.getElementById("ob-cat-add");
      const nameEl = document.getElementById("ob-cat-name");
      if (addBtn) addBtn.addEventListener("click", _addCategory);
      if (nameEl) nameEl.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); _addCategory(); } });
    }
    const back = document.getElementById("ob-back-btn");
    const skip = document.getElementById("ob-skip-btn");
    const next = document.getElementById("ob-next-btn");
    if (back) back.onclick = _handleBack;
    if (skip) skip.onclick = _handleSkip;
    if (next) next.onclick = _handleNext;
  }

  function _renderList(step) {
    if (step === 1) _renderIncList();
    if (step === 2) _renderCatList();
  }

  function _renderCatList() {
    const list = document.getElementById("ob-cat-list");
    if (!list) return;
    if (wizardState.categories.length === 0) { list.innerHTML = ""; return; }
    list.innerHTML = wizardState.categories.map((c, i) => {
      const budgetVal = c.budget > 0 ? c.budget : "";
      return '<div class="ob-item ob-item-cat">'
        + '<div class="ob-item-icon">\uD83D\uDCC2</div>'
        + '<div class="ob-item-info">'
        + '<div class="ob-item-name">' + _esc(c.name) + '</div>'
        + '<div class="ob-item-budget-row">'
        + '<span class="ob-item-budget-label">Budget:</span>'
        + '<input type="number" min="0" step="0.01" placeholder="0.00"'
        + ' class="ob-item-budget-input"'
        + ' value="' + budgetVal + '"'
        + ' onchange="Onboarding._updateBudget(' + i + ',this.value)"'
        + ' oninput="Onboarding._updateBudget(' + i + ',this.value)"'
        + ' aria-label="Monthly budget for ' + _esc(c.name) + '">'
        + '<span class="ob-item-budget-hint">/&nbsp;month</span>'
        + '</div>'
        + '</div>'
        + '<button type="button" class="ob-item-remove"'
        + ' onclick="Onboarding._removeItem(&quot;categories&quot;,' + i + ')"'
        + ' aria-label="Remove ' + _esc(c.name) + '">×</button>'
        + '</div>';
    }).join("");
  }

  function _renderIncList() {
    const list = document.getElementById("ob-income-list");
    if (!list) return;
    list.innerHTML = wizardState.income.map((inc, i) =>
      '<div class="ob-item">'
      + '<div class="ob-item-icon">💰</div>'
      + '<div class="ob-item-info"><div class="ob-item-name">' + _esc(inc.name) + "</div>"
      + '<div class="ob-item-sub">' + formatCurrency(inc.amount) + " / month</div></div>"
      + '<button type="button" class="ob-item-remove" onclick="Onboarding._removeItem(&quot;income&quot;,' + i + ')">\u00d7</button>'
      + "</div>"
    ).join("");
  }

  function _addCategory() {
    _clearErrors();
    const nameEl   = document.getElementById("ob-cat-name");
    const budgetEl = document.getElementById("ob-cat-budget");
    const name     = (nameEl ? nameEl.value : "").trim();
    const budget   = parseFloat(budgetEl ? budgetEl.value : "") || 0;
    let ok = true;
    if (!name) { _setError("ob-cat-name-err","Category name is required."); if(nameEl) nameEl.focus(); ok = false; }
    else if (wizardState.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      _setError("ob-cat-name-err","Already added."); if(nameEl) nameEl.focus(); ok = false;
    }
    if (budget < 0) { _setError("ob-cat-budget-err","Cannot be negative."); ok = false; }
    if (!ok) return;
    wizardState.categories.push({ name, budget });
    if (nameEl) nameEl.value = "";
    if (budgetEl) budgetEl.value = "";
    // Update hint after first item added
    const hintEl = document.querySelector(".ob-step-hint");
    if (hintEl && wizardState.categories.length === 1) {
      hintEl.innerHTML = 'Tap the <strong>Budget</strong> field on any row to set a monthly spending limit.';
    }
    _renderCatList();
    if (nameEl) nameEl.focus();
  }

  function _addCategoryChip(name) {
    _clearErrors();
    if (wizardState.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      _setError("ob-step1-err", '"' + name + '" is already in your list.'); return;
    }
    wizardState.categories.push({ name, budget: 0 });
    _renderCatList();
  }

  function _addIncome() {
    _clearErrors();
    const nameEl = document.getElementById("ob-income-name");
    const amtEl  = document.getElementById("ob-income-amount");
    const name   = (nameEl ? nameEl.value : "").trim();
    const amount = parseFloat(amtEl ? amtEl.value : "");
    let ok = true;
    if (!name) { _setError("ob-income-name-err","Name is required."); if(nameEl) nameEl.focus(); ok = false; }
    if (!amount || amount <= 0) { _setError("ob-income-amount-err","Enter a valid amount."); if(ok && amtEl) amtEl.focus(); ok = false; }
    if (!ok) return;
    wizardState.income.push({ name, amount });
    if (nameEl) nameEl.value = "";
    if (amtEl)  amtEl.value  = "";
    // Refresh the hint text now that list has items
    const hintEl = document.querySelector(".ob-step-hint");
    if (hintEl && wizardState.income.length === 1) hintEl.style.display = "none";
    _renderIncList();
    if (nameEl) nameEl.focus();
  }

  function _removeItem(key, index) {
    wizardState[key].splice(index, 1);
    _renderList(wizardState.step);
  }

  function _updateBudget(index, value) {
    const amt = parseFloat(value);
    if (wizardState.categories[index] !== undefined) {
      wizardState.categories[index].budget = (!isNaN(amt) && amt >= 0) ? amt : 0;
    }
    // No re-render — input is live-edited in place
  }

  function _handleBack() { if (wizardState.step > 1) _renderStep(wizardState.step - 1); }
  function _handleSkip() {
    if (wizardState.step < TOTAL_STEPS) _renderStep(wizardState.step + 1);
    else _finish();
  }
  function _handleNext() {
    _clearErrors();
    if (wizardState.step === 1 && wizardState.income.length === 0) {
      _setError("ob-step1-err","Fill in a name and amount above, then tap + to add it — or tap \"Skip step\" to continue."); return;
    }
    if (wizardState.step === 2 && wizardState.categories.length === 0) {
      _setError("ob-step2-err","Tap a suggestion above or type a name and tap + to add a category — or tap \"Skip step\" to finish."); return;
    }
    if (wizardState.step < TOTAL_STEPS) _renderStep(wizardState.step + 1);
    else _finish();
  }

  async function _finish() {
    const btn = document.getElementById("ob-next-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
    try {
      const uid      = currentUser.uid;
      const budgetRef = db.collection("budget").doc(uid);
      const monthKey = new Date().toISOString().slice(0, 7);
      const today    = new Date().toISOString().slice(0, 10);
      const now      = new Date().toISOString();

      let totalAssigned = 0;
      const catsToWrite = wizardState.categories.map(c => {
        totalAssigned += c.budget;
        return { name: c.name, assigned: c.budget, spent: 0, balance: c.budget };
      });

      const totalIncome = wizardState.income.reduce((s, i) => s + i.amount, 0);
      const incomeTxns  = wizardState.income.map(inc => ({
        id: generateTxnId("txn"), name: inc.name, amount: inc.amount,
        category:"Income", type:"income", date:today,
        inflow:inc.amount, outflow:0, source:"onboarding",
      }));

      const tbb   = totalIncome - totalAssigned;
      const avail = tbb;

      const existingSnap = await budgetRef.get();
      const existingData = existingSnap.exists ? existingSnap.data() : {};

      await runWithRetry(db, async (txn) => {
        const monthRef = budgetRef.collection("months").doc(monthKey);
        txn.set(budgetRef, {
          ...existingData,
          categories:   catsToWrite,
          transactions: existingData.transactions || [],
          tbb:          tbb,
          currentMonth: monthKey,
        });
        txn.set(monthRef, {
          currentMonth:     monthKey,
          tbb:              tbb,
          availableBalance: avail,
          categories:       catsToWrite,
          transactions:     incomeTxns,
        });
      });

      await _markComplete();
      _hide();
      await loadAvailableMonths();
      await loadBudget();
      await loadAccounts();
      await loadBudgetSection();

      // Show welcome banner — user clicks "Take the tour" to begin
      _showWelcomeBanner();

    } catch (err) {
      console.error("[Onboarding] _finish error:", err);
      showToast("Failed to save. Please try again.", "error");
      if (btn) { btn.disabled = false; btn.textContent = "Finish Setup ✓"; }
    }
  }

  async function _markComplete() {
    try {
      await db.collection("users").doc(currentUser.uid).update({ onboardingComplete: true });
    } catch (_) {
      await db.collection("users").doc(currentUser.uid).set({ onboardingComplete: true }, { merge: true });
    }
  }

  // ── Welcome banner — shown after the wizard, before the dashboard tour ──
  function _showWelcomeBanner() {
    // Don\'t duplicate
    if (document.getElementById("bm-welcome-banner")) return;

    const banner = document.createElement("div");
    banner.id = "bm-welcome-banner";
    banner.innerHTML = `
      <div class="bm-welcome-overlay"></div>
      <div class="bm-welcome-card">
        <div class="bm-welcome-icon">\ud83c\udf89</div>
        <h2 class="bm-welcome-title">You\u2019re all set, <span>${_esc((currentUser && currentUser.displayName) || "friend")}</span>!</h2>
        <p class="bm-welcome-sub">Your budget is ready to go. Want a quick tour of your dashboard so you know what each card and button does?</p>
        <div class="bm-welcome-actions">
          <button type="button" class="bm-welcome-skip"   id="bm-welcome-skip">Skip for now</button>
          <button type="button" class="bm-welcome-cta"    id="bm-welcome-start">Take the 1-minute tour \u2192</button>
        </div>
      </div>`;
    document.body.appendChild(banner);

    const cleanup = () => banner.remove();

    document.getElementById("bm-welcome-start").addEventListener("click", () => {
      cleanup();
      if (typeof DashboardTour !== "undefined") {
        // Small delay for banner fade-out and dashboard render
        setTimeout(() => DashboardTour.checkAndStart(), 200);
      }
    });
    document.getElementById("bm-welcome-skip").addEventListener("click", cleanup);
  }

  return { checkAndShow, _removeItem, _updateBudget, _addCategoryChip: _addCategoryChip };
})();

// ════════════════════════════════════════════════════════════════════════════
// ACCOUNTS SETUP PROMPT BANNER
// Shown in the Accounts section when user has zero accounts.
// Auto-dismisses when first account is added.
// Dismissal stored in users/{uid}.accountsPromptDismissed.
// ════════════════════════════════════════════════════════════════════════════

const AccountsPrompt = (() => {
  let _dismissed = false;

  async function checkAndRender() {
    if (!currentUser || _dismissed) return;
    try {
      const snap = await db.collection("users").doc(currentUser.uid).get();
      if (snap.exists && snap.data().accountsPromptDismissed) { _dismissed = true; return; }
    } catch (_) {}
    _render();
  }

  function _render() {
    if (accounts && accounts.length > 0) { _hide(); return; }

    // Hide the header Add Account button while the banner is showing —
    // the banner has its own CTA, no need for two buttons doing the same thing.
    const headerBtn = document.getElementById("add-account-btn");
    if (headerBtn) headerBtn.style.display = "none";

    let banner = document.getElementById("accounts-setup-prompt");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "accounts-setup-prompt";
      const target = document.querySelector(".accounts-two-col");
      if (target) target.parentNode.insertBefore(banner, target);
      else return;
    }
    banner.innerHTML =
      '<div class="acct-prompt-inner">'
      + '<div class="acct-prompt-icon">'
      +   '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      +     '<rect x="2" y="5" width="20" height="14" rx="2"/>'
      +     '<line x1="2" y1="10" x2="22" y2="10"/>'
      +   '</svg>'
      + '</div>'
      + '<div class="acct-prompt-text">'
      + '<div class="acct-prompt-title">Set up your first account</div>'
      + '<div class="acct-prompt-sub">Track your cash, bank accounts, e-wallets, and credit cards in one place.</div>'
      + '</div>'
      + '<div class="acct-prompt-actions">'
      + '<button type="button" class="acct-prompt-cta" id="acct-prompt-add-btn">+ Add Account</button>'
      + '<button type="button" class="acct-prompt-dismiss" id="acct-prompt-dismiss-btn">Not now</button>'
      + '</div></div>';
    document.getElementById("acct-prompt-add-btn").addEventListener("click", () => {
      // Same flow as clicking "Add Account" button
      if (typeof resetAccountModal === "function") resetAccountModal();
      const titleEl   = document.getElementById("account-modal-title");
      const eyebrowEl = document.getElementById("account-modal-eyebrow");
      if (titleEl)   titleEl.innerText    = "Add Account";
      if (eyebrowEl) eyebrowEl.textContent = "New account";
      openModal("account-modal");
    });
    document.getElementById("acct-prompt-dismiss-btn").addEventListener("click", _dismiss);
  }

  function _hide() {
    const el = document.getElementById("accounts-setup-prompt");
    if (el) el.remove();
    // Restore the header Add Account button when banner is hidden
    const headerBtn = document.getElementById("add-account-btn");
    if (headerBtn) headerBtn.style.display = "";
  }

  async function _dismiss() {
    _dismissed = true; _hide();
    try {
      await db.collection("users").doc(currentUser.uid).set({ accountsPromptDismissed: true }, { merge: true });
    } catch (err) { console.warn("[AccountsPrompt] dismiss:", err); }
  }

  function syncWithAccounts() {
    if (!currentUser || _dismissed) return;
    if (accounts && accounts.length > 0) { _hide(); return; }
    _render();
  }

  return { checkAndRender, syncWithAccounts };
})();


// ════════════════════════════════════════════════════════════════════════════
// FEATURE 2 — Account Modal: segmented type control + inline validation
// ════════════════════════════════════════════════════════════════════════════

(function initAccountModal() {

  function _wireTypeGrid() {
    const grid = document.getElementById("acct-type-grid");
    if (!grid) return;
    grid.querySelectorAll(".acct-type-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        grid.querySelectorAll(".acct-type-btn").forEach(b => {
          b.classList.remove("selected");
          b.setAttribute("aria-checked", "false");
        });
        btn.classList.add("selected");
        btn.setAttribute("aria-checked", "true");
        const val = btn.dataset.value;
        const sel = document.getElementById("account-type");
        if (sel) sel.value = val;
        const cc = document.getElementById("credit-card-fields");
        if (cc) cc.style.display = val === "credit-card" ? "block" : "none";
        const balLabel = document.getElementById("account-balance-label");
        const hint     = document.getElementById("balance-hint");
        const isLiab   = ["credit-card","loan","mortgage","line-of-credit","other-liability"].includes(val);
        if (balLabel) balLabel.textContent = val === "credit-card" ? "Current amount owed" : isLiab ? "Current balance owed" : "Starting balance";
        if (hint) hint.textContent = val === "credit-card" ? "Enter how much you currently owe on this card" : isLiab ? "Enter as a positive number — e.g. 5000 for ₱5,000 owed" : "Enter your current balance (leave blank for 0)";
        _hideErr("acct-type-err");
      });
    });
  }

  function _wireNameCounter() {
    const input   = document.getElementById("account-name");
    const counter = document.getElementById("acct-name-count");
    if (!input || !counter) return;
    input.addEventListener("input", () => {
      const len = input.value.length;
      counter.textContent = `${len} / 40`;
      counter.style.color = len >= 36 ? "#ef4444" : "#94a3b8";
    });
  }

  function _updateCurrencyPrefix() {
    const el = document.getElementById("acct-currency-prefix");
    if (!el) return;
    const symbols = { PHP:"₱", USD:"$", JPY:"¥", EUR:"€", GBP:"£" };
    el.textContent = symbols[window.userCurrency] || "₱";
  }

  function _showErr(id, msg) { const el = document.getElementById(id); if (!el) return; el.textContent = msg; el.style.display = "block"; }
  function _hideErr(id)      { const el = document.getElementById(id); if (!el) return; el.textContent = ""; el.style.display = "none"; }
  function _clearAllErrs()   { ["acct-type-err","acct-name-err","acct-balance-err"].forEach(_hideErr); }

  window.validateAccountModal = function() {
    _clearAllErrs();
    const type    = document.getElementById("account-type").value;
    const name    = (document.getElementById("account-name").value || "").trim();
    const balance = document.getElementById("account-balance").value;
    let ok = true;
    if (!type) { _showErr("acct-type-err","Please select an account type."); ok = false; }
    if (!name) { _showErr("acct-name-err","Account name is required."); if (ok) document.getElementById("account-name").focus(); ok = false; }
    else if (name.length > 40) { _showErr("acct-name-err","Max 40 characters."); ok = false; }
    if (balance !== "" && isNaN(parseFloat(balance))) { _showErr("acct-balance-err","Enter a valid number."); ok = false; }
    return ok;
  };

  window.syncAccountTypeGrid = function(value) {
    const grid = document.getElementById("acct-type-grid");
    if (!grid) return;
    grid.querySelectorAll(".acct-type-btn").forEach(btn => {
      const match = btn.dataset.value === value;
      btn.classList.toggle("selected", match);
      btn.setAttribute("aria-checked", match ? "true" : "false");
    });
    const cc = document.getElementById("credit-card-fields");
    if (cc) cc.style.display = value === "credit-card" ? "block" : "none";
  };

  window.resetAccountModal = function() {
    _clearAllErrs();
    const grid = document.getElementById("acct-type-grid");
    if (grid) grid.querySelectorAll(".acct-type-btn").forEach(b => { b.classList.remove("selected"); b.setAttribute("aria-checked","false"); });
    ["account-type","account-name","account-balance","account-notes","account-credit-limit","account-due-date"].forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.tagName === "SELECT" ? (el.selectedIndex = 0) : (el.value = ""); }
    });
    const counter = document.getElementById("acct-name-count");
    if (counter) counter.textContent = "0 / 40";
    const cc = document.getElementById("credit-card-fields");
    if (cc) cc.style.display = "none";
    const balLabel = document.getElementById("account-balance-label");
    if (balLabel) balLabel.textContent = "Starting balance";
    const hint = document.getElementById("balance-hint");
    if (hint) hint.textContent = "Enter your current balance (leave blank for 0)";
    _updateCurrencyPrefix();
  };

  document.addEventListener("DOMContentLoaded", () => {
    _wireTypeGrid();
    _wireNameCounter();
    _updateCurrencyPrefix();
  });
})();




// ════════════════════════════════════════════════════════════════════════════
// RECURRING TRANSACTIONS
// Auto-create income or expense transactions on a chosen day each month.
// Storage: budget/{uid}/recurringRules/{ruleId}
// Generated transactions tagged with source:"recurring" and recurringRuleId
// to be identifiable in the dashboard transaction list.
// ════════════════════════════════════════════════════════════════════════════

const Recurring = (() => {

  // ── Generate a unique rule id ───────────────────────────────────────────
  function _genRuleId() {
    const ts = Date.now().toString(36);
    const rand = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return "rec-" + ts + "-" + rand;
  }

  // ── Read all rules for current user ─────────────────────────────────────
  async function _getAllRules() {
    if (!currentUser) return [];
    try {
      const snap = await db.collection("budget").doc(currentUser.uid)
        .collection("recurringRules").get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
      console.warn("[Recurring] _getAllRules:", err);
      return [];
    }
  }

  // ── Save a single rule ──────────────────────────────────────────────────
  async function _saveRule(rule) {
    const ref = db.collection("budget").doc(currentUser.uid)
      .collection("recurringRules").doc(rule.id);
    await ref.set(rule);
  }

  async function _deleteRule(ruleId) {
    const ref = db.collection("budget").doc(currentUser.uid)
      .collection("recurringRules").doc(ruleId);
    await ref.delete();
  }

  // ── Compute the actual transaction date for a given rule + month ───────
  function _dateForMonth(rule, yearMonth) {
    // yearMonth: "2026-03"
    const [y, m] = yearMonth.split("-").map(Number);
    let day = rule.dayOfMonth;
    if (day === "last" || day === -1) {
      day = new Date(y, m, 0).getDate(); // last day of that month
    } else {
      day = parseInt(day, 10);
      const lastDay = new Date(y, m, 0).getDate();
      if (day > lastDay) day = lastDay; // e.g. Feb 30 → Feb 28/29
    }
    return `${yearMonth}-${String(day).padStart(2, "0")}`;
  }

  // ── List of months between two YYYY-MM strings, inclusive ─────────────
  function _monthsBetween(startMonth, endMonth) {
    const result = [];
    let [y, m] = startMonth.split("-").map(Number);
    const [ey, em] = endMonth.split("-").map(Number);
    while (y < ey || (y === ey && m <= em)) {
      result.push(`${y}-${String(m).padStart(2, "0")}`);
      m++;
      if (m > 12) { m = 1; y++; }
    }
    return result;
  }

  // ── Has this rule\'s due date for a given month already passed? ────────
  function _isDueForMonth(rule, yearMonth) {
    const dueDate = _dateForMonth(rule, yearMonth);
    const today   = new Date().toISOString().slice(0, 10);
    return dueDate <= today;
  }

  // ── Execute a rule for a specific month — creates one transaction ──────
  async function _executeRuleForMonth(rule, yearMonth) {
    if (!currentUser) return;
    const date = _dateForMonth(rule, yearMonth);

    try {
      await persistFinancialTransaction(
        {
          type:     rule.type,
          amount:   rule.amount,
          date:     date,
          monthKey: yearMonth,
          name:     rule.name,
          category: rule.category || (rule.type === "income" ? "Income" : ""),
        },
        db,
        currentUser.uid
      );
      // Patch the just-created transaction with recurring tags so it can be
      // identified in the dashboard transaction list.
      await _tagTransactionAsRecurring(yearMonth, rule, date);
      console.log(`[Recurring] Executed "${rule.name}" for ${yearMonth}`);
      return true;
    } catch (err) {
      console.error("[Recurring] execute failed:", rule.id, yearMonth, err);
      return false;
    }
  }

  // ── Post-create patch: find the txn we just created and add recurring tags ──
  async function _tagTransactionAsRecurring(yearMonth, rule, date) {
    try {
      const monthRef = db.collection("budget").doc(currentUser.uid)
        .collection("months").doc(yearMonth);
      await runWithRetry(db, async (txn) => {
        const snap = await txn.get(monthRef);
        if (!snap.exists) return;
        const data = snap.data();
        // Find the latest matching transaction (by name + date + amount)
        const matches = (data.transactions || [])
          .map((t, i) => ({ t, i }))
          .filter(({ t }) =>
            t.name === rule.name &&
            t.date === date &&
            Math.abs((t.amount || 0) - rule.amount) < 0.01 &&
            !t.recurringRuleId
          );
        if (matches.length === 0) return;
        // Tag the last (most recently added) match
        const { t, i } = matches[matches.length - 1];
        data.transactions[i] = {
          ...t,
          source:          "recurring",
          recurringRuleId: rule.id,
        };
        txn.set(monthRef, data);
      });
    } catch (err) {
      console.warn("[Recurring] tag failed (non-fatal):", err);
    }
  }

  // ── Main entry — call on every app load. Idempotent via lastRunMonth ────
  async function runDueRules() {
    if (!currentUser) return { executed: 0 };

    const rules = await _getAllRules();
    if (rules.length === 0) return { executed: 0 };

    const thisMonth = new Date().toISOString().slice(0, 7);
    let executed = 0;

    for (const rule of rules) {
      if (rule.paused) continue;
      if (rule.endMonth && rule.endMonth < thisMonth) continue;

      // Where do we start from? The month AFTER lastRunMonth, or startMonth.
      let cursor = rule.startMonth;
      if (rule.lastRunMonth) {
        let [y, m] = rule.lastRunMonth.split("-").map(Number);
        m++;
        if (m > 12) { m = 1; y++; }
        cursor = `${y}-${String(m).padStart(2, "0")}`;
      }

      // Don\'t go past the current month
      if (cursor > thisMonth) continue;

      const monthsToRun = _monthsBetween(cursor, thisMonth);

      for (const month of monthsToRun) {
        if (!_isDueForMonth(rule, month)) continue;
        const ok = await _executeRuleForMonth(rule, month);
        if (ok) {
          rule.lastRunMonth = month;
          await _saveRule(rule);
          executed++;
        }
      }
    }

    if (executed > 0) {
      showToast(`${executed} recurring transaction${executed === 1 ? "" : "s"} added.`, "success");
      // Reload UI so the new transactions appear
      try {
        await loadMonthData(availableMonths[currentMonthIndex]);
        await loadBudgetSection();
      } catch (_) {}
    }

    return { executed };
  }

  // ── UI: render the rules list inside Settings → Recurring tab ──────────
  // ── Compute status for a rule — what state is it in right now? ─────────
  function _statusForRule(rule) {
    if (rule.paused) {
      return { kind: "paused", label: "Paused", icon: "pause", color: "neutral" };
    }
    const thisMonth = new Date().toISOString().slice(0, 7);
    const today     = new Date().toISOString().slice(0, 10);

    // Compute when it would next run THIS month
    const dueDate = _dateForMonth(rule, thisMonth);

    // Did it already run this month?
    if (rule.lastRunMonth === thisMonth) {
      return {
        kind: "ran",
        label: `Added on ${_humanDate(dueDate)}`,
        icon: "check",
        color: "success",
      };
    }

    // Is it past-due (its day has come/passed but it hasn\'t run yet)?
    if (dueDate <= today) {
      return {
        kind: "pending",
        label: `Missed ${_humanDate(dueDate)} — will add on next login`,
        icon: "alert",
        color: "warning",
      };
    }

    // Future-due
    return {
      kind: "scheduled",
      label: `Will add on ${_humanDate(dueDate)}`,
      icon: "clock",
      color: "info",
    };
  }

  // Convert "2026-06-15" to a friendly human label
  function _humanDate(dateStr) {
    if (!dateStr) return "—";
    try {
      const d = new Date(dateStr + "T00:00:00");
      const today = new Date();
      const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
      const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);

      if (d.toDateString() === today.toDateString())     return "today";
      if (d.toDateString() === tomorrow.toDateString())  return "tomorrow";
      if (d.toDateString() === yesterday.toDateString()) return "yesterday";

      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch (_) { return dateStr; }
  }

  // SVG glyph for each status type
  function _statusIcon(kind) {
    if (kind === "check") return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    if (kind === "alert") return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
    if (kind === "clock") return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
    if (kind === "pause") return '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
    return "";
  }

  async function renderRulesList() {
    const listEl = document.getElementById("bm-recurring-list");
    if (!listEl) return;

    const rules = await _getAllRules();

    if (rules.length === 0) {
      listEl.innerHTML = `
        <div class="bm-recur-info">
          <div class="bm-recur-info-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          </div>
          <div>
            <strong>How recurring works:</strong> rules run when you open the app. If you miss a day, they catch up on your next visit.
          </div>
        </div>
        <div class="bm-recur-empty">
          No recurring rules yet. Tap <strong>+ New Recurring Rule</strong> to set one up.
        </div>`;
      return;
    }

    // Sort: income first, then by day of month
    rules.sort((a, b) => {
      if (a.type !== b.type) return a.type === "income" ? -1 : 1;
      const ad = a.dayOfMonth === "last" ? 31 : parseInt(a.dayOfMonth, 10);
      const bd = b.dayOfMonth === "last" ? 31 : parseInt(b.dayOfMonth, 10);
      return ad - bd;
    });

    listEl.innerHTML = `
      <div class="bm-recur-info">
        <div class="bm-recur-info-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
        </div>
        <div>
          <strong>How recurring works:</strong> rules run when you open the app. If you miss a day, they catch up on your next visit.
        </div>
      </div>

      <table class="bm-recur-table">
        <thead>
          <tr>
            <th>Description</th>
            <th>Type</th>
            <th>Day</th>
            <th class="bm-num">Amount</th>
            <th class="bm-actions-col"></th>
          </tr>
        </thead>
        <tbody>
          ${rules.map(r => {
            const name = (r.name || "").replace(/</g, "&lt;").replace(/"/g, "&quot;");
            const dayLabel = r.dayOfMonth === "last" ? "Last" : _ordinal(parseInt(r.dayOfMonth, 10));
            const typeChip = r.type === "income"
              ? '<span class="bm-recur-chip bm-recur-chip-income">Income</span>'
              : '<span class="bm-recur-chip bm-recur-chip-expense">Expense</span>';
            const status = _statusForRule(r);
            const statusBadge = `
              <div class="bm-recur-status bm-recur-status-${status.color}">
                <span class="bm-recur-status-icon">${_statusIcon(status.icon)}</span>
                <span>${status.label}</span>
              </div>`;
            return `
            <tr data-rule-id="${r.id}">
              <td class="bm-recur-name">
                ${name}
                ${statusBadge}
              </td>
              <td>${typeChip}</td>
              <td>${dayLabel}</td>
              <td class="bm-num">${formatCurrency(r.amount)}</td>
              <td class="bm-actions-col">
                ${status.kind === "pending"
                  ? `<button class="bm-row-action bm-recur-run" data-rule-id="${r.id}" title="Run now"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg></button>`
                  : ""}
                <button class="bm-row-action bm-recur-pause" data-rule-id="${r.id}" title="${r.paused ? "Resume" : "Pause"}">
                  ${r.paused
                    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>'
                    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'}
                </button>
                <button class="bm-row-action bm-recur-edit" data-rule-id="${r.id}" title="Edit">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                </button>
                <button class="bm-row-action bm-recur-delete" data-rule-id="${r.id}" title="Delete">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>`;

    // Wire actions
    listEl.querySelectorAll(".bm-recur-pause").forEach(btn => {
      btn.addEventListener("click", () => togglePauseRule(btn.dataset.ruleId));
    });
    listEl.querySelectorAll(".bm-recur-edit").forEach(btn => {
      btn.addEventListener("click", () => openEditRuleModal(btn.dataset.ruleId));
    });
    listEl.querySelectorAll(".bm-recur-delete").forEach(btn => {
      btn.addEventListener("click", () => confirmDeleteRule(btn.dataset.ruleId));
    });
    listEl.querySelectorAll(".bm-recur-run").forEach(btn => {
      btn.addEventListener("click", () => runRuleNow(btn.dataset.ruleId));
    });
  }

  // ── Manually trigger a single rule for the current month ───────────────
  async function runRuleNow(ruleId) {
    const rules = await _getAllRules();
    const rule = rules.find(r => r.id === ruleId);
    if (!rule) { showToast("Rule not found.", "error"); return; }

    const ok = await showConfirm(
      `Add this transaction now? "${rule.name}" — ${formatCurrency(rule.amount)}`,
      { confirmText: "Add now", cancelText: "Cancel" }
    );
    if (!ok) return;

    const thisMonth = new Date().toISOString().slice(0, 7);
    const success = await _executeRuleForMonth(rule, thisMonth);
    if (success) {
      rule.lastRunMonth = thisMonth;
      await _saveRule(rule);
      showToast("Transaction added.", "success");
      try {
        await loadMonthData(availableMonths[currentMonthIndex]);
        await loadBudgetSection();
      } catch (_) {}
      await renderRulesList();
    } else {
      showToast("Failed to add transaction. Please try again.", "error");
    }
  }

  function _ordinal(n) {
    const s = ["th", "st", "nd", "rd"], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }

  // ── Open edit modal pre-filled ──────────────────────────────────────────
  async function openEditRuleModal(ruleId) {
    const rules = await _getAllRules();
    const r = rules.find(x => x.id === ruleId);
    if (!r) return;

    document.getElementById("recurring-modal-title").textContent = "Edit Recurring Rule";
    document.getElementById("recurringEditId").value             = r.id;
    document.getElementById("recurringName").value               = r.name || "";
    document.getElementById("recurringAmount").value             = r.amount;
    document.getElementById("recurringDay").value                = r.dayOfMonth;
    document.getElementById("recurringStartMonth").value         = r.startMonth;

    // Set type buttons
    document.querySelectorAll(".bm-recur-type-btn").forEach(b => {
      b.classList.toggle("selected", b.dataset.type === r.type);
    });
    _toggleCategoryDropdown(r.type);
    await _populateCategoryDropdown();
    if (r.category) document.getElementById("recurringCategory").value = r.category;

    openModal("recurringModal");
  }

  async function togglePauseRule(ruleId) {
    const rules = await _getAllRules();
    const r = rules.find(x => x.id === ruleId);
    if (!r) return;
    r.paused = !r.paused;
    await _saveRule(r);
    showToast(r.paused ? "Rule paused." : "Rule resumed.", "success");
    await renderRulesList();
  }

  async function confirmDeleteRule(ruleId) {
    const ok = await showConfirm(
      "Delete this recurring rule? Past transactions it created will remain.",
      { confirmText: "Delete", cancelText: "Cancel", type: "danger" }
    );
    if (!ok) return;
    await _deleteRule(ruleId);
    showToast("Recurring rule deleted.", "success");
    await renderRulesList();
  }

  // ── Helpers for the modal ───────────────────────────────────────────────
  function _toggleCategoryDropdown(type) {
    const wrap = document.getElementById("recurringCategoryGroup");
    if (wrap) wrap.style.display = type === "expense" ? "" : "none";
  }

  async function _populateCategoryDropdown() {
    const sel = document.getElementById("recurringCategory");
    if (!sel) return;
    // Read categories from current month
    try {
      const docRef = db.collection("budget").doc(currentUser.uid);
      const root = await docRef.get();
      const cats = (root.exists ? root.data().categories : []) || [];
      sel.innerHTML = `<option value="">— Select category —</option>` +
        cats.map(c => `<option value="${(c.name || "").replace(/"/g, "&quot;")}">${(c.name || "").replace(/</g, "&lt;")}</option>`).join("");
    } catch (_) {}
  }

  function resetModal() {
    document.getElementById("recurring-modal-title").textContent = "New Recurring Rule";
    document.getElementById("recurringEditId").value             = "";
    document.getElementById("recurringName").value               = "";
    document.getElementById("recurringAmount").value             = "";
    document.getElementById("recurringDay").value                = "15";
    document.getElementById("recurringStartMonth").value         = new Date().toISOString().slice(0, 7);
    document.querySelectorAll(".bm-recur-type-btn").forEach((b, i) => {
      b.classList.toggle("selected", i === 0); // Income default
    });
    _toggleCategoryDropdown("income");
  }

  return {
    runDueRules,
    renderRulesList,
    openEditRuleModal,
    resetModal,
    runRuleNow,
    _toggleCategoryDropdown,
    _populateCategoryDropdown,
    _genRuleId,
    _saveRule,
    _getAllRules,
  };
})();

// ── Top-level save handler called by modal Save button ─────────────────────
async function saveRecurringRule() {
  const editId = document.getElementById("recurringEditId").value;
  const name   = document.getElementById("recurringName").value.trim();
  const amount = parseFloat(document.getElementById("recurringAmount").value);
  const day    = document.getElementById("recurringDay").value;
  const startMonth = document.getElementById("recurringStartMonth").value
                     || new Date().toISOString().slice(0, 7);
  const typeBtn = document.querySelector(".bm-recur-type-btn.selected");
  const type    = typeBtn ? typeBtn.dataset.type : "income";
  const category = type === "expense"
    ? (document.getElementById("recurringCategory").value || "")
    : "Income";

  // Validation
  if (!name) { showToast("Please enter a description.", "error"); return; }
  if (isNaN(amount) || amount <= 0) { showToast("Please enter a valid amount.", "error"); return; }
  if (type === "expense" && !category) { showToast("Please choose a category for the expense.", "error"); return; }

  let rule;
  if (editId) {
    // Edit existing — preserve lastRunMonth
    const all = await Recurring._getAllRules();
    rule = all.find(r => r.id === editId);
    if (!rule) { showToast("Rule not found.", "error"); return; }
    rule.name       = name;
    rule.amount     = amount;
    rule.dayOfMonth = day;
    rule.startMonth = startMonth;
    rule.type       = type;
    rule.category   = category;
  } else {
    // New
    rule = {
      id:           Recurring._genRuleId(),
      type, name, amount, category,
      dayOfMonth:   day,
      startMonth:   startMonth,
      endMonth:     null,
      paused:       false,
      lastRunMonth: null,
      fromAccount:  null,
      createdAt:    new Date().toISOString(),
    };
  }

  try {
    await Recurring._saveRule(rule);
    closeModal("recurringModal");
    showToast(editId ? "Rule updated." : "Recurring rule created.", "success");
    await Recurring.renderRulesList();
    // Immediately run any past-due months for new rules
    if (!editId) {
      await Recurring.runDueRules();
    }
  } catch (err) {
    console.error("[saveRecurringRule]", err);
    showToast("Failed to save rule. Please try again.", "error");
  }
}

// Wire modal open + type buttons + new-rule button when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const newBtn = document.getElementById("bm-new-recurring-btn");
  if (newBtn) {
    newBtn.addEventListener("click", async () => {
      Recurring.resetModal();
      await Recurring._populateCategoryDropdown();
      openModal("recurringModal");
    });
  }
  // Type segmented buttons
  document.querySelectorAll(".bm-recur-type-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".bm-recur-type-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
      Recurring._toggleCategoryDropdown(btn.dataset.type);
    });
  });
});


// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD TOOLTIP TOUR
// Guides new users through the dashboard cards and action buttons.
// Stored in users/{uid}: dashboardTourComplete, dashboardTourStep
// ════════════════════════════════════════════════════════════════════════════

const DashboardTour = (() => {
  const TOTAL = 8;
  const STEPS = [
    {
      sel: () => document.getElementById("tbb"),
      title: "To Be Budgeted",
      body:  "This is the money you\'ve received but haven\'t assigned to a category yet. Your goal is to get this to ₱0 by assigning every peso.",
    },
    {
      sel: () => document.getElementById("assigned"),
      title: "Total Assigned",
      body:  "The total amount you\'ve budgeted across all your categories this month.",
    },
    {
      sel: () => document.getElementById("remaining"),
      title: "Available Balance",
      body:  "Your real spendable balance — total income minus total spending. This is what you actually have left.",
    },
    {
      sel: () => document.getElementById("spent"),
      title: "Total Spent",
      body:  "Every expense you\'ve recorded this month, across all budget categories.",
    },
    {
      sel: () => document.getElementById("overspent"),
      title: "Overspent",
      body:  "Categories where you spent more than you assigned. At month-end rollover, you\'ll decide how to handle each one.",
    },
    {
      sel: () => document.querySelector(".actions button:nth-child(1)"),
      title: "+ Income",
      body:  "Tap here to record your salary, allowance, or any money coming in. Income fills up your To Be Budgeted amount.",
    },
    {
      sel: () => document.querySelector(".actions button:nth-child(2)"),
      title: "+ Category",
      body:  "Add a new budget envelope — like Groceries, Rent, or Entertainment. Assign money from TBB to each one.",
    },
    {
      sel: () => document.querySelector(".actions button:nth-child(3)"),
      title: "+ Transaction",
      body:  "Record a purchase or expense. It will be deducted from the matching budget category.",
    },
  ];

  let _step = 0, _on = false;
  let _ov, _hl, _tt;

  async function _readState() {
    if (!currentUser) return { done: false, step: 0 };
    try {
      const s = await db.collection("users").doc(currentUser.uid).get();
      const d = s.exists ? s.data() : {};
      return { done: !!d.dashboardTourComplete, step: d.dashboardTourStep || 0 };
    } catch (_) { return { done: false, step: 0 }; }
  }
  async function _saveStep(n) {
    if (!currentUser) return;
    try { await db.collection("users").doc(currentUser.uid).set({ dashboardTourStep: n }, { merge: true }); } catch (_) {}
  }
  async function _markDone() {
    if (!currentUser) return;
    try { await db.collection("users").doc(currentUser.uid).set({ dashboardTourComplete: true, dashboardTourStep: TOTAL }, { merge: true }); } catch (_) {}
  }

  async function checkAndStart() {
    const st = await _readState();
    if (st.done) return;
    _step = Math.min(st.step, TOTAL - 1);
    _boot();
  }

  function _boot() {
    if (_on) return;
    _on = true;
    _ov = document.getElementById("tour-overlay");
    _hl = document.getElementById("tour-highlight");
    _tt = document.getElementById("tour-tooltip");
    if (!_ov) return;
    _ov.style.display = "block";
    _wire();
    _go(_step);
  }

  function _stop() {
    _on = false;
    if (_ov) _ov.style.display = "none";
    _ov = _hl = _tt = null;
  }

  function _wire() {
    ["tour-next-btn","tour-back-btn","tour-skip-btn"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const clone = el.cloneNode(true);
      el.replaceWith(clone);
    });
    document.getElementById("tour-next-btn")?.addEventListener("click", _next);
    document.getElementById("tour-back-btn")?.addEventListener("click", _back);
    document.getElementById("tour-skip-btn")?.addEventListener("click", _skip);
  }

  async function _next() {
    await _saveStep(_step + 1);
    if (_step >= TOTAL - 1) {
      await _markDone();
      _stop();
      showToast("Dashboard tour complete! You know your way around. 🎉", "success");
    } else {
      _step++; _go(_step);
    }
  }
  function _back() { if (_step > 0) { _step--; _go(_step); } }
  function _skip() { _saveStep(_step); _stop(); }

  function _go(idx) {
    const s = STEPS[idx];
    if (!s) return;
    const tgt = s.sel();

    // Update text content
    document.getElementById("tour-step-count").textContent = `Step ${idx + 1} of ${TOTAL}`;
    document.getElementById("tour-title").textContent      = s.title;
    document.getElementById("tour-body").textContent       = s.body;

    const nb = document.getElementById("tour-next-btn");
    if (nb) nb.textContent = idx === TOTAL - 1 ? "Finish ✓" : "Next →";
    const bb = document.getElementById("tour-back-btn");
    if (bb) bb.style.visibility = idx === 0 ? "hidden" : "visible";

    if (!tgt) {
      if (idx < TOTAL - 1) { _step++; _go(_step); }
      return;
    }

    // Only scroll if the element is genuinely OFF-screen (clipped).
    // If it's already fully visible, skip the scroll — that prevents the
    // tooltip from positioning to the wrong place during a mid-scroll measure.
    const r0 = tgt.getBoundingClientRect();
    const partiallyHidden = r0.top < 0 || r0.bottom > window.innerHeight;

    if (partiallyHidden) {
      tgt.scrollIntoView({ behavior: "smooth", block: "center" });
      _waitForScrollEnd(() => _place(tgt));
    } else {
      requestAnimationFrame(() => _place(tgt));
    }
  }

  // Waits until window scroll position stops changing, then runs callback
  function _waitForScrollEnd(cb) {
    let last = window.scrollY;
    let stable = 0;
    const tick = () => {
      const now = window.scrollY;
      if (Math.abs(now - last) < 0.5) {
        stable++;
        if (stable >= 2) { cb(); return; }
      } else {
        stable = 0;
      }
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function _place(tgt) {
    if (!_hl || !_tt) return;
    const P = 8;
    const r = tgt.getBoundingClientRect();

    // Safety: skip if element has no size (hidden / not laid out)
    if (r.width === 0 || r.height === 0) {
      _hl.style.cssText = "display:none";
      _tt.style.left = "-9999px";
      return;
    }

    // Highlight cutout around the target
    _hl.style.cssText = `left:${r.left - P}px;top:${r.top - P}px;width:${r.width + P * 2}px;height:${r.height + P * 2}px;`;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const TW = Math.min(320, vw - 32);
    const GAP = 18; // gap between target and tooltip (incl. arrow)

    // Render tooltip off-screen first to measure its true height
    _tt.style.left = "-9999px";
    _tt.style.top  = "0px";
    _tt.style.width = `${TW}px`;

    // Force a reflow then measure
    const tH = _tt.offsetHeight;

    // Decide above or below based on actual tooltip height
    const spaceBelow = vh - r.bottom - GAP;
    const spaceAbove = r.top - GAP;
    const below = spaceBelow >= tH || spaceBelow >= spaceAbove;

    const arr = document.getElementById("tour-arrow");
    if (arr) arr.className = below ? "arrow-up" : "arrow-down";

    // Horizontal: align tooltip near the center of the target, clamp to viewport
    let lx = r.left + (r.width / 2) - (TW / 2);
    if (lx + TW > vw - 16) lx = vw - TW - 16;
    if (lx < 16) lx = 16;

    _tt.style.left  = `${lx}px`;
    _tt.style.width = `${TW}px`;

    if (below) {
      _tt.style.top    = `${r.bottom + GAP}px`;
      _tt.style.bottom = "auto";
    } else {
      _tt.style.top    = `${r.top - GAP - tH}px`;
      _tt.style.bottom = "auto";
    }

    // Position arrow pointing back at the target center
    if (arr) {
      const arrowX = Math.max(14, Math.min(r.left + r.width / 2 - lx - 10, TW - 30));
      arr.style.left = `${arrowX}px`;
    }
  }

  let _rsz;
  window.addEventListener("resize", () => {
    if (!_on) return;
    clearTimeout(_rsz);
    _rsz = setTimeout(() => {
      const s = STEPS[_step];
      if (!s) return;
      const t = s.sel();
      if (t) _place(t);
    }, 120);
  });

  return { checkAndStart, isActive: () => _on };
})();

// ════════════════════════════════════════════════════════════════════════════
// FEATURE 1 — Accounts Tooltip Tour
// ════════════════════════════════════════════════════════════════════════════

const AccountsTour = (() => {
  const TOTAL = 4;
  const STEPS = [
    { sel: () => {
        // Pick whichever Add Account button is actually visible right now.
        // When user has 0 accounts the header button is hidden and the prompt
        // banner shows its own CTA — point at that one instead.
        const candidates = [
          document.getElementById("acct-prompt-add-btn"),
          document.getElementById("add-account-btn"),
        ];
        for (const el of candidates) {
          if (el && el.offsetParent !== null) return el; // visible
        }
        return null;
      },
      title: "Add your first account",
      body: "Tap here to add a bank account, cash wallet, GCash, Maya, or credit card." },
    { sel: () => document.querySelector(".nw-cell:nth-child(1)"),
      title: "Total assets",
      body: "The total value of all your asset accounts — savings, cash, and e-wallets." },
    { sel: () => document.querySelector(".nw-cell:nth-child(2)"),
      title: "Total liabilities",
      body: "The total amount you owe across credit cards, loans, and other debts." },
    { sel: () => document.querySelector(".nw-cell:nth-child(3)"),
      title: "Net worth",
      body: "Assets minus Liabilities. The single most important number in your financial life." },
  ];

  let _step = 0, _on = false;
  let _ov, _hl, _tt;

  async function _readState() {
    if (!currentUser) return { done: false, step: 0 };
    try {
      const s = await db.collection("users").doc(currentUser.uid).get();
      const d = s.exists ? s.data() : {};
      return { done: !!d.accountsTourComplete, step: d.accountsTourStep || 0 };
    } catch(_) { return { done: false, step: 0 }; }
  }
  async function _saveStep(n) {
    if (!currentUser) return;
    try { await db.collection("users").doc(currentUser.uid).set({ accountsTourStep: n }, { merge: true }); } catch(_) {}
  }
  async function _markDone() {
    if (!currentUser) return;
    try { await db.collection("users").doc(currentUser.uid).set({ accountsTourComplete: true, accountsTourStep: TOTAL }, { merge: true }); } catch(_) {}
  }

  async function checkAndStart() {
    const st = await _readState();
    if (st.done) return;
    _step = Math.min(st.step, TOTAL - 1);
    _boot();
  }

  function _boot() {
    if (_on) return;
    _on = true;
    _ov = document.getElementById("tour-overlay");
    _hl = document.getElementById("tour-highlight");
    _tt = document.getElementById("tour-tooltip");
    if (!_ov) return;
    _ov.style.display = "block";
    _wire();
    _go(_step);
  }

  function _stop() {
    _on = false;
    if (_ov) _ov.style.display = "none";
    _ov = _hl = _tt = null;
  }

  function _wire() {
    ["tour-next-btn","tour-back-btn","tour-skip-btn"].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const clone = el.cloneNode(true); el.replaceWith(clone);
    });
    document.getElementById("tour-next-btn")?.addEventListener("click", _next);
    document.getElementById("tour-back-btn")?.addEventListener("click", _back);
    document.getElementById("tour-skip-btn")?.addEventListener("click", _skip);
  }

  async function _next() {
    await _saveStep(_step + 1);
    if (_step >= TOTAL - 1) { await _markDone(); _stop(); showToast("Tour complete! You know your way around. 🎉","success"); }
    else { _step++; _go(_step); }
  }
  function _back() { if (_step > 0) { _step--; _go(_step); } }
  function _skip() { _saveStep(_step); _stop(); }

  function _go(idx) {
    const s = STEPS[idx];
    if (!s) return;
    let tgt = s.sel();
    if (!tgt && s.fb) tgt = s.fb();

    document.getElementById("tour-step-count").textContent = `Step ${idx+1} of ${TOTAL}`;
    document.getElementById("tour-title").textContent      = s.title;
    document.getElementById("tour-body").textContent       = s.body;
    const nb = document.getElementById("tour-next-btn");
    if (nb) nb.textContent = idx === TOTAL-1 ? "Finish \u2713" : "Next \u2192";
    const bb = document.getElementById("tour-back-btn");
    if (bb) bb.style.visibility = idx === 0 ? "hidden" : "visible";

    if (!tgt) { if (idx < TOTAL-1) { _step++; _go(_step); } return; }

    const r0 = tgt.getBoundingClientRect();
    // Only scroll if the element is genuinely OFF-screen (clipped),
    // not just near an edge. If the user can already see the element,
    // we don\'t move them around — that prevents the tooltip from
    // appearing in the wrong place while the page is mid-scroll.
    const fullyVisible = r0.top >= 0 && r0.bottom <= window.innerHeight;
    const partiallyHidden = r0.top < 0 || r0.bottom > window.innerHeight;

    if (partiallyHidden) {
      tgt.scrollIntoView({ behavior: "smooth", block: "center" });
      _waitForScrollEnd(() => _place(tgt));
    } else {
      // Element is already fully on-screen — place tooltip immediately
      requestAnimationFrame(() => _place(tgt));
    }
  }

  function _waitForScrollEnd(cb) {
    let last = window.scrollY, stable = 0;
    const tick = () => {
      const now = window.scrollY;
      if (Math.abs(now - last) < 0.5) { stable++; if (stable >= 2) { cb(); return; } }
      else { stable = 0; }
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function _place(tgt) {
    if (!_hl || !_tt) return;
    const P = 8;
    const r = tgt.getBoundingClientRect();

    // Safety: if rect is zero-sized (element hidden, not yet laid out),
    // skip placement entirely — hide highlight and tooltip so they don\'t
    // appear pinned at the top-left corner.
    if (r.width === 0 || r.height === 0) {
      _hl.style.cssText = "display:none";
      _tt.style.left = "-9999px";
      return;
    }

    _hl.style.cssText = `left:${r.left - P}px;top:${r.top - P}px;width:${r.width + P * 2}px;height:${r.height + P * 2}px;`;

    const vw = window.innerWidth, vh = window.innerHeight;
    const TW = Math.min(320, vw - 32);
    const GAP = 18;

    _tt.style.left  = "-9999px";
    _tt.style.top   = "0px";
    _tt.style.width = `${TW}px`;
    const tH = _tt.offsetHeight;

    const spaceBelow = vh - r.bottom - GAP;
    const spaceAbove = r.top - GAP;
    const below = spaceBelow >= tH || spaceBelow >= spaceAbove;

    const arr = document.getElementById("tour-arrow");
    if (arr) arr.className = below ? "arrow-up" : "arrow-down";

    let lx = r.left + (r.width / 2) - (TW / 2);
    if (lx + TW > vw - 16) lx = vw - TW - 16;
    if (lx < 16) lx = 16;

    _tt.style.left  = `${lx}px`;
    _tt.style.width = `${TW}px`;

    if (below) { _tt.style.top = `${r.bottom + GAP}px`; _tt.style.bottom = "auto"; }
    else       { _tt.style.top = `${r.top - GAP - tH}px`; _tt.style.bottom = "auto"; }

    if (arr) {
      const arrowX = Math.max(14, Math.min(r.left + r.width / 2 - lx - 10, TW - 30));
      arr.style.left = `${arrowX}px`;
    }
  }

  let _rsz;
  window.addEventListener("resize", () => {
    if (!_on) return;
    clearTimeout(_rsz);
    _rsz = setTimeout(() => { const s = STEPS[_step]; if (!s) return; let t = s.sel(); if (!t&&s.fb) t=s.fb(); if(t) _place(t); }, 120);
  });

  return { checkAndStart, isActive: () => _on };
})();




auth.onAuthStateChanged(async (user) => {
  if (!user) return window.location.href = "auth.html";
  currentUser = user;

  await loadBudgetSection();
});




// ===== Sharp-Canvas Chart Factory =====
// Creates a Chart.js instance with:
//  - responsive: false  → fixed px size, never resizes on zoom
//  - devicePixelRatio   → crisp on Retina / HiDPI screens
//  - fixed 560×260 px   → compact, consistent across all zoom levels
const CHART_W = 560; // logical CSS pixels
const CHART_H = 260;

function createSharpChart(canvasId, config) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;

  const dpr = window.devicePixelRatio || 1;

  // Set the canvas to a fixed logical size (zoom-proof)
  canvas.style.width  = CHART_W + 'px';
  canvas.style.height = CHART_H + 'px';
  // Scale the backing store for Retina sharpness
  canvas.width  = Math.round(CHART_W * dpr);
  canvas.height = Math.round(CHART_H * dpr);

  // Force responsive off and lock dimensions in Chart.js options
  const mergedConfig = {
    ...config,
    options: {
      ...(config.options || {}),
      responsive: false,        // ← never auto-resize
      maintainAspectRatio: false,
      width:  CHART_W,
      height: CHART_H,
      devicePixelRatio: dpr     // ← crisp on HiDPI
    }
  };

  return new Chart(canvas, mergedConfig);
}

// ===== Reports Section =====

    // YNAB Color Palette
    const ynabColors = [
      '#005a9c', '#16a085', '#e74c3c', '#f39c12', 
      '#9b59b6', '#f1c40f', '#1abc9c', '#e91e63', 
      '#3f51b5', '#95a5a6', '#34495e', '#2ecc71'
    ];

    // Chart instances
    let charts = {
      spending: null,
      incomeExpense: null,
      netWorth: null,
      trends: null
    };

    // Global data
    let budgetData = null;
    let currentDateRange = 'current-month';

    // Initialize
document.addEventListener('DOMContentLoaded', function() {
  setupEventListeners();
  
  // Transaction filter event listeners
  const searchInput = document.getElementById("searchTransactions");
  const categoryFilter = document.getElementById("filterCategory");
  const dateFromFilter = document.getElementById("filterDateFrom");
  const dateToFilter = document.getElementById("filterDateTo");
  
  if (searchInput) searchInput.addEventListener('input', applyTransactionFilters);
  if (categoryFilter) categoryFilter.addEventListener('change', applyTransactionFilters);
  if (dateFromFilter) dateFromFilter.addEventListener('change', applyTransactionFilters);
  if (dateToFilter) dateToFilter.addEventListener('change', applyTransactionFilters);
});

    auth.onAuthStateChanged(user => {
      if (user) {
        loadData();
      } else {
        window.location.href = 'auth.html';
      }
    });

    function setupEventListeners() {
      // Tab switching
      document.querySelectorAll('.report-tab').forEach(tab => {
        tab.addEventListener('click', function() {
          switchTab(this.dataset.report);
        });
      });

      // Date range selection
      document.getElementById('dateRange').addEventListener('change', function() {
        const customRangeElements = document.querySelectorAll('[id^="customDateRange"]');
        if (this.value === 'custom') {
          customRangeElements.forEach(el => el.style.display = 'block');
        } else {
          customRangeElements.forEach(el => el.style.display = 'none');
        }
        currentDateRange = this.value;
      });
    }

    function switchTab(reportType) {
      // Update tab active state
      document.querySelectorAll('.report-tab').forEach(tab => {
        tab.classList.remove('active');
      });
      document.querySelector(`[data-report="${reportType}"]`).classList.add('active');

      // Update content active state
      document.querySelectorAll('.report-content').forEach(content => {
        content.classList.remove('active');
      });
      document.getElementById(`report-${reportType}`).classList.add('active');

      // Load specific report data
      if (budgetData) {
        switch(reportType) {
          case 'spending':
            loadSpendingReport();
            break;
          case 'income-expense':
            loadIncomeExpenseReport();
            break;
          case 'net-worth':
            loadNetWorthReport();
            break;
          case 'trends':
            loadTrendsReport();
            break;
        }
      }
    }

  async function loadData() {
  const user = auth.currentUser;
  if (!user) return;

  try {
    const budgetRef = db.collection("budget").doc(user.uid);
    const budgetSnap = await budgetRef.get();
    
    if (!budgetSnap.exists) {
      console.log('No budget data found');
      return;
    }

    budgetData = budgetSnap.data();
    
    // ✅ Initialize months object
    budgetData.months = {};
    
    // Load ALL months data
    const monthsRef = budgetRef.collection("months");
    const monthsSnap = await monthsRef.get();
    
    monthsSnap.forEach(doc => {
      budgetData.months[doc.id] = doc.data();
    });

    // ✅ Debug: Log what we loaded
   //console.log("📊 Loaded months:", Object.keys(budgetData.months));
    //console.log("📊 Current month:", budgetData.currentMonth);
    
    // ✅ Ensure current month exists
    const currentMonth = budgetData.currentMonth || new Date().toISOString().slice(0, 7);
    if (!budgetData.months[currentMonth]) {
      console.warn("⚠️ Current month not found in months collection, loading it now...");
      const currentMonthRef = budgetRef.collection("months").doc(currentMonth);
      const currentMonthSnap = await currentMonthRef.get();
      
      if (currentMonthSnap.exists) {
        budgetData.months[currentMonth] = currentMonthSnap.data();
        console.log("✅ Loaded current month data:", currentMonthSnap.data());
      } else {
        console.error("❌ Current month document doesn't exist in Firestore!");
      }
    }

    // Load initial reports
    loadAllReports();
  } catch (error) {
    console.error('❌ Error loading data:', error);
  }
}

    function loadAllReports() {
      loadSpendingReport();
      loadIncomeExpenseReport();
      loadNetWorthReport();
      loadTrendsReport();
    }

    function getDateRange() {
      const now = new Date();
      let startDate, endDate;

      switch(currentDateRange) {
        case 'current-month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          break;
        case 'last-month':
          startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          endDate = new Date(now.getFullYear(), now.getMonth(), 0);
          break;
        case 'last-3-months':
          startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          break;
        case 'last-6-months':
          startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          break;
        case 'current-year':
          startDate = new Date(now.getFullYear(), 0, 1);
          endDate = new Date(now.getFullYear(), 11, 31);
          break;
        case 'custom':
          const fromDate = document.getElementById('fromDate').value;
          const toDate = document.getElementById('toDate').value;
          if (fromDate && toDate) {
            startDate = new Date(fromDate);
            endDate = new Date(toDate);
          } else {
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
          }
          break;
        default:
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      }

      return { startDate, endDate };
    }

  function getFilteredTransactions() {
  if (!budgetData || !budgetData.months) {
    console.warn("⚠️ No budgetData or months available");
    return [];
  }
  
  const { startDate, endDate } = getDateRange();
  let allTransactions = [];

  console.log("🔍 Filtering transactions from", startDate.toISOString().slice(0, 10), "to", endDate.toISOString().slice(0, 10));
  console.log("🔍 Available months:", Object.keys(budgetData.months));

  // Include transactions from ALL months collection
  Object.entries(budgetData.months).forEach(([monthKey, monthData]) => {
    if (monthData.transactions && Array.isArray(monthData.transactions)) {
      console.log(` Checking month ${monthKey}: ${monthData.transactions.length} transactions`);
      
      monthData.transactions.forEach(transaction => {
        const transactionDate = new Date(transaction.date);
        
        if (transactionDate >= startDate && transactionDate <= endDate) {
          // ✅ Avoid duplicates by checking id
          const exists = allTransactions.find(t => t.id === transaction.id);
          if (!exists) {
            allTransactions.push(transaction);
          }
        }
      });
    }
  });

  console.log("✅ Filtered transactions:", allTransactions.length);
  return allTransactions;
}




// ✅ Get current theme colors for charts
function getThemeColors() {
  const style = getComputedStyle(document.documentElement);
  return {
    primary: style.getPropertyValue('--primary').trim(),
    text: style.getPropertyValue('--text').trim(),
    textLight: style.getPropertyValue('--text-light').trim(),
    cardBg: style.getPropertyValue('--card-bg').trim(),
    green: style.getPropertyValue('--ynab-green').trim(),
    red: style.getPropertyValue('--ynab-red').trim(),
    bg: style.getPropertyValue('--bg').trim()
  };
}





// ===== ENHANCED REPORT FUNCTIONS =====

function loadSpendingReport() {
  if (!budgetData || !budgetData.months) {
    console.warn("⚠️ No budget data available for spending report");
    return;
  }

  const { startDate, endDate } = getDateRange();
  
  // ✅ Get theme colors
  const themeColors = getThemeColors();
  
  const categoryTotals = {};
  const categoryTransactionCounts = {};
  let totalSpending = 0;

  Object.entries(budgetData.months).forEach(([monthKey, monthData]) => {
    if (monthData.transactions && Array.isArray(monthData.transactions)) {
      monthData.transactions.forEach(transaction => {
        const transactionDate = new Date(transaction.date);
        
        // ✅ Exclude account transactions from spending report
        const isAccountTransaction = transaction.category === 'Deposit' || 
                                     transaction.category === 'Withdrawal' || 
                                     transaction.category === 'Transfer';
        
        if (transactionDate >= startDate && 
            transactionDate <= endDate && 
            transaction.type === 'expense' && 
            !isAccountTransaction) {
          const category = transaction.category || 'Uncategorized';
          categoryTotals[category] = (categoryTotals[category] || 0) + transaction.amount;
          categoryTransactionCounts[category] = (categoryTransactionCounts[category] || 0) + 1;
          totalSpending += transaction.amount;
        }
      });
    }
  });

  const days = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
  const dailyAverage = totalSpending / days;

  document.getElementById('total-spending').textContent = formatCurrency(totalSpending);
  document.getElementById('avg-daily-spending').textContent = formatCurrency(dailyAverage);

  const topCategory = Object.keys(categoryTotals).reduce((a, b) => 
    categoryTotals[a] > categoryTotals[b] ? a : b, 'None'
  );
  document.getElementById('top-category-spending').textContent = 
    topCategory !== 'None' ? formatCurrency(categoryTotals[topCategory]) : formatCurrency(0);

  const categories = Object.keys(categoryTotals);
  const amounts = Object.values(categoryTotals);
  const colors = ynabColors.slice(0, categories.length);

  createInteractiveLegend(categories, amounts, colors);

  if (charts.spending) {
    charts.spending.destroy();
  }

  const ctx = document.getElementById('spendingChart').getContext('2d');
  
  let chartConfig = {
    type: currentSpendingChartType,
    data: {
      labels: categories,
      datasets: [{
        data: amounts,
        backgroundColor: colors,
        borderWidth: 2,
        borderColor: themeColors.cardBg // ✅ Use theme color
      }]
    },
    options: {
      plugins: {
        legend: {
          display: false
        },
        tooltip: {
          backgroundColor: themeColors.cardBg, // ✅ Theme color
          titleColor: themeColors.text, // ✅ Theme color
          bodyColor: themeColors.text, // ✅ Theme color
          borderColor: themeColors.primary, // ✅ Theme color
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              const percentage = ((context.raw / totalSpending) * 100).toFixed(1);
              return `${context.label}: ${formatCurrency(context.raw)} (${percentage}%)`;
            }
          }
        }
      }
    }
  };

  if (currentSpendingChartType === 'bar') {
    chartConfig.options.scales = {
      y: {
        beginAtZero: true,
        ticks: {
          color: themeColors.text, // ✅ Theme color
          callback: function(value) {
            return formatCurrency(value);
          }
        },
        grid: {
          color: themeColors.textLight + '20' // ✅ Semi-transparent theme color
        }
      },
      x: {
        ticks: {
          color: themeColors.text // ✅ Theme color
        },
        grid: {
          color: themeColors.textLight + '20'
        }
      }
    };
    chartConfig.data.datasets[0].borderRadius = 4;
  }

  charts.spending = createSharpChart('spendingChart', chartConfig);

  const breakdownList = document.getElementById('spendingBreakdown');
  if (categories.length === 0) {
    breakdownList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">📊</div>
        <p>No spending data available for the selected period.</p>
      </div>
    `;
  } else {
    const sortedCategories = categories
      .map((cat, index) => ({ 
        name: cat, 
        amount: amounts[index], 
        color: colors[index],
        count: categoryTransactionCounts[cat] || 0
      }))
      .sort((a, b) => b.amount - a.amount);

    breakdownList.innerHTML = sortedCategories.map(item => `
      <div class="breakdown-item">
        <div class="breakdown-category">
          <div class="category-color" style="background-color: ${item.color}"></div>
          <div class="category-name">${item.name}</div>
        </div>
        <div class="category-amount">${formatCurrency(item.amount)}</div>
      </div>
    `).join('');
  }

  const tableBody = document.getElementById('spendingTableBody');
  tableBody.innerHTML = categories.map((cat, index) => {
    const percentage = ((amounts[index] / totalSpending) * 100).toFixed(1);
    const count = categoryTransactionCounts[cat] || 0;
    return `
      <tr>
        <td>${cat}</td>
        <td>${formatCurrency(amounts[index])}</td>
        <td>${percentage}%</td>
        <td>${count}</td>
      </tr>
    `;
  }).join('');
}


function loadIncomeExpenseReport() {
  const monthlyData = getMonthlyIncomeExpense();
  const themeColors = getThemeColors(); // ✅ Add this line

  const totalIncome = monthlyData.income.reduce((sum, amount) => sum + amount, 0);
  const totalExpenses = monthlyData.expenses.reduce((sum, amount) => sum + amount, 0);
  const netIncome = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? ((netIncome / totalIncome) * 100).toFixed(1) : 0;

  document.getElementById('total-income').textContent = formatCurrency(totalIncome);
  document.getElementById('total-expenses').textContent = formatCurrency(totalExpenses);
  document.getElementById('net-income').textContent = formatCurrency(netIncome);
  document.getElementById('net-income').className = `metric-value ${netIncome >= 0 ? 'positive' : 'negative'}`;

  document.getElementById('summary-income').textContent = formatCurrency(totalIncome);
  document.getElementById('summary-expenses').textContent = formatCurrency(totalExpenses);
  document.getElementById('summary-net').textContent = formatCurrency(netIncome);
  document.getElementById('summary-net').className = `summary-value ${netIncome >= 0 ? 'positive' : 'negative'}`;
  document.getElementById('summary-savings-rate').textContent = `${savingsRate}%`;

  if (charts.incomeExpense) {
    charts.incomeExpense.destroy();
  }

  const ctx = document.getElementById('incomeExpenseChart').getContext('2d');
  
  let chartConfig = {
    type: currentIncomeExpenseChartType === 'area' ? 'line' : currentIncomeExpenseChartType,
    data: {
      labels: monthlyData.labels,
      datasets: [{
        label: 'Income',
        data: monthlyData.income,
        backgroundColor: currentIncomeExpenseChartType === 'area' ? (themeColors.green + '40') : themeColors.green,
        borderColor: themeColors.green,
        borderWidth: 2,
        fill: currentIncomeExpenseChartType === 'area',
        tension: 0.4,
        borderRadius: 4
      }, {
        label: 'Expenses',
        data: monthlyData.expenses,
        backgroundColor: currentIncomeExpenseChartType === 'area' ? (themeColors.red + '40') : themeColors.red,
        borderColor: themeColors.red,
        borderWidth: 2,
        fill: currentIncomeExpenseChartType === 'area',
        tension: 0.4,
        borderRadius: 4
      }]
    },
    options: {
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            padding: 20,
            color: themeColors.text
          }
        },
        tooltip: {
          backgroundColor: themeColors.cardBg,
          titleColor: themeColors.text,
          bodyColor: themeColors.text,
          borderColor: themeColors.primary,
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              return `${context.dataset.label}: ${formatCurrency(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: themeColors.text
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: themeColors.textLight + '20'
          },
          ticks: {
            color: themeColors.text,
            callback: function(value) {
              return formatCurrency(value);
            }
          }
        }
      }
    }
  };


  charts.incomeExpense = createSharpChart('incomeExpenseChart', chartConfig);

  // ===== Itemized Income vs Expense Table =====
  const tableBody = document.getElementById('incomeExpenseTableBody');
  tableBody.innerHTML = '';

  monthlyData.labels.forEach((label, idx) => {
    const income   = monthlyData.income[idx];
    const expenses = monthlyData.expenses[idx];
    const net      = income - expenses;
    const rate     = income > 0 ? ((net / income) * 100).toFixed(1) : '0.0';
    const monthKey = (() => {
      // Reverse-engineer monthKey from label (e.g. "Jan '25" → "2025-01")
      const { startDate } = getDateRange();
      const d = new Date(startDate);
      d.setMonth(d.getMonth() + idx);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();

    // Gather itemized transactions for this month
    const monthData = budgetData.months ? budgetData.months[monthKey] : null;
    const incomeItems   = [];
    const expenseItems  = [];

    if (monthData && monthData.transactions) {
      monthData.transactions.forEach(t => {
        const isAccountTx = t.category === 'Deposit' || t.category === 'Withdrawal' || t.category === 'Transfer';
        if (isAccountTx) return;
        if (t.type === 'income')  incomeItems.push(t);
        if (t.type === 'expense') expenseItems.push(t);
      });
    }

    // Sort by date descending
    const byDate = (a, b) => new Date(b.date) - new Date(a.date);
    incomeItems.sort(byDate);
    expenseItems.sort(byDate);

    const rowId     = `ie-row-${idx}`;
    const drawerId  = `ie-drawer-${idx}`;

    // ---- Summary row ----
    const summaryRow = document.createElement('div');
    summaryRow.className = 'ie-summary-row';
    summaryRow.id = rowId;
    summaryRow.innerHTML = `
      <span class="ie-col-month ie-month-label">${label}</span>
      <span class="ie-col-income  ie-income-val">${formatCurrency(income)}</span>
      <span class="ie-col-expense ie-expense-val">${formatCurrency(expenses)}</span>
      <span class="ie-col-net ${net >= 0 ? 'ie-net-positive' : 'ie-net-negative'}">${formatCurrency(net)}</span>
      <span class="ie-col-rate   ie-rate-val">${rate}%</span>
      <span class="ie-col-toggle">
        <span class="ie-chevron">
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </span>
      </span>
    `;

    // ---- Drawer: interactive full table ----
    const buildSection = (items, type, sectionIdx) => {
      const typeLabel  = type === 'income' ? 'Income' : 'Expenses';
      const dotClass   = type;
      const amtClass   = type;
      const catClass   = type + '-cat';
      const prefix     = type === 'income' ? '+' : '-';
      const headerColor = type === 'income' ? 'var(--ynab-green)' : 'var(--ynab-red)';
      const tableId    = `ie-tbl-${idx}-${sectionIdx}`;
      const searchId   = `ie-search-${idx}-${sectionIdx}`;
      const countId    = `ie-count-${idx}-${sectionIdx}`;
      const sortBadgeId= `ie-sortbadge-${idx}-${sectionIdx}`;
      const subtotalId = `ie-subtotal-${idx}-${sectionIdx}`;

      if (items.length === 0) {
        return `
          <div class="ie-section-block">
            <div class="ie-section-header">
              <span class="ie-section-dot ${dotClass}"></span>
              ${typeLabel}
              <span style="margin-left:auto;color:${headerColor};font-weight:400">0 transactions</span>
            </div>
            <div class="ie-empty">No ${type} transactions this month.</div>
          </div>`;
      }

      const subtotal = items.reduce((s, t) => s + t.amount, 0);

      const buildRows = (rows) => rows.map(t => {
        const d = new Date(t.date + 'T00:00:00');
        const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
        const name     = (t.name     || '—');
        const category = (t.category || '—');
        return `<tr>
          <td class="ie-td-date">${dateStr}</td>
          <td class="ie-td-name" data-ie-tip="${name.replace(/"/g,"&quot;")}" title="${name.replace(/"/g,"&quot;")}">${name}</td>
          <td class="ie-td-category"><span class="ie-cat-pill ${catClass}" data-ie-tip="${category.replace(/"/g,"&quot;")}" title="${category.replace(/"/g,"&quot;")}">${category}</span></td>
          <td class="ie-td-amount ${amtClass}">${prefix}${formatCurrency(t.amount)}</td>
        </tr>`;
      }).join('');

      return `
        <div class="ie-section-block">
          <div class="ie-section-header">
            <span class="ie-section-dot ${dotClass}"></span>
            ${typeLabel}
            <span style="margin-left:auto;color:${headerColor};font-weight:400" id="${countId}">${items.length} transaction${items.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="ie-toolbar">
            <div class="ie-search-wrap">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <input class="ie-search-input" id="${searchId}" type="text" placeholder="Search transactions…" autocomplete="off" />
            </div>
            <span class="ie-sort-badge" id="${sortBadgeId}">Sorted by Date ↓</span>
          </div>
          <div class="ie-table-scroll">
            <table class="ie-full-table" id="${tableId}" data-type="${type}" data-sort-col="date" data-sort-dir="desc" data-section="${sectionIdx}">
              <thead>
                <tr>
                  <th style="width:90px" data-col="date">
                    <div class="ie-th-inner">Date <span class="ie-sort-icon"><svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><path d="M4 0L7 4H1L4 0Z"/><path d="M4 10L1 6H7L4 10Z"/></svg></span></div>
                    <div class="ie-resize-handle"></div>
                  </th>
                  <th style="width:180px" data-col="name">
                    <div class="ie-th-inner">Description <span class="ie-sort-icon"><svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><path d="M4 0L7 4H1L4 0Z"/><path d="M4 10L1 6H7L4 10Z"/></svg></span></div>
                    <div class="ie-resize-handle"></div>
                  </th>
                  <th style="width:160px" data-col="category">
                    <div class="ie-th-inner">Category <span class="ie-sort-icon"><svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><path d="M4 0L7 4H1L4 0Z"/><path d="M4 10L1 6H7L4 10Z"/></svg></span></div>
                    <div class="ie-resize-handle"></div>
                  </th>
                  <th style="width:110px" data-col="amount">
                    <div class="ie-th-inner" style="justify-content:flex-end">Amount <span class="ie-sort-icon"><svg width="8" height="10" viewBox="0 0 8 10" fill="currentColor"><path d="M4 0L7 4H1L4 0Z"/><path d="M4 10L1 6H7L4 10Z"/></svg></span></div>
                    <div class="ie-resize-handle"></div>
                  </th>
                </tr>
              </thead>
              <tbody>${buildRows(items)}</tbody>
              <tfoot>
                <tr>
                  <td colspan="3" class="ie-tfoot-label">Subtotal (${items.length} transactions)</td>
                  <td class="ie-tfoot-amount ${amtClass}" id="${subtotalId}">${prefix}${formatCurrency(subtotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>`;
    };

    const drawer = document.createElement('div');
    drawer.className = 'ie-detail-drawer';
    drawer.id = drawerId;
    drawer.innerHTML = `
      <div class="ie-detail-inner">
        ${buildSection(incomeItems,  'income',  0)}
        ${buildSection(expenseItems, 'expense', 1)}
      </div>
    `;

    // ---- Wire interactivity after DOM insertion ----
    const wireDrawer = (drawerEl) => {
      // Global tooltip box
      let tipBox = document.getElementById('ie-tooltip-box');
      if (!tipBox) {
        tipBox = document.createElement('div');
        tipBox.id = 'ie-tooltip-box';
        tipBox.className = 'ie-tooltip-box';
        document.body.appendChild(tipBox);
      }
      const showTip = (e, text) => {
        if (!text || !text.trim()) return;
        tipBox.textContent = text;
        tipBox.style.display = 'block';
        tipBox.style.left = (e.clientX + 12) + 'px';
        tipBox.style.top  = (e.clientY + 12) + 'px';
      };
      const hideTip = () => { tipBox.style.display = 'none'; };
      const moveTip = (e) => {
        tipBox.style.left = (e.clientX + 12) + 'px';
        tipBox.style.top  = (e.clientY + 12) + 'px';
      };

      drawerEl.querySelectorAll('[data-ie-tip]').forEach(el => {
        el.addEventListener('mouseenter', e => showTip(e, el.getAttribute('data-ie-tip')));
        el.addEventListener('mousemove',  moveTip);
        el.addEventListener('mouseleave', hideTip);
      });

      // ---- Column resize ----
      drawerEl.querySelectorAll('.ie-full-table').forEach(table => {
        table.querySelectorAll('th').forEach(th => {
          const handle = th.querySelector('.ie-resize-handle');
          if (!handle) return;
          let startX, startW;
          handle.addEventListener('mousedown', e => {
            e.preventDefault();
            startX = e.pageX;
            startW = th.offsetWidth;
            handle.classList.add('dragging');
            const onMove = e2 => {
              const newW = Math.max(60, startW + (e2.pageX - startX));
              th.style.width = newW + 'px';
            };
            const onUp = () => {
              handle.classList.remove('dragging');
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          });
        });

        // ---- Column sort ----
        const sortBadgeEl = drawerEl.querySelector(`#ie-sortbadge-${idx}-${table.dataset.section}`);
        const colNames = { date: 'Date', name: 'Description', category: 'Category', amount: 'Amount' };

        const doSort = (col, dir) => {
          const tbody = table.querySelector('tbody');
          const rows  = Array.from(tbody.querySelectorAll('tr'));
          rows.sort((a, b) => {
            const cells = { date: 0, name: 1, category: 2, amount: 3 };
            const ci = cells[col] ?? 0;
            let va = a.cells[ci]?.textContent?.trim() || '';
            let vb = b.cells[ci]?.textContent?.trim() || '';
            if (col === 'amount') {
              va = parseFloat(va.replace(/[^0-9.\-]/g, '')) || 0;
              vb = parseFloat(vb.replace(/[^0-9.\-]/g, '')) || 0;
              return dir === 'asc' ? va - vb : vb - va;
            }
            if (col === 'date') {
              va = new Date(va); vb = new Date(vb);
              return dir === 'asc' ? va - vb : vb - va;
            }
            return dir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
          });
          rows.forEach(r => tbody.appendChild(r));
          // Update sort icon highlights
          table.querySelectorAll('th').forEach(th2 => th2.classList.remove('sorted'));
          const sortedTh = Array.from(table.querySelectorAll('th')).find(t => t.dataset.col === col);
          if (sortedTh) sortedTh.classList.add('sorted');
          if (sortBadgeEl) sortBadgeEl.textContent = `Sorted by ${colNames[col] || col} ${dir === 'asc' ? '↑' : '↓'}`;
        };

        table.querySelectorAll('th[data-col]').forEach(th => {
          th.querySelector('.ie-th-inner')?.addEventListener('click', () => {
            const col = th.dataset.col;
            const cur = table.dataset.sortDir;
            const curCol = table.dataset.sortCol;
            const dir = (col === curCol && cur === 'desc') ? 'asc' : 'desc';
            table.dataset.sortCol = col;
            table.dataset.sortDir = dir;
            doSort(col, dir);
          });
        });

        // ---- Search / filter ----
        const sectionIdx2 = table.dataset.section;
        const searchEl = drawerEl.querySelector(`#ie-search-${idx}-${sectionIdx2}`);
        const countEl  = drawerEl.querySelector(`#ie-count-${idx}-${sectionIdx2}`);
        const footerEl = drawerEl.querySelector(`#ie-subtotal-${idx}-${sectionIdx2}`);
        const typeAttr = table.dataset.type;
        const pfx      = typeAttr === 'income' ? '+' : '-';

        if (searchEl) {
          searchEl.addEventListener('input', () => {
            const q = searchEl.value.toLowerCase();
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            let visible = 0; let total = 0;
            rows.forEach(row => {
              const text = row.textContent.toLowerCase();
              const show = q === '' || text.includes(q);
              row.style.display = show ? '' : 'none';
              if (show) {
                visible++;
                // Re-tally subtotal from visible rows
                const amtCell = row.cells[3];
                const raw = amtCell?.textContent?.replace(/[^0-9.]/g, '') || '0';
                total += parseFloat(raw) || 0;
              }
            });
            if (countEl) countEl.textContent = `${visible} transaction${visible !== 1 ? 's' : ''}${q ? ' matched' : ''}`;
            if (footerEl) footerEl.textContent = q ? `${pfx}${formatCurrency(total)}` : footerEl.dataset.orig || footerEl.textContent;
            if (!footerEl.dataset.orig) footerEl.dataset.orig = footerEl.textContent;
          });
        }
      });
    };

    // Defer wiring until after DOM insertion
    setTimeout(() => wireDrawer(drawer), 0);

    // Toggle on click
    summaryRow.addEventListener('click', () => {
      const isOpen = summaryRow.classList.contains('open');
      // Close all others
      document.querySelectorAll('.ie-summary-row.open').forEach(r => r.classList.remove('open'));
      document.querySelectorAll('.ie-detail-drawer.open').forEach(d => d.classList.remove('open'));
      if (!isOpen) {
        summaryRow.classList.add('open');
        drawer.classList.add('open');
        summaryRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });

    tableBody.appendChild(summaryRow);
    tableBody.appendChild(drawer);
  });
}

function loadNetWorthReport() {
  const accounts = budgetData.accounts || [];
  const themeColors = getThemeColors(); // ✅ Use theme colors throughout
  
  let totalAssets = 0;
  let totalLiabilities = 0;
  let accountBreakdown = [];

  accounts.forEach(account => {
    if (account.balance >= 0) {
      totalAssets += account.balance;
    } else {
      totalLiabilities += Math.abs(account.balance);
    }
    
    accountBreakdown.push({
      name: account.name,
      balance: account.balance,
      type: account.balance >= 0 ? 'asset' : 'liability'
    });
  });

  const netWorth = totalAssets - totalLiabilities;

  document.getElementById('total-assets').textContent = formatCurrency(totalAssets);
  document.getElementById('total-liabilities').textContent = formatCurrency(totalLiabilities);
  document.getElementById('net-worth-value').textContent = formatCurrency(netWorth);
  document.getElementById('net-worth-value').className = `metric-value ${netWorth >= 0 ? 'positive' : 'negative'}`;

 if (charts.netWorth) {
    charts.netWorth.destroy();
  }

  const ctx = document.getElementById('netWorthChart').getContext('2d');
  
  // ✅ Prepare account breakdown data for chart
  const assetAccounts = accountBreakdown.filter(acc => acc.type === 'asset');
  const liabilityAccounts = accountBreakdown.filter(acc => acc.type === 'liability');
  
  // Sort by balance
  assetAccounts.sort((a, b) => b.balance - a.balance);
  liabilityAccounts.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
  
  // Combine all accounts for chart
  const allAccountsForChart = [
    ...assetAccounts.map(acc => ({ name: acc.name, balance: acc.balance, isAsset: true })),
    ...liabilityAccounts.map(acc => ({ name: acc.name, balance: Math.abs(acc.balance), isAsset: false }))
  ];
  
  const chartLabels = allAccountsForChart.map(acc => acc.name);
  const chartData = allAccountsForChart.map(acc => acc.balance);
  const chartColors = allAccountsForChart.map(acc => 
    acc.isAsset ? themeColors.green : themeColors.red
  );
  
  let chartConfig = {
    type: currentNetWorthChartType,
    data: {
      labels: chartLabels,
      datasets: [{
        data: chartData,
        backgroundColor: chartColors,
        borderWidth: 2,
        borderColor: themeColors.cardBg
      }]
    },
    options: {
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            usePointStyle: true,
            padding: 20,
            color: themeColors.text,
            generateLabels: function(chart) {
              // ✅ Custom legend showing Assets and Liabilities categories
              return [
                {
                  text: `Assets (${formatCurrency(totalAssets)})`,
                  fillStyle: themeColors.green,
                  strokeStyle: themeColors.green,
                  fontColor: themeColors.text,
                  hidden: false,
                  index: 0
                },
                {
                  text: `Liabilities (${formatCurrency(totalLiabilities)})`,
                  fillStyle: themeColors.red,
                  strokeStyle: themeColors.red,
                  fontColor: themeColors.text,
                  hidden: false,
                  index: 1
                }
              ];
            }
          }
        },
        tooltip: {
          backgroundColor: themeColors.cardBg,
          titleColor: themeColors.text,
          bodyColor: themeColors.text,
          borderColor: themeColors.primary,
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              const isAsset = allAccountsForChart[context.dataIndex].isAsset;
              const total = isAsset ? totalAssets : totalLiabilities;
              const percentage = ((context.raw / total) * 100).toFixed(1);
              const accountType = isAsset ? 'Asset' : 'Liability';
              return [
                `${context.label}: ${formatCurrency(context.raw)}`,
                `${percentage}% of total ${accountType.toLowerCase()}s`
              ];
            }
          }
        }
      }
    }
  };

  if (currentNetWorthChartType === 'bar') {
    chartConfig.options.scales = {
      y: {
        beginAtZero: true,
        ticks: {
          color: themeColors.text,
          callback: function(value) {
            return formatCurrency(value);
          }
        },
        grid: {
          color: themeColors.textLight + '20'
        }
      },
      x: {
        ticks: {
          color: themeColors.text
        },
        grid: {
          color: themeColors.textLight + '20'
        }
      }
    };
    chartConfig.data.datasets[0].borderRadius = 4;
  }

  charts.netWorth = createSharpChart('netWorthChart', chartConfig);

 const accountBreakdownElement = document.getElementById('accountBreakdown');
  if (accountBreakdown.length === 0) {
    accountBreakdownElement.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🏦</div>
        <p>No account data available.</p>
      </div>
    `;
  } else {
    // ✅ Separate assets and liabilities
    const assets = accountBreakdown.filter(acc => acc.type === 'asset');
    const liabilities = accountBreakdown.filter(acc => acc.type === 'liability');
    
    // Sort by balance (highest first)
    assets.sort((a, b) => b.balance - a.balance);
    liabilities.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
    
    let html = '';
    
    // Assets section
    if (assets.length > 0) {
      html += `
        <div class="summary-header" style="margin-top: 0;">Assets</div>
        ${assets.map(account => `
          <div class="summary-item">
            <div class="summary-label">${account.name}</div>
            <div class="summary-value positive">
              ${formatCurrency(account.balance)}
            </div>
          </div>
        `).join('')}
      `;
    }
    
    // Liabilities section
    if (liabilities.length > 0) {
      html += `
        <div class="summary-header" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--ynab-border);">Liabilities</div>
        ${liabilities.map(account => `
          <div class="summary-item">
            <div class="summary-label">${account.name}</div>
            <div class="summary-value negative">
              ${formatCurrency(Math.abs(account.balance))}
            </div>
          </div>
        `).join('')}
      `;
    }
    
    // Total Net Worth at bottom
    html += `
      <div class="summary-item" style="border-top: 2px solid var(--ynab-border); margin-top: 12px; padding-top: 12px;">
        <div class="summary-label" style="font-weight: 700;">Total Net Worth</div>
        <div class="summary-value ${netWorth >= 0 ? 'positive' : 'negative'}" style="font-size: 18px; font-weight: 700;">
          ${formatCurrency(netWorth)}
        </div>
      </div>
    `;
    
    accountBreakdownElement.innerHTML = html;
  }
}

function loadTrendsReport() {
  const monthlySpending = getMonthlySpending();
  
  if (charts.trends) {
    charts.trends.destroy();
  }

  const amounts = monthlySpending.amounts;
  const avgMonthly = amounts.reduce((a, b) => a + b, 0) / amounts.length || 0;
  const highestMonth = Math.max(...amounts) || 0;
  const lowestMonth = Math.min(...amounts) || 0;
  
  const firstHalf = amounts.slice(0, Math.floor(amounts.length / 2));
  const secondHalf = amounts.slice(Math.floor(amounts.length / 2));
  const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
  const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;
  const trendDirection = secondAvg > firstAvg ? ' Increasing' : secondAvg < firstAvg ? ' Decreasing' : ' Stable';

  document.getElementById('avg-monthly').textContent = formatCurrency(avgMonthly);
  document.getElementById('highest-month').textContent = formatCurrency(highestMonth);
  document.getElementById('lowest-month').textContent = formatCurrency(lowestMonth);
  document.getElementById('trend-direction').textContent = trendDirection;

  const ctx = document.getElementById('trendsChart').getContext('2d');
  const themeColors = getThemeColors(); // ✅ Use theme colors
  
  let datasets = [{
    label: 'Monthly Spending',
    data: monthlySpending.amounts,
    borderColor: themeColors.primary,
    backgroundColor: currentTrendsChartType === 'area' ? (themeColors.primary + '33') : currentTrendsChartType === 'line' ? (themeColors.primary + '1a') : themeColors.primary,
    borderWidth: 3,
    fill: currentTrendsChartType === 'area',
    tension: 0.4,
    pointBackgroundColor: themeColors.primary,
    pointBorderColor: themeColors.cardBg,
    pointBorderWidth: 2,
    pointRadius: 6,
    pointHoverRadius: 8,
    borderRadius: 4
  }];

  if (showTrendline && amounts.length > 1) {
    const trendlineData = calculateTrendline(amounts);
    datasets.push({
      label: 'Trend',
      data: trendlineData,
      borderColor: themeColors.red,
      borderWidth: 2,
      borderDash: [5, 5],
      fill: false,
      pointRadius: 0,
      tension: 0
    });
  }

  const trendsConfig = {
    type: currentTrendsChartType === 'area' ? 'line' : currentTrendsChartType,
    data: {
      labels: monthlySpending.labels,
      datasets: datasets
    },
    options: {
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          display: showTrendline,
          position: 'top',
          labels: {
            color: themeColors.text,
            usePointStyle: true
          }
        },
        tooltip: {
          backgroundColor: themeColors.cardBg,
          titleColor: themeColors.text,
          bodyColor: themeColors.text,
          borderColor: themeColors.primary,
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              if (context.dataset.label === 'Trend') {
                return `Trend: ${formatCurrency(context.raw)}`;
              }
              return `Spending: ${formatCurrency(context.raw)}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          },
          ticks: {
            color: themeColors.text
          }
        },
        y: {
          beginAtZero: true,
          grid: {
            color: themeColors.textLight + '20'
          },
          ticks: {
            color: themeColors.text,
            callback: function(value) {
              return formatCurrency(value);
            }
          }
        }
      }
    }
  };
  charts.trends = createSharpChart('trendsChart', trendsConfig);
}

function calculateTrendline(data) {
  const n = data.length;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += data[i];
    sumXY += i * data[i];
    sumX2 += i * i;
  }
  
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  
  return data.map((_, i) => slope * i + intercept);
}

function getMonthlyIncomeExpense() {
  const { startDate, endDate } = getDateRange();
  const monthlyData = { labels: [], income: [], expenses: [] };

  if (!budgetData || !budgetData.months) {
    return monthlyData;
  }

  let current = new Date(startDate);
  while (current <= endDate) {
    const monthLabel = current.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    const monthKey = `${current.getFullYear()}-${String(current.getMonth() + 1).padStart(2, '0')}`;
    
    monthlyData.labels.push(monthLabel);

    const monthData = budgetData.months[monthKey];
    let monthIncome = 0;
    let monthExpenses = 0;

    if (monthData && monthData.transactions) {
      monthData.transactions.forEach(t => {
        // ✅ Exclude account deposits and withdrawals
        const isAccountTransaction = t.category === 'Deposit' || 
                                     t.category === 'Withdrawal' || 
                                     t.category === 'Transfer';
        
        if (!isAccountTransaction) {
          if (t.type === 'income') {
            monthIncome += t.amount;
          } else if (t.type === 'expense') {
            monthExpenses += t.amount;
          }
        }
      });
    }
    
    monthlyData.income.push(monthIncome);
    monthlyData.expenses.push(monthExpenses);

    current.setMonth(current.getMonth() + 1);
  }

  return monthlyData;
}

function getMonthlySpending() {
  const { startDate, endDate } = getDateRange();
  const monthlyData = {
    labels: [],
    amounts: []
  };

  const current = new Date(startDate);

  while (current <= endDate) {
    const monthLabel = current.toLocaleDateString('en-US', { 
      month: 'short', 
      year: '2-digit' 
    });
    monthlyData.labels.push(monthLabel);

    let monthTransactions = [];
    Object.values(budgetData.months || {}).forEach(monthData => {
      if (monthData.transactions) {
        monthTransactions = monthTransactions.concat(monthData.transactions.filter(t => {
          const tDate = new Date(t.date);
          // ✅ Exclude account transactions
          const isAccountTransaction = t.category === 'Deposit' || 
                                       t.category === 'Withdrawal' || 
                                       t.category === 'Transfer';
          
          return tDate.getFullYear() === current.getFullYear() &&
                 tDate.getMonth() === current.getMonth() &&
                 t.type === 'expense' &&
                 !isAccountTransaction;
        }));
      }
    });

    const monthSpending = monthTransactions.reduce((sum, t) => sum + t.amount, 0);
    monthlyData.amounts.push(monthSpending);

    current.setMonth(current.getMonth() + 1);
  }

  return monthlyData;
}

function applyFilters() {
  if (currentDateRange === 'custom') {
    const fromDate = document.getElementById('fromDate').value;
    const toDate = document.getElementById('toDate').value;
    
    if (!fromDate || !toDate) {
      showToast("Please select both start and end dates.", "error");
      return;
    }
    
    if (new Date(fromDate) > new Date(toDate)) {
      showToast("Start date must be before end date.", "error");
      return;
    }
  }

  updateActiveFilters();
  loadAllReports();
  showToast('Reports updated successfully', 'success');
}















  




   








// ===== ADVANCED CHART INTERACTIONS =====

let currentSpendingChartType = 'doughnut';
let currentIncomeExpenseChartType = 'bar';
let currentNetWorthChartType = 'doughnut';
let currentTrendsChartType = 'line';
let showTrendline = false;
let hiddenDatasets = new Set();

// Change spending chart type
function changeSpendingChartType(type) {
  currentSpendingChartType = type;
  
  // Update button states
  document.querySelectorAll('#report-spending .chart-type-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.type === type) btn.classList.add('active');
  });
  
  loadSpendingReport();
}

// Change income/expense chart type
function changeIncomeExpenseChartType(type) {
  currentIncomeExpenseChartType = type;
  
  document.querySelectorAll('#report-income-expense .chart-type-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.type === type) btn.classList.add('active');
  });
  
  loadIncomeExpenseReport();
}

// Change net worth chart type
function changeNetWorthChartType(type) {
  currentNetWorthChartType = type;
  
  document.querySelectorAll('#report-net-worth .chart-type-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.type === type) btn.classList.add('active');
  });
  
  loadNetWorthReport();
}

// Change trends chart type
function changeTrendsChartType(type) {
  currentTrendsChartType = type;
  
  document.querySelectorAll('#report-trends .chart-type-btn').forEach(btn => {
    btn.classList.remove('active');
    if (btn.dataset.type === type) btn.classList.add('active');
  });
  
  loadTrendsReport();
}

// Toggle trendline
function toggleTrendline() {
  showTrendline = !showTrendline;
  const btn = document.getElementById('showTrendlineBtn');
  btn.innerHTML = showTrendline 
    ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><polyline points="7 10 12 15 17 10"/></svg> Hide Trendline'
    : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2z"/><polyline points="7 10 12 15 17 10"/></svg> Show Trendline';
  btn.classList.toggle('active');
  loadTrendsReport();
}

// Toggle spending data table
function toggleSpendingTable() {
  const table = document.getElementById('spendingDataTable');
  table.classList.toggle('visible');
}

// Toggle income/expense data table
function toggleIncomeExpenseTable() {
  const wrap = document.getElementById('incomeExpenseDataTable');
  wrap.classList.toggle('visible');
  // Update button label
  const btn = document.querySelector('#report-income-expense .chart-control-btn[onclick="toggleIncomeExpenseTable()"]');
  if (btn) {
    const isVisible = wrap.classList.contains('visible');
    const labelEl = btn.querySelector('span:last-child') || btn;
    // find the text node
    btn.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        node.textContent = isVisible ? ' Hide Table' : ' Data Table';
      }
    });
  }
}

// Export menu toggle
function toggleExportMenu() {
  const dropdown = document.getElementById('exportDropdown');
  dropdown.classList.toggle('show');
}

// Close export menu when clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.export-menu')) {
    document.getElementById('exportDropdown')?.classList.remove('show');
  }
});

// Export to CSV
function exportToCSV() {
  const transactions = getFilteredTransactions();
  const { startDate, endDate } = getDateRange();
  
  const csvContent = [
    ['Date', 'Type', 'Category', 'Amount', 'Description'],
    ...transactions.map(t => [
      t.date,
      t.type,
      t.category || 'Uncategorized',
      t.amount,
      t.name || ''
    ])
  ].map(row => row.join(',')).join('\n');

  downloadFile(csvContent, `budget-report-${startDate.toISOString().slice(0, 10)}.csv`, 'text/csv');
  showToast('CSV exported successfully', 'success');
}

// Export chart to PNG
function exportToPNG() {
  const activeTab = document.querySelector('.report-tab.active').dataset.report;
  let chartId = '';
  
  switch(activeTab) {
    case 'spending': chartId = 'spendingChart'; break;
    case 'income-expense': chartId = 'incomeExpenseChart'; break;
    case 'net-worth': chartId = 'netWorthChart'; break;
    case 'trends': chartId = 'trendsChart'; break;
  }
  
  const canvas = document.getElementById(chartId);
  if (!canvas) return;
  
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeTab}-chart.png`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Chart exported as PNG', 'success');
  });
}

// Export to PDF (basic implementation)
function exportToPDF() {
  window.print();
  showToast('Print dialog opened for PDF export', 'success');
}

// Print report
function printReport() {
  window.print();
}

// Download file helper
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Update active filters display
function updateActiveFilters() {
  const container = document.getElementById('activeFilters');
  const dateRange = document.getElementById('dateRange').value;
  
  container.innerHTML = '';
  
  const chip = document.createElement('div');
  chip.className = 'filter-chip';
  chip.innerHTML = `
     ${dateRange.replace('-', ' ').replace(/\b\w/g, l => l.toUpperCase())}
    <span class="remove" onclick="clearFilters()">×</span>
  `;
  container.appendChild(chip);
}

function clearFilters() {
  document.getElementById('dateRange').value = 'current-month';
  currentDateRange = 'current-month';
  
  // Hide custom date range fields if visible
  document.querySelectorAll('[id^="customDateRange"]').forEach(el => {
    el.style.display = 'none';
  });
  
  updateActiveFilters();
  loadAllReports();
  showToast('Filters reset to current month', 'success');
}

// Interactive legend for spending chart
function createInteractiveLegend(categories, amounts, colors) {
  const legend = document.getElementById('spendingLegend');
  legend.innerHTML = '';
  
  const total = amounts.reduce((a, b) => a + b, 0);
  
  categories.forEach((cat, index) => {
    const percentage = ((amounts[index] / total) * 100).toFixed(1);
    
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.dataset.index = index;
    item.innerHTML = `
      <div class="legend-color" style="background-color: ${colors[index]}"></div>
      <div class="legend-label">${cat}</div>
      <div class="legend-value">${percentage}%</div>
    `;
    
    item.addEventListener('click', () => {
      toggleDataset(index);
    });
    
    legend.appendChild(item);
  });
}

function toggleDataset(index) {
  if (!charts.spending) return;
  
  const meta = charts.spending.getDatasetMeta(0);
  const hidden = meta.data[index].hidden;
  
  meta.data[index].hidden = !hidden;
  charts.spending.update();
  
  const legendItem = document.querySelector(`.legend-item[data-index="${index}"]`);
  legendItem.classList.toggle('hidden');
}

// Load comparison report
async function loadComparisonReport() {
  const period1 = document.getElementById('comparePeriod1').value;
  const period2 = document.getElementById('comparePeriod2').value;
  
  // Get data for both periods
  const data1 = await getComparisonData(period1);
  const data2 = await getComparisonData(period2);
  
  if (charts.comparison) {
    charts.comparison.destroy();
  }
  
  const ctx = document.getElementById('comparisonChart').getContext('2d');
  const themeColors = getThemeColors();
  charts.comparison = createSharpChart('comparisonChart', {
    type: 'bar',
    data: {
      labels: ['Income', 'Expenses', 'Net Income', 'Savings Rate'],
      datasets: [{
        label: formatPeriodLabel(period1),
        data: [data1.income, data1.expenses, data1.net, data1.savingsRate],
        backgroundColor: themeColors.green,
        borderRadius: 4
      }, {
        label: formatPeriodLabel(period2),
        data: [data2.income, data2.expenses, data2.net, data2.savingsRate],
        backgroundColor: themeColors.red,
        borderRadius: 4
      }]
    },
    options: {
      plugins: {
        legend: {
          position: 'top',
          labels: {
            usePointStyle: true,
            padding: 20,
            color: themeColors.text
          }
        },
        tooltip: {
          backgroundColor: themeColors.cardBg,
          titleColor: themeColors.text,
          bodyColor: themeColors.text,
          borderColor: themeColors.primary,
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              if (context.label === 'Savings Rate') {
                return `${context.dataset.label}: ${context.raw}%`;
              }
              return `${context.dataset.label}: ${formatCurrency(context.raw)}`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: themeColors.text,
            callback: function(value, index, values) {
              const labels = this.chart.data.labels;
              if (labels[index] === 'Savings Rate') {
                return value + '%';
              }
              return formatCurrency(value);
            }
          },
          grid: {
            color: themeColors.textLight + '20'
          }
        },
        x: {
          ticks: { color: themeColors.text },
          grid: { color: themeColors.textLight + '20' }
        }
      }
    }
  });
  
  showToast('Comparison loaded successfully', 'success');
}

async function getComparisonData(period) {
  if (!budgetData || !budgetData.months) {
    return { income: 0, expenses: 0, net: 0, savingsRate: 0 };
  }

  const dateRange = getDateRangeForPeriod(period);
  const { startDate, endDate } = dateRange;
  
  let totalIncome = 0;
  let totalExpenses = 0;

  // Iterate through all months in the specified period
  Object.entries(budgetData.months).forEach(([monthKey, monthData]) => {
    const monthDate = new Date(monthKey + '-01');
    
    if (monthDate >= startDate && monthDate <= endDate) {
      if (monthData.transactions && Array.isArray(monthData.transactions)) {
        monthData.transactions.forEach(transaction => {
          if (transaction.type === 'income') {
            totalIncome += transaction.amount;
          } else if (transaction.type === 'expense') {
            totalExpenses += transaction.amount;
          }
        });
      }
    }
  });

  const net = totalIncome - totalExpenses;
  const savingsRate = totalIncome > 0 ? ((net / totalIncome) * 100).toFixed(1) : 0;
  
  return {
    income: totalIncome,
    expenses: totalExpenses,
    net: net,
    savingsRate: parseFloat(savingsRate)
  };
}

function getDateRangeForPeriod(period) {
  const now = new Date();
  let startDate, endDate;

  switch(period) {
    case 'current-month':
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'last-month':
      startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      endDate = new Date(now.getFullYear(), now.getMonth(), 0);
      break;
    case 'last-3-months':
      startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'last-6-months':
      startDate = new Date(now.getFullYear(), now.getMonth() - 6, 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      break;
    case 'current-year':
      startDate = new Date(now.getFullYear(), 0, 1);
      endDate = new Date(now.getFullYear(), 11, 31);
      break;
    case 'last-year':
      startDate = new Date(now.getFullYear() - 1, 0, 1);
      endDate = new Date(now.getFullYear() - 1, 11, 31);
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }

  return { startDate, endDate };
}

function formatPeriodLabel(period) {
  const labels = {
    'current-month': 'Current Month',
    'last-month': 'Last Month',
    'last-3-months': 'Last 3 Months',
    'last-6-months': 'Last 6 Months',
    'current-year': 'Current Year',
    'last-year': 'Last Year'
  };
  return labels[period] || period;
}

// Initialize comparison chart variable
charts.comparison = null;

// Update the date range change listener
document.getElementById('dateRange').addEventListener('change', function() {
  updateActiveFilters();
  const customRangeElements = document.querySelectorAll('[id^="customDateRange"]');
  if (this.value === 'custom') {
    customRangeElements.forEach(el => el.style.display = 'block');
  } else {
    customRangeElements.forEach(el => el.style.display = 'none');
  }
  currentDateRange = this.value;
});

// Print styles for reports
const printStyles = `
  @media print {
    body * {
      visibility: hidden;
    }
    #reports, #reports * {
      visibility: visible;
    }
    #reports {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
    }
    .sidebar, .report-nav, .filter-panel, .report-controls, .btn, button {
      display: none !important;
    }
    .chart-container {
      page-break-inside: avoid;
    }
    .metric-cards {
      page-break-inside: avoid;
    }
  }
`;

// Add print styles to document
const styleSheet = document.createElement('style');
styleSheet.textContent = printStyles;
document.head.appendChild(styleSheet);

// Enhanced tooltip with animations
function createCustomTooltip(chart, tooltipModel) {
  let tooltipEl = document.getElementById('chartjs-tooltip');

  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'chartjs-tooltip';
    tooltipEl.className = 'chart-tooltip';
    document.body.appendChild(tooltipEl);
  }

  if (tooltipModel.opacity === 0) {
    tooltipEl.style.opacity = 0;
    return;
  }

  if (tooltipModel.body) {
    const titleLines = tooltipModel.title || [];
    const bodyLines = tooltipModel.body.map(b => b.lines);

    let innerHtml = '<div>';

    titleLines.forEach(title => {
      innerHtml += '<div style="font-weight: bold; margin-bottom: 8px;">' + title + '</div>';
    });

    bodyLines.forEach((body, i) => {
      const colors = tooltipModel.labelColors[i];
      const style = 'background:' + colors.backgroundColor;
      const span = '<span style="display: inline-block; width: 12px; height: 12px; margin-right: 8px; border-radius: 2px; ' + style + '"></span>';
      innerHtml += '<div>' + span + body + '</div>';
    });

    innerHtml += '</div>';
    tooltipEl.innerHTML = innerHtml;
  }

  const position = chart.canvas.getBoundingClientRect();
  tooltipEl.style.opacity = 1;
  tooltipEl.style.position = 'absolute';
  tooltipEl.style.left = position.left + window.pageXOffset + tooltipModel.caretX + 'px';
  tooltipEl.style.top = position.top + window.pageYOffset + tooltipModel.caretY + 'px';
  tooltipEl.style.pointerEvents = 'none';
  tooltipEl.style.transition = 'all 0.2s ease';
}

// Chart animation configurations
Chart.defaults.animation = {
  duration: 1000,
  easing: 'easeInOutQuart'
};

Chart.defaults.animations = {
  tension: {
    duration: 1000,
    easing: 'linear',
    from: 1,
    to: 0,
    loop: false
  }
};

// Add hover effects to metric cards
document.addEventListener('DOMContentLoaded', function() {
  const metricCards = document.querySelectorAll('.metric-card');
  metricCards.forEach(card => {
    card.addEventListener('mouseenter', function() {
      this.style.transform = 'translateY(-4px)';
      this.style.boxShadow = '0 8px 24px rgba(0,0,0,0.15)';
    });
    card.addEventListener('mouseleave', function() {
      this.style.transform = 'translateY(0)';
      this.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)';
    });
  });
});

// Keyboard shortcuts for reports
document.addEventListener('keydown', function(e) {
  // Only activate if reports section is visible
  const reportsSection = document.getElementById('reports');
  if (reportsSection.style.display === 'none') return;

  // Ctrl/Cmd + E for Export
  if ((e.ctrlKey || e.metaKey) && e.key === 'e') {
    e.preventDefault();
    toggleExportMenu();
  }

  // Ctrl/Cmd + P for Print
  if ((e.ctrlKey || e.metaKey) && e.key === 'p') {
    e.preventDefault();
    printReport();
  }

  // Number keys 1-5 for switching report tabs
  if (e.key >= '1' && e.key <= '5') {
    const tabs = document.querySelectorAll('.report-tab');
    const index = parseInt(e.key) - 1;
    if (tabs[index]) {
      tabs[index].click();
    }
  }
});

// Add loading animation when generating reports
function showReportLoading(reportId) {
  const reportContent = document.getElementById(`report-${reportId}`);
  if (!reportContent) return;

  const loadingHtml = `
    <div class="chart-skeleton" style="margin: 20px 0;"></div>
    <div class="chart-skeleton" style="margin: 20px 0; height: 150px;"></div>
  `;
  
  const originalContent = reportContent.innerHTML;
  reportContent.innerHTML = loadingHtml;

  // Return function to restore content
  return function hideLoading() {
    reportContent.innerHTML = originalContent;
  };
}

// Enhanced data export with formatting
function exportDetailedCSV() {
  const activeTab = document.querySelector('.report-tab.active').dataset.report;
  const { startDate, endDate } = getDateRange();
  
  let csvContent = '';
  let filename = '';

  switch(activeTab) {
    case 'spending':
      csvContent = generateSpendingCSV();
      filename = `spending-report-${startDate.toISOString().slice(0, 10)}.csv`;
      break;
    case 'income-expense':
      csvContent = generateIncomeExpenseCSV();
      filename = `income-expense-report-${startDate.toISOString().slice(0, 10)}.csv`;
      break;
    case 'net-worth':
      csvContent = generateNetWorthCSV();
      filename = `net-worth-report-${startDate.toISOString().slice(0, 10)}.csv`;
      break;
    case 'trends':
      csvContent = generateTrendsCSV();
      filename = `trends-report-${startDate.toISOString().slice(0, 10)}.csv`;
      break;
  }

  downloadFile(csvContent, filename, 'text/csv');
  showToast('Detailed CSV exported successfully', 'success');
}

function generateSpendingCSV() {
  const transactions = getFilteredTransactions().filter(t => t.type === 'expense');
  
  const header = ['Date', 'Category', 'Description', 'Amount'];
  const rows = transactions.map(t => [
    t.date,
    t.category || 'Uncategorized',
    t.name || '',
    t.amount
  ]);

  return [header, ...rows].map(row => row.join(',')).join('\n');
}

function generateIncomeExpenseCSV() {
  const monthlyData = getMonthlyIncomeExpense();
  
  const header = ['Month', 'Income', 'Expenses', 'Net', 'Savings Rate'];
  const rows = monthlyData.labels.map((label, index) => {
    const income = monthlyData.income[index];
    const expenses = monthlyData.expenses[index];
    const net = income - expenses;
    const savingsRate = income > 0 ? ((net / income) * 100).toFixed(1) : 0;
    
    return [label, income, expenses, net, savingsRate + '%'];
  });

  return [header, ...rows].map(row => row.join(',')).join('\n');
}

function generateNetWorthCSV() {
  const accounts = budgetData.accounts || [];
  
  const header = ['Account Name', 'Type', 'Balance'];
  const rows = accounts.map(acc => [
    acc.name,
    acc.type || 'Unknown',
    acc.balance
  ]);

  return [header, ...rows].map(row => row.join(',')).join('\n');
}

function generateTrendsCSV() {
  const monthlySpending = getMonthlySpending();
  
  const header = ['Month', 'Spending'];
  const rows = monthlySpending.labels.map((label, index) => [
    label,
    monthlySpending.amounts[index]
  ]);

  return [header, ...rows].map(row => row.join(',')).join('\n');
}

// Responsive chart resizing
let resizeTimeout;
window.addEventListener('resize', function() {
  clearTimeout(resizeTimeout);
  resizeTimeout = setTimeout(() => {
    Object.values(charts).forEach(chart => {
      if (chart && typeof chart.resize === 'function') {
        chart.resize();
      }
    });
  }, 250);
});

// Auto-refresh reports every 5 minutes (optional)
let autoRefreshInterval;
function enableAutoRefresh(enabled = true) {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }

  if (enabled) {
    autoRefreshInterval = setInterval(() => {
      const reportsSection = document.getElementById('reports');
      if (reportsSection.style.display !== 'none') {
        console.log('Auto-refreshing reports...');
        loadAllReports();
      }
    }, 5 * 60 * 1000); // 5 minutes
  }
}

// Initialize auto-refresh (disabled by default)
// enableAutoRefresh(false);

// Add smooth scroll to report sections
function scrollToReport(reportId) {
  const reportElement = document.getElementById(`report-${reportId}`);
  if (reportElement) {
    reportElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

// Accessibility improvements
document.querySelectorAll('.report-tab').forEach(tab => {
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', tab.classList.contains('active'));
  
  tab.addEventListener('click', function() {
    document.querySelectorAll('.report-tab').forEach(t => {
      t.setAttribute('aria-selected', 'false');
    });
    this.setAttribute('aria-selected', 'true');
  });
});

// Mobile touch improvements for charts
if ('ontouchstart' in window) {
  Chart.defaults.interaction.mode = 'nearest';
  Chart.defaults.interaction.intersect = true;
}































// ===== GOALS Section =====
// Authentication state listener
        auth.onAuthStateChanged(async (user) => {
            if (!user) {
                window.location.href = "auth.html";
                return;
            }
            
            currentUser = user;
            try {
                const userDoc = await db.collection("users").doc(user.uid).get();
                const userData = userDoc.data();
                
                if (userDoc.exists && userData?.approved === true) {
                    await loadGoals();
                } else {
                    showToast("Your account is pending approval. Please contact the admin.", "error");
                    await auth.signOut();
                }
            } catch (err) {
                console.error("Error fetching user:", err);
            }
        });

// Load goals from Firebase with transactions merged
async function loadGoals() {
    if (!currentUser) return;

    try {
        // Load all goals
        const goalsRef = db.collection("budget").doc(currentUser.uid).collection("goals");
        const goalsSnap = await goalsRef.orderBy("createdAt", "desc").get();
        
        // Load all goal transactions
        const txRef = db.collection("budget").doc(currentUser.uid).collection("goalTransactions");
        const txSnap = await txRef.get();

        // Group transactions by goalId
        const txMap = {};
        txSnap.forEach(doc => {
            const tx = doc.data();
            if (!txMap[tx.goalId]) txMap[tx.goalId] = 0;
            if (tx.type === "contribution") {
                txMap[tx.goalId] += tx.amount;
            } else if (tx.type === "withdrawal") {
                txMap[tx.goalId] -= tx.amount;
            }
        });

        // Build goal list
        goals = [];
        goalsSnap.forEach(doc => {
            const goalData = doc.data();
            const goalId = doc.id;
            const currentAmount = txMap[goalId] || 0;

            goals.push({
                id: goalId,
                ...goalData,
                currentAmount // override if missing
            });
        });

        renderGoals();
    } catch (error) {
        console.error("Error loading goals:", error);
        showToast("Error loading goals", "error");
    }
}


        // Render goals
       // Render goals
function renderGoals() {
    const goalsGrid = document.getElementById("goals-grid");
    const emptyState = document.getElementById("empty-state");

    if (goals.length === 0) {
        goalsGrid.style.display = "none";
        emptyState.style.display = "block";
        return;
    }

    goalsGrid.style.display = "grid";
    emptyState.style.display = "none";
    
    //console.log("🎯 Rendering goals with currency:", userCurrency); // Add this debug line
    
    goalsGrid.innerHTML = goals.map(goal => createGoalCard(goal)).join("");
}
        // Create goal card HTML
function createGoalCard(goal) {
    const progress = Math.min((goal.currentAmount / goal.targetAmount) * 100, 100);
    const isCompleted = goal.currentAmount >= goal.targetAmount;
    const daysRemaining = goal.targetDate ? Math.ceil((new Date(goal.targetDate) - new Date()) / (1000 * 60 * 60 * 24)) : null;
    
    let statusClass = "status-active";
    let statusText = "Active";
    
    if (isCompleted) {
        statusClass = "status-completed";
        statusText = "Completed";
    } else if (goal.status === "paused") {
        statusClass = "status-paused";
        statusText = "Paused";
    }
    
    return `
        <div class="goal-card">
            <div class="goal-header">
                <div>
                    <div class="goal-title">${goal.name}</div>
                    <div class="goal-type">${goal.type}</div>
                </div>
                <div class="goal-actions">
                    <button class="action-btn" onclick="editGoal('${goal.id}')" title="Edit">
                        EDIT
                    </button>
                    <button class="action-btn" onclick="deleteGoal('${goal.id}')" title="Delete">
                        DELETE
                    </button>
                </div>
            </div>

            <div class="progress-section">
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${progress}%"></div>
                    <div class="progress-label" style="left: ${progress}%;">${progress.toFixed(1)}%</div>
                </div>
                <div class="progress-text">
                    <span>${progress.toFixed(1)}% complete</span>
                    <span class="goal-status ${statusClass}">${statusText}</span>
                </div>
            </div>

            <div class="goal-amounts">
                <div class="amount-item">
                    <div class="amount-label">Current</div>
                    <div class="amount-value">${formatCurrency(goal.currentAmount)}</div>
                </div>
                <div class="amount-item">
                    <div class="amount-label">Target</div>
                    <div class="amount-value">${formatCurrency(goal.targetAmount)}</div>
                </div>
            </div>

            <div class="goal-details">
                ${goal.description ? `<p>${goal.description}</p>` : ""}
                ${goal.targetDate ? `<p><strong>Target:</strong> ${formatDate(goal.targetDate)}</p>` : ""}
                ${daysRemaining !== null ? `<p><strong>Days remaining:</strong> ${daysRemaining > 0 ? daysRemaining : 'Past due'}</p>` : ""}
                ${goal.monthlyContribution ? `<p><strong>Monthly:</strong> ${formatCurrency(goal.monthlyContribution)}</p>` : ""}
            </div>

            ${!isCompleted ? `
                <div class="add-funds-section">
                    <input type="number" class="funds-input" id="funds-${goal.id}" placeholder="Add amount" min="0" step="0.01">
                    <button class="add-funds-btn" onclick="addFunds('${goal.id}')">Add Funds</button>
                </div>
            ` : ""}
        </div>
    `;
}
        // Add funds to goal
        async function addFunds(goalId) {
            const input = document.getElementById(`funds-${goalId}`);
            const amount = parseFloat(input.value);

            if (isNaN(amount) || amount <= 0) {
                showToast("Please enter a valid amount", "error");
                return;
            }

            try {
                const goalRef = db.collection("budget").doc(currentUser.uid).collection("goals").doc(goalId);
                const goalDoc = await goalRef.get();
                
                if (!goalDoc.exists) {
                    showToast("Goal not found", "error");
                    return;
                }

                const goalData = goalDoc.data();
                const newAmount = goalData.currentAmount + amount;

                await goalRef.update({
                    currentAmount: newAmount,
                    lastContribution: {
                        amount: amount,
                        date: new Date().toISOString()
                    },
                    updatedAt: new Date().toISOString()
                });

                // Add transaction record
                await addGoalTransaction(goalId, amount, 'contribution');

                input.value = "";
                await loadGoals();
                
                const goal = goals.find(g => g.id === goalId);
                if (newAmount >= goal.targetAmount) {
                    showToast(`Congratulations! You've reached your "${goal.name}" goal!`, "success");
                } else {
                    showToast("Funds added successfully!", "success");
                }
            } catch (error) {
                console.error("Error adding funds:", error);
                showToast("Error adding funds", "error");
            }
        }

        // Add goal transaction
        async function addGoalTransaction(goalId, amount, type) {
            try {
                const transactionRef = db.collection("budget").doc(currentUser.uid).collection("goalTransactions");
                await transactionRef.add({
                    goalId: goalId,
                    amount: amount,
                    type: type, // 'contribution' or 'withdrawal'
                    date: new Date().toISOString(),
                    createdAt: new Date().toISOString()
                });
            } catch (error) {
                console.error("Error adding goal transaction:", error);
            }
        }

        // Open add goal modal
        function openAddGoalModal() {
            editingGoalId = null;
            document.getElementById("modal-title").textContent = "Add New Goal";
            document.getElementById("goal-form").reset();
            document.getElementById("goal-modal").classList.remove("hidden");
        }

        // Close goal modal
        function closeGoalModal() {
            document.getElementById("goal-modal").classList.add("hidden");
        }

        // Edit goal
        async function editGoal(goalId) {
            const goal = goals.find(g => g.id === goalId);
            if (!goal) return;

            editingGoalId = goalId;
            document.getElementById("modal-title").textContent = "Edit Goal";
            
            document.getElementById("goal-name").value = goal.name;
            document.getElementById("goal-type").value = goal.type;
            document.getElementById("target-amount").value = goal.targetAmount;
            document.getElementById("target-date").value = goal.targetDate || "";
            document.getElementById("monthly-contribution").value = goal.monthlyContribution || "";
            document.getElementById("goal-description").value = goal.description || "";
            
            document.getElementById("goal-modal").classList.remove("hidden");
        }

        // Delete goal
        async function deleteGoal(goalId) {
            const goal = goals.find(g => g.id === goalId);
            if (!goal) return;

            const _okDelGoal = await showConfirm(
              `Delete goal <strong>${goal.name}</strong>? This action cannot be undone.`,
              { confirmText: "Delete", cancelText: "Cancel", type: "danger" }
            );
            if (!_okDelGoal) {
                return;
            }

            try {
                await db.collection("budget").doc(currentUser.uid).collection("goals").doc(goalId).delete();
                
                // Delete related transactions
                const transactionsRef = db.collection("budget").doc(currentUser.uid).collection("goalTransactions");
                const transactionsSnapshot = await transactionsRef.where("goalId", "==", goalId).get();
                
                const batch = db.batch();
                transactionsSnapshot.forEach(doc => {
                    batch.delete(doc.ref);
                });
                await batch.commit();

                await loadGoals();
                showToast("Goal deleted successfully", "success");
            } catch (error) {
                console.error("Error deleting goal:", error);
                showToast("Error deleting goal", "error");
            }
        }

        // Handle goal form submission
        document.getElementById("goal-form").addEventListener("submit", async (e) => {
            e.preventDefault();

            const name = document.getElementById("goal-name").value.trim();
            const type = document.getElementById("goal-type").value;
            const targetAmount = parseFloat(document.getElementById("target-amount").value);
            const targetDate = document.getElementById("target-date").value || null;
            const monthlyContribution = parseFloat(document.getElementById("monthly-contribution").value) || null;
            const description = document.getElementById("goal-description").value.trim() || null;

            if (!name || !type || isNaN(targetAmount) || targetAmount <= 0) {
                showToast("Please fill in all required fields", "error");
                return;
            }

            const goalData = {
                name,
                type,
                targetAmount,
                targetDate,
                monthlyContribution,
                description,
                currentAmount: 0,
                status: "active",
                updatedAt: new Date().toISOString()
            };

            try {
                if (editingGoalId) {
                    // Update existing goal
                    await db.collection("budget").doc(currentUser.uid).collection("goals").doc(editingGoalId).update(goalData);
                    showToast("Goal updated successfully", "success");
                } else {
                    // Create new goal
                    goalData.createdAt = new Date().toISOString();
                    await db.collection("budget").doc(currentUser.uid).collection("goals").add(goalData);
                    showToast("Goal created successfully", "success");
                }

                closeGoalModal();
                await loadGoals();
            } catch (error) {
                console.error("Error saving goal:", error);
                showToast("Error saving goal", "error");
            }
        });

        // Utility functions
        function formatNumber(num) {
            return new Intl.NumberFormat('en-PH', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            }).format(num);
        }

        function formatDate(dateString) {
            return new Date(dateString).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            });
        }

        function showToast(message, type = "success") {
            const toast = document.createElement("div");
            toast.className = `toast ${type}`;
            toast.textContent = message;
            
            document.body.appendChild(toast);
            
            setTimeout(() => toast.classList.add("show"), 100);
            
            setTimeout(() => {
                toast.classList.remove("show");
                setTimeout(() => toast.remove(), 300);
            }, 3000);
        }

        // Close modal when clicking outside
        document.addEventListener("click", (e) => {
            if (e.target.classList.contains("modal")) {
                closeGoalModal();
            }
        });

        // Close modal with Escape key
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                closeGoalModal();
            }
        });

// ===== Settings Section =====

 // Theme Management System
    class ThemeManager {
      constructor() {
        this.currentTheme = 'classic';
        this.themeToggle = document.getElementById('themeToggle');
        this.themeDropdown = document.getElementById('themeDropdown');
        this.currentThemeName = document.getElementById('currentThemeName');
        this.themeDisplay = document.getElementById('themeDisplay');
        
        this.init();
      }

      init() {
        // Apply localStorage theme instantly (no lag on return visits)
        // On a new browser localStorage is empty → defaults to classic until
        // loadThemeFromFirestore() is called from the auth listener after login
        const localTheme = localStorage.getItem('budgetmaster-theme') || 'classic';
        this.setTheme(localTheme);

        // NOTE: loadThemeFromFirestore() is called from the auth listener
        // (after currentUser is set) — NOT here, because currentUser is null
        // at this point and the Firestore read would silently fail.

        // Event listeners
        this.themeToggle.addEventListener('click', (e) => {
          e.stopPropagation();
          this.toggleDropdown();
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
          if (!this.themeToggle.contains(e.target) && !this.themeDropdown.contains(e.target)) {
            this.closeDropdown();
          }
        });

        // Theme option clicks
        this.themeDropdown.querySelectorAll('.theme-option, .theme-card').forEach(option => {
          option.addEventListener('click', (e) => {
            const theme = e.currentTarget.dataset.theme;
            this.setTheme(theme);
            this.closeDropdown();
          });
        });

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') {
            this.closeDropdown();
          }
        });
      }

      toggleDropdown() {
        this.themeDropdown.classList.toggle('open');
      }

      closeDropdown() {
        this.themeDropdown.classList.remove('open');
      }

      // save=true  → user picked a theme manually → write to localStorage + Firestore
      // save=false → loading from Firestore → only write to localStorage (avoid loop)
      setTheme(theme, save = true) {
        // Remove current theme
        document.documentElement.removeAttribute('data-theme');

        // Set new theme
        if (theme !== 'classic') {
          document.documentElement.setAttribute('data-theme', theme);
        }

        this.currentTheme = theme;

        // Update UI
        this.updateThemeDisplay();
        this.updateActiveOption();

        // Always update localStorage so next visit is instant
        localStorage.setItem('budgetmaster-theme', theme);

        // Only write to Firestore when user manually picked the theme
        if (save) {
          this.saveThemeToFirestore(theme);
        }

        // Emit theme change event for other parts of the app
        window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme } }));
      }

      // A4: Load theme from Firestore and apply it.
      // Always applies the Firestore value — even if localStorage already has it —
      // so a new browser (empty localStorage) always gets the correct theme.
      async loadThemeFromFirestore() {
        if (!currentUser) return;
        try {
          const snap = await db.collection("users").doc(currentUser.uid).get();
          if (!snap.exists) return;
          const savedTheme = snap.data().theme;
          if (savedTheme) {
            localStorage.setItem('budgetmaster-theme', savedTheme);
            this.setTheme(savedTheme, false); // false = don't re-save to Firestore
          }
        } catch (err) {
          console.warn("[A4] Could not load theme from Firestore:", err);
          // Graceful fallback — localStorage / default theme already applied
        }
      }

      // A4: Save theme to Firestore (fire-and-forget)
      saveThemeToFirestore(theme) {
        if (!currentUser) return;
        db.collection("users").doc(currentUser.uid)
          .update({ theme })
          .catch(err => console.warn("[A4] Failed to save theme to Firestore:", err));
      }

      updateThemeDisplay() {
 const themeNames = {
  'classic': 'Classic Blue',
  'dark': 'Soft Sunrise',
  'sage-garden': 'Crimson Dust',
  'warm-latte': 'Aqua Mist',
  'soft-blush': 'Forest Parchment',
  'ocean-steel': 'Citrus Breeze',
  'sunset-vibes': 'Lavender Fog',
  'pastel-dream': 'Midnight Red',
  'steel-blue': 'Deep Emerald',
  'royal-ember': 'Royal Ember'
};

  const displayName = themeNames[this.currentTheme] || 'Classic Blue';
  this.currentThemeName.textContent = displayName;
  
  // ✅ Also update the dashboard display
  const themeDisplayElement = document.getElementById('themeDisplay');
  if (themeDisplayElement) {
    themeDisplayElement.textContent = displayName;
  }
}

      updateActiveOption() {
        this.themeDropdown.querySelectorAll('.theme-option, .theme-card').forEach(option => {
          option.classList.remove('active');
          if (option.dataset.theme === this.currentTheme) {
            option.classList.add('active');
          }
        });
      }

      getCurrentTheme() {
        return this.currentTheme;
      }

      // Method to get theme colors for charts/dynamic content
      getThemeColors() {
        const computedStyle = getComputedStyle(document.documentElement);
        return {
          primary: computedStyle.getPropertyValue('--primary').trim(),
          secondary: computedStyle.getPropertyValue('--secondary').trim(),
          text: computedStyle.getPropertyValue('--text').trim(),
          textLight: computedStyle.getPropertyValue('--text-light').trim(),
          green: computedStyle.getPropertyValue('--ynab-green').trim(),
          red: computedStyle.getPropertyValue('--ynab-red').trim(),
          orange: computedStyle.getPropertyValue('--ynab-orange').trim(),
          bg: computedStyle.getPropertyValue('--bg').trim(),
          cardBg: computedStyle.getPropertyValue('--card-bg').trim(),
        };
      }
    }

    // Initialize theme manager
    const themeManager = new ThemeManager();
    window.themeManager = themeManager; // A4: expose so auth listener can call loadThemeFromFirestore()

    // Make theme manager globally available
    window.ThemeManager = themeManager;

    // Example of listening to theme changes (for updating charts, etc.)
    // ✅ Reload charts when theme changes
    window.addEventListener('themeChanged', (e) => {
      //console.log('Theme changed to:', e.detail.theme);
      
      // Reload all reports with new theme colors
      const reportsSection = document.getElementById('reports');
      if (reportsSection && reportsSection.style.display !== 'none') {
        setTimeout(() => {
          loadAllReports();
        }, 100);
      }
    });

    // Demo: Log theme colors when theme changes
    window.addEventListener('themeChanged', () => {
      setTimeout(() => {
        //console.log('Current theme colors:', themeManager.getThemeColors());
      }, 100); // Small delay to ensure CSS has updated
    });

// ===== Profile Section Loader =====
async function loadProfileSection() {
  if (!currentUser) return;
  try {
    const doc = await firebase.firestore().collection("users").doc(currentUser.uid).get();
    if (doc.exists) {
      const data = doc.data();

      // Name
      const nameEl = document.getElementById("displayName");
      if (nameEl) nameEl.value = data.displayName || currentUser.displayName || "";

      // Email
      const emailEl = document.getElementById("email");
      if (emailEl) emailEl.value = currentUser.email || "";

      // Email verified badge
      const verifiedEl = document.getElementById("emailVerifiedStatus") ||
                         document.querySelector(".email-verified-status") ||
                         document.querySelector("[id*='verified']");
      if (verifiedEl) {
        verifiedEl.textContent = currentUser.emailVerified ? "✅ Verified" : "⚠️ Not Verified";
        verifiedEl.style.color  = currentUser.emailVerified ? "#16a085" : "#e74c3c";
      }

      // Currency dropdown
      const currencyEl = document.getElementById("currency");
      if (currencyEl) {
        const savedCurrency = data.currency || "USD";
        currencyEl.value = savedCurrency;
        // Also sync the global so dashboard reflects it immediately
        userCurrency = savedCurrency;
        window.userCurrency = savedCurrency;
      }
    }
  } catch (err) {
    console.error("Error loading profile section:", err);
  }
}

// ===== Load user settings on login =====
// Update the existing Firebase auth listener to load rollover settings
// ===== Load Settings When Settings Section is Opened =====
document.querySelectorAll('.settings-sidebar li').forEach(item => {
  item.addEventListener('click', async () => {
    document.querySelectorAll('.settings-sidebar li').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    const sectionToShow = item.getAttribute('data-section');
    document.querySelectorAll('.settings-section').forEach(sec => {
      sec.style.display = sec.id === sectionToShow ? 'block' : 'none';
    });
    
    // ✅ Load user settings when opening settings section
    if (sectionToShow === 'profileSection' && currentUser) {
      await loadProfileSection();
    }
    
    // ✅ Load recurring rules when opening recurring section
    if (sectionToShow === 'recurringSection' && currentUser && typeof Recurring !== "undefined") {
      await Recurring.renderRulesList();
    }

    // ✅ Load rollover settings when opening rollover section
    if (sectionToShow === 'rolloverSection' && currentUser) {
      const doc = await firebase.firestore().collection("users").doc(currentUser.uid).get();
      if (doc.exists && doc.data().rolloverSettings) {
        const settings = doc.data().rolloverSettings;
        document.getElementById("rolloverMode").value = settings.mode || "manual";
        if (settings.automaticDay) {
          document.getElementById("automaticRolloverDay").value = settings.automaticDay;
        }
        lastRolloverDate = settings.lastRollover || null;
        toggleRolloverSettings();
        
        if (settings.mode === "automatic" && settings.automaticDay) {
          setupAutomaticRollover(settings.automaticDay);
        }
      }
    }
  });
});


// Updated Save Settings button to exclude startDay
document.getElementById("saveBtn").addEventListener("click", async () => {
  const displayName = document.getElementById("displayName").value.trim();
  const currency = document.getElementById("currency").value;

  try {
    // Save to Firestore
    await firebase.firestore().collection("users").doc(currentUser.uid).set({
      displayName, 
      currency
    }, { merge: true });

    // Update Firebase Auth profile name
    await currentUser.updateProfile({ displayName });

    // ✅ Update global currency variable immediately
    userCurrency = currency;
    window.userCurrency = userCurrency; // keep in sync with currency.js
    console.log("💰 Currency updated to:", userCurrency);
    
    // ✅ Reload all data with new currency format
    await loadBudget();
    await loadAccounts();
    await loadBudgetSection();
    await loadGoals();

    // ✅ Force re-render of goals UI
    renderGoals();

    // ✅ Re-render budget with new currency
    const docRef = db.collection("budget").doc(currentUser.uid);
    const docSnap = await docRef.get();
    const data = docSnap.data();
    if (data) {
      const currentMonthKey = availableMonths[currentMonthIndex] ||
                              data.currentMonth ||
                              new Date().toISOString().slice(0, 7);
      const monthDocRef = docRef.collection("months").doc(currentMonthKey);
      const monthSnap  = await monthDocRef.get();
      if (monthSnap.exists) {
        renderBudget(monthSnap.data());
      }
    }

    // ✅ Re-render accounts with new currency
    renderAccounts(accounts);

    showToast("✅ Settings saved! Currency updated to " + currency, "success");
  } catch (error) {
    console.error("Error saving settings:", error);
    showToast("Failed to save settings. Please try again.", "error");
  }
});

 logoutLink.addEventListener('click', (e) => {
    e.preventDefault(); // prevent jumping to #logout
    firebase.auth().signOut()
      .then(() => {
        currentUser = null;
        // replace() instead of href so index.html is removed from history —
        // back button can't return to it, it goes further back instead
        window.location.replace("auth.html");
      })
      .catch((error) => {
        console.error("Logout error:", error);
      });
  });

document.querySelectorAll('.settings-sidebar li').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.settings-sidebar li').forEach(i => i.classList.remove('active'));
    item.classList.add('active');

    const sectionToShow = item.getAttribute('data-section');
    document.querySelectorAll('.settings-section').forEach(sec => {
      sec.style.display = sec.id === sectionToShow ? 'block' : 'none';
    });
  });
});







// ===== Reauthenticate User Modal =====
function reauthenticateUserModal() {
  return new Promise((resolve) => {
    const modal = document.getElementById("reauthModal");
    const passwordInput = document.getElementById("reauthPassword");
    const confirmBtn = document.getElementById("reauthConfirm");
    const cancelBtn = document.getElementById("reauthCancel");

    passwordInput.value = "";
    passwordInput.type = "password"; // Mask the password input
    modal.style.display = "flex";

    confirmBtn.onclick = async () => {
      const password = passwordInput.value.trim();
      if (!password) { showToast("Please enter your password.", "error"); return; }

      const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, password);
      try {
        await currentUser.reauthenticateWithCredential(credential);
        modal.style.display = "none";
        resolve(true);
      } catch (err) {
        showToast("Incorrect password. Please try again.", "error");
      }
    };

    cancelBtn.onclick = () => {
      modal.style.display = "none";
      resolve(false);
    };
  });
}

// ===== Export Backup =====
document.getElementById("exportBtn").addEventListener("click", async () => {
  const ok = await reauthenticateUserModal();
  if (!ok) return;

  const monthsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("months").get();
  const goalsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("goals").get();

  const exportObj = {
    months: monthsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
    goals: goalsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
  };

  const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "budget_backup.json";
  a.click();
  URL.revokeObjectURL(url);
});

// ===== Clear Data =====
document.getElementById("clearDataBtn").addEventListener("click", async () => {
  const ok = await reauthenticateUserModal();
  if (!ok) return;

  const _okClear = await showConfirm(
    "Clear ALL your budget data? This will permanently delete all categories, transactions, and months. This cannot be undone.",
    { confirmText: "Clear Everything", cancelText: "Cancel", type: "danger" }
  );
  if (!_okClear) return;

  const monthsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("months").get();
  for (const d of monthsSnap.docs) await d.ref.delete();

  const goalsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("goals").get();
  for (const d of goalsSnap.docs) await d.ref.delete();

  showToast("All budget data cleared.", "success");
});

// ===== Delete Account =====
document.getElementById("deleteAccountBtn").addEventListener("click", async () => {
  const ok = await reauthenticateUserModal();
  if (!ok) return;

  const _okDelFirebase = await showConfirm(
    "Permanently delete your account? All your data will be erased and cannot be recovered.",
    { confirmText: "Delete My Account", cancelText: "Cancel", type: "danger" }
  );
  if (!_okDelFirebase) return;

  await firebase.firestore().collection("users").doc(currentUser.uid).delete();

  const monthsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("months").get();
  for (const d of monthsSnap.docs) await d.ref.delete();

  const goalsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("goals").get();
  for (const d of goalsSnap.docs) await d.ref.delete();

  await currentUser.delete();

  showToast("Account deleted successfully.", "success");
  window.location.href = "sign_auth.html";
});


// Set today's date as default when opening modals
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
  
  // Set today's date for income modal
  if (id === 'incomeModal') {
    // Only reset to Add mode if not currently in edit mode
    // (editIncome() sets incomeEditId BEFORE calling openModal())
    const editId = document.getElementById("incomeEditId");
    if (editId && !editId.value) {
      const today = new Date().toISOString().slice(0, 10);
      document.getElementById("incomeDate").value = today;
      document.getElementById("income-modal-title").textContent = "Add Income";
    }
  }
  
  // Set today's date for transaction modal
  if (id === 'transactionModal') {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById("transactionDate").value = today;
  }
  
  // Set today's date for account transaction modal
  if (id === 'transaction-modal') {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById("transaction-date").value = today;
  }
}



  function closeModal(id) { document.getElementById(id).classList.add("hidden"); }
  async function logout() { if (currentUser) await auth.signOut(); }

// =====================================================
// === Category Card Color Picker =====================
// =====================================================

(function() {
  // --- State ---
  let ccActiveIndex = null;   // index of the clicked card
  let ccActiveName  = null;   // name of the clicked category
  let ccHue         = 210;    // currently selected hue (0–360)
  let ccShadeIdx    = 3;      // 0=lightest … 6=darkest
  let ccTextMode    = 'auto'; // 'auto' | 'light' | 'dark'

  // 7 lightness steps from very light → very dark
  const SHADES_L  = [92, 80, 66, 52, 40, 28, 16];
  const SHADES_S  = [85, 80, 75, 72, 70, 68, 65];

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const a = s * Math.min(l, 1-l);
    const f = n => {
      const k = (n + h/30) % 12;
      const col = l - a * Math.max(Math.min(k-3, 9-k, 1), -1);
      return Math.round(255*col).toString(16).padStart(2,'0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }

  function getBgColor() {
    return hslToHex(ccHue, SHADES_S[ccShadeIdx], SHADES_L[ccShadeIdx]);
  }

  function getTextColor(bg) {
    if (ccTextMode === 'light') return '#ffffff';
    if (ccTextMode === 'dark')  return '#1e293b';
    // auto: luminance based
    const r = parseInt(bg.slice(1,3),16)/255;
    const g = parseInt(bg.slice(3,5),16)/255;
    const b = parseInt(bg.slice(5,7),16)/255;
    const lum = 0.2126*r + 0.7152*g + 0.0722*b;
    return lum > 0.45 ? '#1e293b' : '#ffffff';
  }

  // --- DOM helpers ---
  function qs(sel) { return document.querySelector(sel); }

  // --- Open modal ---
  window.openCatColorPicker = function(index, name) {
    ccActiveIndex = index;
    ccActiveName  = name;

    // Read existing color if any
    const card = document.querySelector(`[data-cat-index="${index}"]`);
    if (card && card.dataset.catBg) {
      const hex = card.dataset.catBg;
      // parse back to hsl approx
      const r=parseInt(hex.slice(1,3),16)/255, g=parseInt(hex.slice(3,5),16)/255, b=parseInt(hex.slice(5,7),16)/255;
      const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
      let h=0;
      if(d){
        if(max===r) h=(60*((g-b)/d)+360)%360;
        else if(max===g) h=60*((b-r)/d)+120;
        else h=60*((r-g)/d)+240;
      }
      ccHue = Math.round(h);
      const l=(max+min)/2;
      // find closest shade
      const lPct = Math.round(l*100);
      let best=0, bestDiff=999;
      SHADES_L.forEach((sl,i)=>{ const d=Math.abs(sl-lPct); if(d<bestDiff){bestDiff=d;best=i;} });
      ccShadeIdx = best;
      ccTextMode = card.dataset.catText === '#ffffff' ? 'light' :
                   card.dataset.catText === '#1e293b' ? 'dark'  : 'auto';
    } else {
      ccHue=210; ccShadeIdx=3; ccTextMode='auto';
    }

    qs('#ccCatTitle').textContent = `🎨 Color: ${name}`;
    updateHueThumb();
    buildShadeSwatches();
    updateTextButtons();
    updatePreview();

    const modal = document.getElementById('catColorModal');
    modal.classList.add('open');
  };

  // --- Close ---
  window.closeCatColorModal = function() {
    document.getElementById('catColorModal').classList.remove('open');
  };

  // --- Hue bar interaction ---
  function setupHueBar() {
    const bar   = qs('#ccHueBar');
    const thumb = qs('#ccHueThumb');
    if (!bar) return;

    function setHueFromX(x) {
      const rect = bar.getBoundingClientRect();
      const pct  = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      ccHue = Math.round(pct * 360);
      updateHueThumb();
      buildShadeSwatches();
      updatePreview();
    }

    bar.addEventListener('mousedown', e => {
      setHueFromX(e.clientX);
      const move = e2 => setHueFromX(e2.clientX);
      const up   = ()  => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup',   up);
    });
    bar.addEventListener('touchstart', e => {
      setHueFromX(e.touches[0].clientX);
      const move = e2 => setHueFromX(e2.touches[0].clientX);
      const end  = ()  => { document.removeEventListener('touchmove', move); document.removeEventListener('touchend', end); };
      document.addEventListener('touchmove', move);
      document.addEventListener('touchend',  end);
    });
  }

  function updateHueThumb() {
    const thumb = qs('#ccHueThumb');
    if (!thumb) return;
    thumb.style.left = (ccHue / 360 * 100) + '%';
    thumb.style.background = `hsl(${ccHue},80%,55%)`;
  }

  // --- Shade swatches ---
  function buildShadeSwatches() {
    const grid = qs('#ccShadesGrid');
    if (!grid) return;
    grid.innerHTML = '';
    SHADES_L.forEach((l, i) => {
      const hex = hslToHex(ccHue, SHADES_S[i], l);
      const sw = document.createElement('div');
      sw.className = 'cc-shade-swatch' + (i === ccShadeIdx ? ' selected' : '');
      sw.style.background = hex;
      sw.title = hex;
      sw.addEventListener('click', () => {
        ccShadeIdx = i;
        buildShadeSwatches();
        updatePreview();
      });
      grid.appendChild(sw);
    });
  }

  // --- Text color buttons ---
  function updateTextButtons() {
    document.querySelectorAll('.cc-text-option').forEach(btn => {
      btn.classList.toggle('selected', btn.dataset.mode === ccTextMode);
    });
  }

  document.addEventListener('click', e => {
    if (e.target.matches('.cc-text-option')) {
      ccTextMode = e.target.dataset.mode;
      updateTextButtons();
      updatePreview();
    }
  });

  // --- Preview ---
  function updatePreview() {
    const bg   = getBgColor();
    const text = getTextColor(bg);
    const card = qs('#ccPreviewCard');
    if (!card) return;
    card.style.background = bg;
    card.style.color       = text;
  }

  // --- Reset ---
  window.resetCatColor = function() {
    applyColor(null, null, ccActiveIndex, ccActiveName, false);
    closeCatColorModal();
  };

  // --- Apply color to card(s) ---
  window.applyCatColorThis = function() {
    const bg   = getBgColor();
    const text = getTextColor(bg);
    applyColor(bg, text, ccActiveIndex, ccActiveName, false);
    closeCatColorModal();
  };

  window.applyCatColorAll = async function() {
    const bg   = getBgColor();
    const text = getTextColor(bg);
    const _okColorAll = await showConfirm(
      "Apply this color to ALL budget category cards?",
      { confirmText: "Apply to All", cancelText: "Cancel", type: "info" }
    );
    if (!_okColorAll) return;
    applyColor(bg, text, null, null, true);
    closeCatColorModal();
  };

  // ── A4: applyColor — writes to localStorage (instant) + Firestore (persistent) ──
  function applyColor(bg, text, index, name, all) {
    const store = JSON.parse(localStorage.getItem('catColors') || '{}');

    if (all) {
      document.querySelectorAll('.budget-item').forEach(card => {
        const n = card.dataset.catName;
        if (bg) {
          card.style.background = bg;
          card.style.color       = text;
          card.dataset.catBg     = bg;
          card.dataset.catText   = text;
          if (n) store[n] = { bg, text };
        } else {
          card.style.background = '';
          card.style.color       = '';
          delete card.dataset.catBg;
          delete card.dataset.catText;
          if (n) delete store[n];
        }
        recolorInnerText(card, text, bg);
      });
    } else {
      const card = document.querySelector(`[data-cat-index="${index}"]`);
      if (!card) return;
      if (bg) {
        card.style.background = bg;
        card.style.color       = text;
        card.dataset.catBg     = bg;
        card.dataset.catText   = text;
        if (name) store[name] = { bg, text };
      } else {
        card.style.background = '';
        card.style.color       = '';
        delete card.dataset.catBg;
        delete card.dataset.catText;
        if (name) delete store[name];
      }
      recolorInnerText(card, text, bg);
    }

    // 1. Write to localStorage immediately (keeps UI snappy)
    localStorage.setItem('catColors', JSON.stringify(store));

    // 2. Write to Firestore in the background (survives cache clear + works on any device)
    saveCatColorsToFirestore(store);
  }

  // Persist the full color store to Firestore under budget/{uid}.catColors
  // Fire-and-forget — UI never waits for this
  function saveCatColorsToFirestore(store) {
    if (!currentUser) return;
    db.collection("budget").doc(currentUser.uid)
      .update({ catColors: store })
      .catch(err => console.warn("[A4] Failed to save cat colors to Firestore:", err));
  }

  // Recolor inner spans whose colors are set via style (balance colors)
  function recolorInnerText(card, textColor, bg) {
    if (!textColor || !bg) {
      // reset
      card.querySelectorAll('.small, .font-bold, .assigned-value').forEach(el => {
        el.style.color = '';
      });
      return;
    }
    // make subtle opacity variant for secondary text
    const alpha = textColor === '#ffffff' ? 'rgba(255,255,255,0.72)' : 'rgba(30,41,59,0.6)';
    card.querySelectorAll('.small').forEach(el => { el.style.color = alpha; });
    card.querySelectorAll('.font-bold').forEach(el => { el.style.color = textColor; });
    card.querySelectorAll('.assigned-value').forEach(el => { el.style.color = textColor; });
  }

  // ── A4: restoreSavedColors — applies colors from localStorage (instant) ──
  // Firestore is the source of truth; localStorage is the local cache.
  // loadCatColorsFromFirestore() syncs them once on login.
  function restoreSavedColors() {
    const store = JSON.parse(localStorage.getItem('catColors') || '{}');
    document.querySelectorAll('.budget-item').forEach(card => {
      const name = card.dataset.catName;
      if (name && store[name]) {
        const { bg, text } = store[name];
        card.style.background = bg;
        card.style.color       = text;
        card.dataset.catBg     = bg;
        card.dataset.catText   = text;
        recolorInnerText(card, text, bg);
      }
    });
  }

  // ── A4: Load colors from Firestore on login, sync to localStorage ────────
  // Called once after auth resolves. After sync, restoreSavedColors() picks
  // up the fresh data automatically on every renderCategories() call.
  window.loadCatColorsFromFirestore = async function() {
    if (!currentUser) return;
    try {
      const snap = await db.collection("budget").doc(currentUser.uid).get();
      if (!snap.exists) return;
      const data = snap.data();
      if (data.catColors && typeof data.catColors === "object") {
        // Firestore is authoritative — overwrite localStorage with it
        localStorage.setItem('catColors', JSON.stringify(data.catColors));
        // Re-apply immediately if categories are already rendered
        restoreSavedColors();
      }
    } catch (err) {
      console.warn("[A4] Could not load cat colors from Firestore:", err);
      // Graceful fallback — localStorage colors still apply
    }
  };

  // Patch renderCategories to attach click handlers + restore colors
  const _origRenderCategories = window.renderCategories;
  window.renderCategories = function(categories) {
    _origRenderCategories(categories);

    const div = document.getElementById('categories');
    div.querySelectorAll('.budget-item').forEach((card, i) => {
      const name = categories[i] && categories[i].name;
      card.dataset.catIndex = i;
      card.dataset.catName  = name || '';

      // Add edit-color icon hint in header
      if (!card.querySelector('.cc-edit-hint')) {
        const hint = document.createElement('span');
        hint.className = 'cc-edit-hint';
        hint.title = 'Change card color';
        hint.innerHTML = '🎨';
        hint.style.cssText = 'position:absolute;top:10px;right:12px;font-size:16px;opacity:0;transition:opacity 0.2s;pointer-events:none;';
        card.appendChild(hint);
      }
      card.addEventListener('mouseenter', () => { const h = card.querySelector('.cc-edit-hint'); if(h) h.style.opacity='0.6'; });
      card.addEventListener('mouseleave', () => { const h = card.querySelector('.cc-edit-hint'); if(h) h.style.opacity='0'; });

      // Click → open color picker (ignore clicks on assigned-value inputs)
      card.addEventListener('click', e => {
        if (e.target.matches('.assigned-value') || e.target.matches('input')) return;
        openCatColorPicker(i, name);
      });
    });

    restoreSavedColors();
  };

  // --- Init on DOM ready ---
  document.addEventListener('DOMContentLoaded', () => {
    setupHueBar();
    // Close on backdrop click
    document.getElementById('catColorModal').addEventListener('click', e => {
      if (e.target === document.getElementById('catColorModal')) closeCatColorModal();
    });
  });
})();



// ════════════════════════════════════════════════════════════════════════════
// MOBILE NAVIGATION — hamburger toggle + sidebar overlay
// Only active on screens ≤ 768px. Desktop layout is untouched.
// ════════════════════════════════════════════════════════════════════════════

(function setupMobileNav() {
  const MOBILE_BREAKPOINT = 768;

  function isMobile() {
    return window.innerWidth <= MOBILE_BREAKPOINT;
  }

  function init() {
    const menuBtn  = document.getElementById("bm-mobile-menu-btn");
    const sidebar  = document.getElementById("bm-sidebar");
    const backdrop = document.getElementById("bm-sidebar-backdrop");
    if (!menuBtn || !sidebar || !backdrop) return;

    function openSidebar() {
      sidebar.classList.add("bm-sidebar-open");
      backdrop.classList.add("bm-sidebar-backdrop-visible");
      menuBtn.setAttribute("aria-expanded", "true");
      document.body.style.overflow = "hidden"; // prevent body scroll behind overlay
    }

    function closeSidebar() {
      sidebar.classList.remove("bm-sidebar-open");
      backdrop.classList.remove("bm-sidebar-backdrop-visible");
      menuBtn.setAttribute("aria-expanded", "false");
      document.body.style.overflow = "";
    }

    function toggleSidebar() {
      if (sidebar.classList.contains("bm-sidebar-open")) closeSidebar();
      else openSidebar();
    }

    menuBtn.addEventListener("click", toggleSidebar);
    backdrop.addEventListener("click", closeSidebar);

    // Close sidebar when user taps any nav link on mobile
    sidebar.querySelectorAll("a").forEach(link => {
      link.addEventListener("click", () => {
        if (isMobile()) closeSidebar();
      });
    });

    // Close on Escape key (accessibility)
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && sidebar.classList.contains("bm-sidebar-open")) {
        closeSidebar();
      }
    });

    // If user resizes from mobile → desktop, reset state
    window.addEventListener("resize", () => {
      if (!isMobile()) closeSidebar();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();


// ════════════════════════════════════════════════════════════════════════════
// SERVICE WORKER REGISTRATION (PWA support)
// Isolated block — touches no app logic. Registers sw.js if the browser
// supports it. Failure to register is non-fatal (app keeps working).
// ════════════════════════════════════════════════════════════════════════════

if ("serviceWorker" in navigator) {
  // Wait until the page is fully loaded so registration doesn't compete with
  // critical-path resources (script.js itself, Firebase SDK, fonts, etc.)
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("sw.js")
      .then((reg) => {
        console.log("[PWA] Service worker registered, scope:", reg.scope);
      })
      .catch((err) => {
        // Non-fatal: app works fine without SW, just no offline install.
        console.warn("[PWA] Service worker registration failed:", err);
      });
  });
}



// ════════════════════════════════════════════════════════════════════════════
// DESKTOP SIDEBAR COLLAPSE — toggle + localStorage persistence
// Only active on screens > 768px. Mobile is handled by setupMobileNav() above.
// Appended as part of Phase 1 Responsive UI Refactor.
// ════════════════════════════════════════════════════════════════════════════

(function setupDesktopSidebarCollapse() {
  const STORAGE_KEY   = "bm_sidebar_collapsed";
  const DESKTOP_MIN   = 769; // px — below this, collapse state is irrelevant

  function isDesktop() {
    return window.innerWidth >= DESKTOP_MIN;
  }

  function applyCollapsed(sidebar, content, collapsed) {
    if (collapsed) {
      sidebar.classList.add("bm-sidebar-collapsed");
      content.classList.add("bm-content-shifted");
      toggleBtn.setAttribute("aria-label", "Expand sidebar");
      toggleBtn.setAttribute("title", "Expand sidebar");
    } else {
      sidebar.classList.remove("bm-sidebar-collapsed");
      content.classList.remove("bm-content-shifted");
      toggleBtn.setAttribute("aria-label", "Collapse sidebar");
      toggleBtn.setAttribute("title", "Collapse sidebar");
    }
  }

  var toggleBtn; // declared here so applyCollapsed can reference it

  function init() {
    const sidebar  = document.getElementById("bm-sidebar");
    const content  = document.querySelector(".main-content");
    toggleBtn      = document.getElementById("bm-sidebar-toggle");

    if (!sidebar || !content || !toggleBtn) return;

    // Restore saved state (desktop only — don't apply collapsed on first mobile load)
    const savedCollapsed = localStorage.getItem(STORAGE_KEY) === "true";
    if (isDesktop() && savedCollapsed) {
      applyCollapsed(sidebar, content, true);
    }

    // Toggle on button click
    toggleBtn.addEventListener("click", function () {
      const isNowCollapsed = !sidebar.classList.contains("bm-sidebar-collapsed");
      applyCollapsed(sidebar, content, isNowCollapsed);
      localStorage.setItem(STORAGE_KEY, isNowCollapsed);
    });

    // On resize: if user goes to mobile, clear collapsed visual state
    // (mobile sidebar is handled by its own IIFE; collapse doesn't apply there)
    let resizeTimer;
    window.addEventListener("resize", function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        if (!isDesktop()) {
          // Remove collapsed classes on mobile — mobile has its own layout
          sidebar.classList.remove("bm-sidebar-collapsed");
          content.classList.remove("bm-content-shifted");
        } else {
          // Restore saved preference when returning to desktop
          const saved = localStorage.getItem(STORAGE_KEY) === "true";
          applyCollapsed(sidebar, content, saved);
        }
      }, 100);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();









// ════════════════════════════════════════════════════════════════════════════
// MATERIAL 3 ANDROID NAVIGATION — Bottom Nav + FAB + Top Bar
// Appended block. Zero changes to existing code above.
// ════════════════════════════════════════════════════════════════════════════

(function setupM3Navigation() {

  // Section → display name mapping for top bar title
  const SECTION_TITLES = {
    dashboard: 'Dashboard',
    accounts:  'Accounts',
    budget:    'Budget',
    reports:   'Reports',
    goals:     'Goals',
    settings:  'Settings',
  };

  // Sections accessible via bottom nav
  // Budget and Goals are accessed via FAB or sidebar (desktop)
  // but we still handle them if navigated to
  const ALL_SECTIONS = Object.keys(SECTION_TITLES);

  function isMobile() { return window.innerWidth <= 768; }

  // ── Top bar title sync ────────────────────────────────────────────────
  function setTopBarTitle(sectionId) {
    const el = document.getElementById('bm-top-bar-title');
    if (el) el.textContent = SECTION_TITLES[sectionId] || sectionId;
  }

  // ── Bottom nav active state ───────────────────────────────────────────
  function setBottomNavActive(sectionId) {
    document.querySelectorAll('.bm-bn-item').forEach(item => {
      const href = item.getAttribute('href');
      if (href === '#' + sectionId) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }

  // ── Contextual top-bar actions ────────────────────────────────────────
  // Show section-specific action buttons in the top bar area
  function updateTopBarActions(sectionId) {
    // Hide all contextual buttons first
    const addGoalBtn  = document.querySelector('.add-goal-btn');
    const addAcctBtn  = document.getElementById('add-account-btn');

    if (addGoalBtn) addGoalBtn.style.display = 'none';
    if (addAcctBtn) addAcctBtn.style.display = 'none';

    if (!isMobile()) return;

    if (sectionId === 'goals'    && addGoalBtn) addGoalBtn.style.display = 'flex';
    if (sectionId === 'accounts' && addAcctBtn) addAcctBtn.style.display = 'flex';
  }

  // ── FAB visibility ────────────────────────────────────────────────────
  // FAB only shown on sections where quick-add makes sense
  const FAB_SECTIONS = ['dashboard', 'budget', 'accounts'];

  function updateFabVisibility(sectionId) {
    if (!isMobile()) return;
    const fab = document.getElementById('bm-m3-fab');
    if (!fab) return;
    if (FAB_SECTIONS.includes(sectionId)) {
      fab.style.display = 'flex';
    } else {
      fab.style.display = 'none';
      closeFabMenu(); // make sure menu closes too
    }
  }

  // ── FAB open / close ──────────────────────────────────────────────────
  let fabOpen = false;

  window.closeFabMenu = function () {
    const fab      = document.getElementById('bm-m3-fab');
    const menu     = document.getElementById('bm-fab-menu');
    const backdrop = document.getElementById('bm-fab-backdrop');
    if (!fab) return;
    fabOpen = false;
    fab.classList.remove('bm-fab-open');
    fab.setAttribute('aria-expanded', 'false');
    if (menu)     { menu.classList.remove('bm-fab-menu-open'); menu.setAttribute('aria-hidden', 'true'); }
    if (backdrop) { backdrop.classList.remove('bm-fab-backdrop-open'); }
  };

  function openFabMenu() {
    const fab      = document.getElementById('bm-m3-fab');
    const menu     = document.getElementById('bm-fab-menu');
    const backdrop = document.getElementById('bm-fab-backdrop');
    if (!fab) return;
    fabOpen = true;
    fab.classList.add('bm-fab-open');
    fab.setAttribute('aria-expanded', 'true');
    if (menu)     { menu.classList.add('bm-fab-menu-open'); menu.setAttribute('aria-hidden', 'false'); }
    if (backdrop) { backdrop.classList.add('bm-fab-backdrop-open'); }
  }

  // ── Hook into the existing sidebar navigation ─────────────────────────
  // The existing DOMContentLoaded handler already processes sidebar clicks.
  // We watch for section changes and sync the bottom nav + top bar.
  // We use a MutationObserver on sections' display style — zero coupling risk.

  function detectActiveSection() {
    let active = 'dashboard';
    document.querySelectorAll('.section').forEach(sec => {
      if (sec.style.display !== 'none' && sec.id) {
        active = sec.id;
      }
    });
    return active;
  }

  function onSectionChange(sectionId) {
    setTopBarTitle(sectionId);
    setBottomNavActive(sectionId);
    updateTopBarActions(sectionId);
    updateFabVisibility(sectionId);
    // Scroll to top on section switch (Android convention)
    if (isMobile()) window.scrollTo({ top: 0, behavior: 'instant' });
  }

  // ── Bottom nav click handler ──────────────────────────────────────────
  function initBottomNav() {
    const bottomNavItems = document.querySelectorAll('.bm-bn-item');

    bottomNavItems.forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        closeFabMenu();

        const targetId = item.getAttribute('href').substring(1);

        // Dispatch to the EXISTING sidebar navigation system by
        // clicking the equivalent sidebar link — keeps all business
        // logic (tour guards, data reloads, etc.) intact.
        const sidebarLink = document.querySelector(`.sidebar a[href="#${targetId}"]`);
        if (sidebarLink) {
          sidebarLink.click();
        }

        // Update bottom nav immediately for responsiveness
        onSectionChange(targetId);
      });
    });
  }

  // ── FAB button handler ────────────────────────────────────────────────
  function initFab() {
    const fab      = document.getElementById('bm-m3-fab');
    const backdrop = document.getElementById('bm-fab-backdrop');

    if (!fab) return;

    fab.addEventListener('click', (e) => {
      e.stopPropagation();
      if (fabOpen) closeFabMenu();
      else openFabMenu();
    });

    if (backdrop) {
      backdrop.addEventListener('click', closeFabMenu);
    }

    // Close on Escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && fabOpen) closeFabMenu();
    });
  }

  // ── MutationObserver: sync when sidebar navigation changes sections ───
  function observeSectionChanges() {
    const sections = document.querySelectorAll('.section');
    const observer = new MutationObserver(() => {
      const active = detectActiveSection();
      onSectionChange(active);
    });
    sections.forEach(sec => {
      observer.observe(sec, { attributes: true, attributeFilter: ['style'] });
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    initBottomNav();
    initFab();
    observeSectionChanges();

    // Set initial state
    const initial = detectActiveSection();
    onSectionChange(initial);

    // Re-evaluate on resize (mobile ↔ desktop)
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const active = detectActiveSection();
        updateTopBarActions(active);
        updateFabVisibility(active);
      }, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();


// ════════════════════════════════════════════════════════════════════════════
// BUG FIXES — Mobile Portrait: Bugs 1, 2, 5, 6
// Appended block. Zero changes to existing code above.
// ════════════════════════════════════════════════════════════════════════════

(function setupMobileBugFixes() {

  function isMobile() { return window.innerWidth <= 768; }

  // ── BUG 1: Surface rollover button on mobile ─────────────────────────
  // The dashboard <header> is hidden on mobile (section header display:none).
  // We move the rollover button to a visible wrapper below the top bar.
  function initRolloverMobile() {
    const rolloverBtn = document.getElementById('rolloverBtn');
    if (!rolloverBtn || !isMobile()) return;

    // Already moved?
    if (document.getElementById('bm-rollover-mobile-wrap')) return;

    // Create wrapper
    const wrap = document.createElement('div');
    wrap.className = 'bm-rollover-mobile';
    wrap.id = 'bm-rollover-mobile-wrap';

    // Clone the button (don't move it — original onclick stays on clone via innerHTML)
    const clone = rolloverBtn.cloneNode(true);
    clone.id = 'rolloverBtnMobile';
    // Wire to same function
    clone.addEventListener('click', () => {
      if (typeof initiateRollover === 'function') initiateRollover();
    });

    wrap.appendChild(clone);

    // Insert before the appSection div inside dashboard
    const appSection = document.getElementById('appSection');
    if (appSection) {
      appSection.parentNode.insertBefore(wrap, appSection);
    }
  }

  // ── BUG 2: Keep bottom nav in sync with Budget (new item) ────────────
  // The setupM3Navigation IIFE already handles click→sidebarLink dispatch.
  // We only need to ensure Budget is in the SECTION_TITLES map.
  // That's handled in the M3 JS above via MutationObserver.
  // Budget section was already in the sidebar, so no extra wiring needed.

  // ── BUG 5: Context-aware FAB speed dial ──────────────────────────────
  // On Accounts section: show "+ Asset" and "+ Liability" only.
  // On other sections: show Income / Category / Transaction.

  const DEFAULT_FAB_HTML = `
    <button class="bm-fab-action" id="fab-income" aria-label="Add income">
      <span class="bm-fa-label">Income</span>
      <span class="bm-fa-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>
        </svg>
      </span>
    </button>
    <button class="bm-fab-action" id="fab-category" aria-label="Add category">
      <span class="bm-fa-label">Category</span>
      <span class="bm-fa-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
        </svg>
      </span>
    </button>
    <button class="bm-fab-action bm-fa-primary" id="fab-transaction" aria-label="Add transaction">
      <span class="bm-fa-label">Transaction</span>
      <span class="bm-fa-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </span>
    </button>`;

  const ACCOUNTS_FAB_HTML = `
    <button class="bm-fab-action bm-fa-primary" id="fab-add-asset" aria-label="Add asset account">
      <span class="bm-fa-label">+ Asset</span>
      <span class="bm-fa-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
        </svg>
      </span>
    </button>
    <button class="bm-fab-action" id="fab-add-liability" aria-label="Add liability account">
      <span class="bm-fa-label">+ Liability</span>
      <span class="bm-fa-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">
          <rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/>
        </svg>
      </span>
    </button>`;

  function wireFabActions(sectionId) {
    const menu = document.getElementById('bm-fab-menu');
    if (!menu) return;

    if (sectionId === 'accounts') {
      menu.innerHTML = ACCOUNTS_FAB_HTML;

      // Wire + Asset: open account modal with first asset type pre-selected
      const assetBtn = document.getElementById('fab-add-asset');
      if (assetBtn) {
        assetBtn.addEventListener('click', () => {
          if (typeof window.closeFabMenu === 'function') window.closeFabMenu();
          // Reset modal then pre-select 'checking' (first asset type)
          if (typeof resetAccountModal === 'function') resetAccountModal();
          if (typeof syncAccountTypeGrid === 'function') syncAccountTypeGrid('checking');
          const typeSelect = document.getElementById('account-type');
          if (typeSelect) typeSelect.value = 'checking';
          const titleEl   = document.getElementById('account-modal-title');
          const eyebrowEl = document.getElementById('account-modal-eyebrow');
          if (titleEl)   titleEl.innerText     = 'Add Asset Account';
          if (eyebrowEl) eyebrowEl.textContent = 'New asset';
          if (typeof openModal === 'function') openModal('account-modal');
        });
      }

      // Wire + Liability: open account modal with credit-card pre-selected
      const liabBtn = document.getElementById('fab-add-liability');
      if (liabBtn) {
        liabBtn.addEventListener('click', () => {
          if (typeof window.closeFabMenu === 'function') window.closeFabMenu();
          if (typeof resetAccountModal === 'function') resetAccountModal();
          if (typeof syncAccountTypeGrid === 'function') syncAccountTypeGrid('credit-card');
          const typeSelect = document.getElementById('account-type');
          if (typeSelect) typeSelect.value = 'credit-card';
          const cc = document.getElementById('credit-card-fields');
          if (cc) cc.style.display = 'block';
          const titleEl   = document.getElementById('account-modal-title');
          const eyebrowEl = document.getElementById('account-modal-eyebrow');
          if (titleEl)   titleEl.innerText     = 'Add Liability Account';
          if (eyebrowEl) eyebrowEl.textContent = 'New liability';
          if (typeof openModal === 'function') openModal('account-modal');
        });
      }

    } else {
      // Default: Income / Category / Transaction
      menu.innerHTML = DEFAULT_FAB_HTML;

      const incomeBtn = document.getElementById('fab-income');
      if (incomeBtn) incomeBtn.addEventListener('click', () => {
        if (typeof openModal === 'function') openModal('incomeModal');
        if (typeof window.closeFabMenu === 'function') window.closeFabMenu();
      });

      const catBtn = document.getElementById('fab-category');
      if (catBtn) catBtn.addEventListener('click', () => {
        if (typeof openModal === 'function') openModal('categoryModal');
        if (typeof window.closeFabMenu === 'function') window.closeFabMenu();
      });

      const txnBtn = document.getElementById('fab-transaction');
      if (txnBtn) txnBtn.addEventListener('click', () => {
        if (typeof openModal === 'function') openModal('transactionModal');
        if (typeof window.closeFabMenu === 'function') window.closeFabMenu();
      });
    }
  }

  // ── BUG 6: Account row tap → action bottom sheet ─────────────────────
  let _aasAccountIndex = null;

  function openAccountActionSheet(index) {
    if (!isMobile()) return; // desktop uses existing popover
    _aasAccountIndex = index;

    const sheet    = document.getElementById('bm-acct-action-sheet');
    const title    = document.getElementById('bm-aas-title');
    if (!sheet) return;

    // Set title to account name
    if (window.accounts && window.accounts[index]) {
      const acc = window.accounts[index];
      if (title) title.textContent = acc.name || 'Account';
    }

    sheet.classList.add('open');
    sheet.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeAccountActionSheet() {
    const sheet = document.getElementById('bm-acct-action-sheet');
    if (!sheet) return;
    sheet.classList.remove('open');
    sheet.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    _aasAccountIndex = null;
  }

  function initAccountActionSheet() {
    const sheet    = document.getElementById('bm-acct-action-sheet');
    const backdrop = document.getElementById('bm-aas-backdrop');
    const addTxn   = document.getElementById('bm-aas-add-txn');
    const editBtn  = document.getElementById('bm-aas-edit');
    const deleteBtn = document.getElementById('bm-aas-delete');
    const cancelBtn = document.getElementById('bm-aas-cancel');

    if (!sheet) return;

    // Close on backdrop tap
    if (backdrop) backdrop.addEventListener('click', closeAccountActionSheet);
    if (cancelBtn) cancelBtn.addEventListener('click', closeAccountActionSheet);

    // Add transaction — delegates to existing openTransactionPanel
    if (addTxn) {
      addTxn.addEventListener('click', () => {
        const idx = _aasAccountIndex;
        closeAccountActionSheet();
        if (idx !== null && typeof openTransactionPanel === 'function') {
          setTimeout(() => openTransactionPanel(idx), 80);
        }
      });
    }

    // Edit — delegates to existing editAccount
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        const idx = _aasAccountIndex;
        closeAccountActionSheet();
        if (idx !== null && typeof editAccount === 'function') {
          setTimeout(() => editAccount(idx), 80);
        }
      });
    }

    // Delete — delegates to existing deleteAccount
    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        const idx = _aasAccountIndex;
        closeAccountActionSheet();
        if (idx !== null && typeof deleteAccount === 'function') {
          setTimeout(() => deleteAccount(idx), 80);
        }
      });
    }

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAccountActionSheet();
    });
  }

  // Hook account-item taps on mobile to open action sheet
  // We use event delegation on the main-content since account items
  // are rendered dynamically by renderAccounts()
  function initAccountRowTapDelegation() {
    const mainContent = document.querySelector('.main-content');
    if (!mainContent) return;

    mainContent.addEventListener('click', (e) => {
      if (!isMobile()) return;

      // Find tapped account-item
      const item = e.target.closest('.account-item');
      if (!item) return;

      // Don't intercept the existing + button (add-txn-btn)
      if (e.target.closest('.btn-add-txn')) return;

      // Don't intercept the Recent (history) button — it has its own onclick
      if (e.target.closest('.btn-recent')) return;

      // Get account index from the item's id: account-item-{index}
      const match = item.id && item.id.match(/account-item-(\d+)/);
      if (!match) return;

      e.preventDefault();
      e.stopPropagation();
      openAccountActionSheet(parseInt(match[1], 10));
    });
  }

  // ── Hook into section changes to swap FAB dial ────────────────────────
  // Patch onSectionChange from setupM3Navigation by observing the same
  // MutationObserver pattern (we can't access the closure directly)
  function observeForFabSwap() {
    const sections = document.querySelectorAll('.section');
    const observer = new MutationObserver(() => {
      let active = 'dashboard';
      sections.forEach(sec => {
        if (sec.style.display !== 'none' && sec.id) active = sec.id;
      });
      wireFabActions(active);
    });
    sections.forEach(sec => {
      observer.observe(sec, { attributes: true, attributeFilter: ['style'] });
    });
    // Set initial state
    wireFabActions('dashboard');
  }

  // ── Init ──────────────────────────────────────────────────────────────
  function init() {
    initRolloverMobile();
    initAccountActionSheet();
    initAccountRowTapDelegation();
    observeForFabSwap();

    // Re-run rollover init when appSection becomes visible
    // (it starts as display:none)
    const appSection = document.getElementById('appSection');
    if (appSection) {
      const obs = new MutationObserver(() => {
        if (appSection.style.display !== 'none' && isMobile()) {
          initRolloverMobile();
        }
      });
      obs.observe(appSection, { attributes: true, attributeFilter: ['style'] });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for external use
  window.openAccountActionSheet  = openAccountActionSheet;
  window.closeAccountActionSheet = closeAccountActionSheet;

})();



// ════════════════════════════════════════════════════════════════════════════
// SETTINGS APPEARANCE PANEL — Theme picker in Settings for mobile users
// Appended. Nothing above modified.
// ════════════════════════════════════════════════════════════════════════════

(function setupSettingsThemePanel() {

  function syncSettingsThemeActive(currentTheme) {
    document.querySelectorAll('.bm-stg-card').forEach(card => {
      if (card.dataset.theme === currentTheme) {
        card.classList.add('bm-stg-active');
      } else {
        card.classList.remove('bm-stg-active');
      }
    });
  }

  function init() {
    const grid = document.getElementById('bm-settings-theme-grid');
    if (!grid) return;

    // Wire each theme card to ThemeManager.setTheme
    grid.querySelectorAll('.bm-stg-card').forEach(card => {
      card.addEventListener('click', () => {
        const theme = card.dataset.theme;
        // Use the existing ThemeManager instance
        if (window.themeManager && typeof window.themeManager.setTheme === 'function') {
          window.themeManager.setTheme(theme);
        } else {
          // Fallback: directly apply if ThemeManager not exposed
          document.documentElement.removeAttribute('data-theme');
          if (theme !== 'classic') {
            document.documentElement.setAttribute('data-theme', theme);
          }
          localStorage.setItem('budgetmaster-theme', theme);
        }
        syncSettingsThemeActive(theme);
      });
    });

    // Sync active state when panel is opened
    // Watch for themeSection becoming visible
    const themeSection = document.getElementById('themeSection');
    if (themeSection) {
      const obs = new MutationObserver(() => {
        if (themeSection.style.display !== 'none') {
          const current = localStorage.getItem('budgetmaster-theme') || 'classic';
          syncSettingsThemeActive(current);
        }
      });
      obs.observe(themeSection, { attributes: true, attributeFilter: ['style'] });
    }

    // Also sync on init
    const current = localStorage.getItem('budgetmaster-theme') || 'classic';
    syncSettingsThemeActive(current);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
