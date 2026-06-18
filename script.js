// ============================================
// BudgetMaster JavaScript
// Extracted from inline <script> blocks
// ============================================

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
  let lastRolloverDate = null; // Track last rollover to prevent multiple rollovers in same month

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
  });
});
  });








// ==== Render Functions ====
function renderCategories(categories) {
  const div = document.getElementById("categories");
  const select = document.getElementById("transactionCategory");
  div.innerHTML = "";
  select.innerHTML = "";

  categories.forEach((c, index) => {
    // ✅ Always compute fresh balance
    const balance = c.assigned - c.spent;
    const monthLabel = c.month ? `<span class="pill">${c.month}</span>` : "";

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
          </div>
        </div>
      </div>
    `;

    select.innerHTML += `<option value="${c.name}">${c.name}</option>`;
  });
}

function formatCurrency(amount, isOutflow = false) {
  if (isNaN(amount)) return "";
  
  const currencySymbols = {
    "USD": "$",
    "PHP": "₱",
    "EUR": "€",
    "JPY": "¥"
  };
  
  const symbol = currencySymbols[userCurrency] || "$";
  
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
  
// ✅ Save Available Balance to database
  if (currentUser) {
    const docRef = db.collection("budget").doc(currentUser.uid);
    const selectedMonth = availableMonths[currentMonthIndex] || data.currentMonth || new Date().toISOString().slice(0,7);
    const monthDocRef = docRef.collection("months").doc(selectedMonth);
    
    // Update the month document with the computed Available Balance
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
  if (isNaN(val) || val < 0) return alert("Enter valid number");

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

  // ── Negative TBB warning — stays in UI layer for both paths ─────────────
  if (newTBB < 0 && diff > 0) {
    const proceed = confirm(
      `⚠️ WARNING: This will make your "To Be Budgeted" negative!\n\n` +
      `Current TBB: ${formatCurrency(monthData.tbb)}\n` +
      `Adding: ${formatCurrency(diff)}\n` +
      `New TBB: ${formatCurrency(newTBB)}\n\n` +
      `This means you're budgeting more money than you have.\n\n` +
      `Do you want to continue?`
    );
    if (!proceed) { renderBudget(monthData); return; }
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
      alert("Failed to update budget. Please try again.");
      renderBudget(monthData);
      return;
    }
  } else {
    // ── Legacy inline path (original code, untouched) ────────────────────
    monthData.categories[index].assigned = val;
    monthData.categories[index].balance  = val - monthData.categories[index].spent;
    monthData.tbb = newTBB;

    await monthDocRef.set(monthData);
    renderBudget(monthData);
  }

  // Show warning toast if TBB went negative (runs for both paths)
  if (newTBB < 0) {
    showToast("⚠️ Warning: You've over-budgeted! TBB is now negative.", "error");
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
  if (!user) return window.location.href = "auth.html";
  currentUser = user;
  
  try {
    const userDoc = await db.collection("users").doc(user.uid).get();
    const userData = userDoc.data();
    
    // ✅ Set global currency from user profile
    if (userDoc.exists && userData?.currency) {
      userCurrency = userData.currency;
      //console.log("✅ Currency loaded:", userCurrency);
    } else {
      userCurrency = "USD";
      console.log("⚠️ No currency found, using default: USD");
    }
    
    if (userDoc.exists && userData?.approved === true) {
      document.getElementById("appSection").style.display = "block";
      await loadAvailableMonths();
      await loadBudget();
      await loadAccounts();
      await loadRolloverSettings();
      await loadGoals();
    } else {
      alert("Your account is not yet approved.");
      await auth.signOut();
    }
  } catch (err) {
    console.error("Error fetching user:", err);
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
  if (isNaN(amount) || amount <= 0) return alert("Enter valid income");

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
      alert("Failed to save income. Please try again.");
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
  if (!name || isNaN(assignAmount) || assignAmount < 0) return alert("Enter valid category");

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

  // ── Negative TBB warning — stays in UI layer for both paths ─────────────
  const newTBB = monthData.tbb - assignAmount;
  if (newTBB < 0) {
    const proceed = confirm(
      `⚠️ WARNING: This will make your "To Be Budgeted" negative!\n\n` +
      `Current TBB: ${formatCurrency(monthData.tbb)}\n` +
      `Assigning: ${formatCurrency(assignAmount)}\n` +
      `New TBB: ${formatCurrency(newTBB)}\n\n` +
      `This means you're budgeting more money than you have.\n\n` +
      `Do you want to continue?`
    );
    if (!proceed) return;
  }

  // ── Duplicate-name check — stays in UI layer for both paths ─────────────
  // (engine doesn't know "duplicate category" as a business rule)
  if (monthData.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
    return alert("Category already exists. Please use a different name!");
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
      alert("Failed to save category. Please try again.");
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

  if (newTBB < 0) {
    showToast("⚠️ Warning: You've over-budgeted! TBB is now negative.", "error");
  }
}

async function addTransaction() {
  // ── Read DOM inputs (unchanged) ──────────────────────────────────────────
  const name     = document.getElementById("transactionName").value.trim();
  const amount   = parseFloat(document.getElementById("transactionAmount").value);
  const category = document.getElementById("transactionCategory").value;
  const date     = document.getElementById("transactionDate").value;
  const selectedMonth = availableMonths[currentMonthIndex] || null;

  // ── Validation (unchanged) ───────────────────────────────────────────────
  if (!name || isNaN(amount) || amount <= 0) return alert("Enter valid transaction");
  if (!date) return alert("Please select a date");

  // ── Resolve target month (unchanged) ─────────────────────────────────────
  const docRef  = db.collection("budget").doc(currentUser.uid);
  const docSnap = await docRef.get();
  const data    = docSnap.data();
  const targetMonth = selectedMonth || data.currentMonth || new Date().toISOString().slice(0, 7);

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
      alert("Failed to save transaction. Please try again.");
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




function initiateRollover() {
  const btn = document.getElementById('rolloverBtn');
  const text = btn.querySelector('.btn-text');

  btn.classList.add('loading');
  text.textContent = 'Processing...';

  setTimeout(() => {
    btn.classList.remove('loading');
    btn.classList.add('success');
    text.textContent = 'Rollover Complete';

    setTimeout(() => {
      btn.classList.remove('success');
      text.textContent = 'Rollover';
    }, 4000);
  }, 4000);
}

// Keyboard accessibility
document.getElementById('rolloverBtn').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    initiateRollover();
  }
});

// Ripple click effect
document.getElementById('rolloverBtn').addEventListener('click', function (e) {
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
    
    alert("✅ Rollover settings saved!");
  } catch (error) {
    console.error("Error saving rollover settings:", error);
    alert("❌ Failed to save settings. Please try again.");
  }
});

// Initiate manual rollover (called from dashboard button)
function initiateRollover() {
  // Check if already rolled over this month
  if (lastRolloverDate) {
    const lastRollover = new Date(lastRolloverDate);
    const now = new Date();
    if (lastRollover.getFullYear() === now.getFullYear() && 
        lastRollover.getMonth() === now.getMonth()) {
      alert("⚠️ You have already performed a rollover this month. Rollover is only available once per month.");
      return;
    }
  }
  
  // Show confirmation modal
  document.getElementById("rolloverModal").style.display = "flex";
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
  
  // Perform rollover
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
  if (!currentMonthSnap.exists) return alert("Current month data not found!");

  const currentMonthData = currentMonthSnap.data();
  const categories = currentMonthData.categories || [];
  
// ✅ Use Available Balance instead of calculating from TBB
  const availableBalance = currentMonthData.availableBalance || 0;
  const totalRemainingBalance = availableBalance;

  // Save current month data
  await currentMonthDocRef.set({ ...currentMonthData, savedAt: new Date().toISOString() });

  // ✅ NEW: Reset all categories to zero (don't carry forward assigned amounts)
  const newCategories = categories.map(c => ({
    name: c.name,
    assigned: 0,  // ✅ Start fresh, don't carry forward
    spent: 0,
    balance: 0
  }));

  // Compute next month key
  const [year, month] = baseMonthKey.split("-").map(Number);
  const nextMonthDate = new Date(year, month - 1, 1);
  nextMonthDate.setMonth(nextMonthDate.getMonth() + 1);
  const nextMonthKey = `${nextMonthDate.getFullYear()}-${String(nextMonthDate.getMonth() + 1).padStart(2, "0")}`;

  const rolloverDate = new Date().toISOString().slice(0, 10);

  // ✅ Create rollover transaction showing what was carried forward
  const rolloverTransaction = {
    id: `rollover-${Date.now()}`,
    amount: totalRemainingBalance,
    category: "BALANCE FROM LAST MONTH",
    date: rolloverDate,
    name: "ROLLOVER AMOUNT",
    type: "income",
    inflow: totalRemainingBalance,
    outflow: 0
  };

  const transactions = totalRemainingBalance > 0 ? [rolloverTransaction] : [];

  // ✅ Create next month with only the remaining balance as TBB
  const nextMonthDocRef = docRef.collection("months").doc(nextMonthKey);
  await nextMonthDocRef.set({
    categories: newCategories,  // ✅ All categories start at zero
    transactions: transactions,
    tbb: totalRemainingBalance,  // ✅ This is the ONLY money available
    currentMonth: nextMonthKey
  });

  // Update main doc pointer
  await docRef.update({ currentMonth: nextMonthKey });
  
  // Update last rollover date
  lastRolloverDate = new Date().toISOString();
  await firebase.firestore().collection("users").doc(currentUser.uid).update({
    "rolloverSettings.lastRollover": lastRolloverDate
  });

  // ✅ Reload available months and navigate to new month
  await loadAvailableMonths();
  
  currentMonthIndex = availableMonths.indexOf(nextMonthKey);
  if (currentMonthIndex === -1) {
    currentMonthIndex = availableMonths.length - 1;
  }
  
  updateMonthDisplay();
  await loadMonthData(nextMonthKey);

alert(
    `✅ Rollover complete!\n\n` +
    `Previous Month:\n` +
    `- Available Balance: ${formatCurrency(availableBalance)}\n\n` +
    `New Month (${nextMonthKey}):\n` +
    `- Starting TBB: ${formatCurrency(totalRemainingBalance)}\n` +
    `- All Categories Reset: ${formatCurrency(0)}\n\n` +
    `You can now assign this money to your categories!`
  );
  
  showToast("Rollover completed successfully!", "success");
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
    } else {
      userCurrency = "USD";
    }
    
    if (userDoc.exists && userData?.approved === true) {
      document.getElementById("appSection").style.display = "block";
      await loadAvailableMonths(); // Add this line
      await loadBudget();
      await loadAccounts();  
    } else {
      alert("Your account is not yet approved.");
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
        <button class="btn-sm btn-outline" onclick="toggleAccountHistory(${index})" title="Transaction History">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </button>
        <button class="btn-sm btn-outline" onclick="editAccount(${index})" title="Edit">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        </button>
        <button class="btn-sm btn-outline btn-add-txn" id="add-txn-btn-${index}" onclick="openTransactionPanel(${index})" title="Add Transaction">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
        <button class="btn-sm btn-danger" onclick="deleteAccount(${index})" title="Delete">
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

function formatCurrency(amount, isOutflow = false) {
  if (isNaN(amount)) return "";
  
  const currencySymbols = {
    "USD": "$",
    "PHP": "₱",
    "EUR": "€",
    "JPY": "¥"
  };
  
  const symbol = currencySymbols[userCurrency] || "$";
  
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
  document.getElementById("account-modal-title").innerText = "Add Account";
  document.getElementById("account-type").value = "checking";
  document.getElementById("account-name").value = "";
  document.getElementById("account-balance").value = "";
  document.getElementById("account-notes").value = "";
  document.getElementById("account-credit-limit").value = "";
  document.getElementById("account-due-date").value = "";
  document.getElementById("credit-card-fields").style.display = "none";
  document.getElementById("account-balance-label").textContent = "Current Balance";
  document.getElementById("balance-hint").textContent = "Enter the current balance of this account";
  document.getElementById("balance-hint").style.color = "var(--text-light)";
  openModal("account-modal");
});

// Edit account function
async function editAccount(index) {
  const account = accounts[index];
  if (!account) return;

  editingIndex = index;
  document.getElementById("account-modal-title").innerText = "Edit Account";
  document.getElementById("account-type").value = account.type || "checking";
  document.getElementById("account-name").value = account.name;
  document.getElementById("account-balance").value = Math.abs(account.balance || 0);
  document.getElementById("account-notes").value = account.notes || "";
  document.getElementById("account-credit-limit").value = account.creditLimit || "";
  document.getElementById("account-due-date").value = account.dueDay || "";
  
  // Update hint based on type
  const typeInfo = ACCOUNT_TYPES[account.type];
  const hint = document.getElementById("balance-hint");
  const balLabel = document.getElementById("account-balance-label");
  const ccFields = document.getElementById("credit-card-fields");
  
  if (account.type === 'credit-card') {
    hint.textContent = "Enter current amount owed";
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
  
  if (!type) return alert("Please select an account type");
  if (!name) return alert("Please enter an account name");
  if (isNaN(balance)) return alert("Please enter a valid balance");
  
  // Credit card validation
  if (type === 'credit-card') {
    if (!creditLimitRaw || isNaN(parseFloat(creditLimitRaw)) || parseFloat(creditLimitRaw) <= 0) {
      return alert("Please enter a valid Credit Limit for this credit card.");
    }
    if (!dueDayRaw) {
      return alert("Please select a Due Date for this credit card so you know when payments are due.");
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
    return alert("An account with this name already exists!");
  }

// ✅ Check if balance changed during edit
  if (editingIndex !== null) {
    const oldBalance = data.accounts[editingIndex].balance;
    const newBalanceValue = type === 'credit-card' ? balance : balance;
    const balanceChanged = Math.abs(oldBalance) !== newBalanceValue;

    if (balanceChanged) {
      // ✅ Show warning
      const confirmChange = confirm(
        "⚠️ WARNING: Manually changing the account balance is NOT recommended!\n\n" +
        `Current Balance: ${formatCurrency(Math.abs(oldBalance))}\n` +
        `New Balance: ${formatCurrency(newBalanceValue)}\n\n` +
        "This will forcefully override your account balance and may cause discrepancies with your transaction history.\n\n" +
        "💡 TIP: Use 'Add Transaction' instead to properly track deposits/withdrawals.\n\n" +
        "Do you still want to proceed?"
      );

      if (!confirmChange) {
        return;
      }

      // ✅ Require password verification
      const authenticated = await reauthenticateUserModal();
      if (!authenticated) {
        return alert("❌ Password verification failed. Balance change cancelled.");
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
  
  if (!confirm(`Delete "${account.name}"?\n\nThis will also delete all transactions for this account. This cannot be undone.`)) return;
  
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

    if (isNaN(amount) || amount <= 0) return alert("Enter a valid amount.");

    if (type === "expense") {
      const catIndexVal = wrapper.querySelector('#expense-category').value;
      if (catIndexVal === "") return alert("Please select a budget category for this expense.");
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
            if (!confirm(`⚠️ Paying ${formatCurrency(amount)} exceeds your Available Balance of ${formatCurrency(currentAvailableBalance)}. Proceed anyway?`)) return;
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
          if (data.accounts[transactionAccountIndex].balance < amount) return alert("Insufficient balance.");
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
          if (data.accounts[transactionAccountIndex].balance < amount) return alert("Insufficient balance.");
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
          if (data.accounts[transactionAccountIndex].balance < amount) return alert("Insufficient balance.");
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

        if (!flatIntent) return alert("Unknown transaction type.");

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
        alert("Failed to save transaction. Please try again.");
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
        if (!confirm(`⚠️ Paying ${formatCurrency(amount)} exceeds your Available Balance of ${formatCurrency(currentAvailableBalance)}. Proceed anyway?`)) return;
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
        monthData.categories[catIndex].balance = monthData.categories[catIndex].assigned - monthData.categories[catIndex].spent;
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
      if (data.accounts[transactionAccountIndex].balance < amount) return alert("Insufficient balance.");
      data.accounts[transactionAccountIndex].balance -= amount;
      newTransaction.inflow = amount;
      newTransaction.type   = "income";

    } else if (type === "transfer") {
      const targetIndex = parseInt(wrapper.querySelector('#transfer-target').value);
      if (data.accounts[transactionAccountIndex].balance < amount) return alert("Insufficient balance.");
      data.accounts[transactionAccountIndex].balance  -= amount;
      data.accounts[targetIndex].balance              += amount;
      newTransaction.outflow     = amount;
      newTransaction.inflow      = amount;
      newTransaction.fromAccount = data.accounts[transactionAccountIndex].name;
      newTransaction.toAccount   = data.accounts[targetIndex].name;

    } else if (type === "expense") {
      if (data.accounts[transactionAccountIndex].balance < amount) return alert("Insufficient balance.");
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
        monthData.categories[catIndex].balance = monthData.categories[catIndex].assigned - monthData.categories[catIndex].spent;
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

  categories.forEach((c, index) => {
    const balance = c.assigned - c.spent;

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

  // Add checkbox click listeners
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


function formatCurrency(amount, isOutflow = false) {
  if (isNaN(amount)) return "";
  
  const currencySymbols = {
    "USD": "$",
    "PHP": "₱",
    "EUR": "€",
    "JPY": "¥"
  };
  
  const symbol = currencySymbols[userCurrency] || "$";
  
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
  if (!confirm("Delete this category?")) return;

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
  await loadBudgetSection();

  showToast(`Category "${catName}" deleted successfully`, "success");
});

// ✅ Delete transaction (and return amount to category)
async function deleteTransaction(categoryName, txId) {
  if (!confirm("Delete this transaction?")) return;
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
        if (cat) {
          if (tx.type === "expense") {
            // Reverse expense: restore category spent and balance
            cat.spent   = Math.max(0, (cat.spent || 0) - tx.amount);
            cat.balance = cat.assigned - cat.spent;
          } else if (tx.type === "income" && !tx.isAccountOnlyTxn) {
            // Reverse income: restore TBB (NOT cat.assigned — income goes to TBB, not categories)
            monthData.tbb = Math.max(0, (monthData.tbb || 0) - tx.amount);
          }
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
  if (txIndex === -1) return alert("Transaction not found!");

  const tx = monthData.transactions[txIndex];

  const cat = monthData.categories.find((c) => c.name === categoryName);
  if (cat) {
    if (tx.type === "expense") {
      cat.spent -= tx.amount;
      if (cat.spent < 0) cat.spent = 0;
      cat.balance = cat.assigned - cat.spent;
    } else if (tx.type === "income") {
      cat.assigned -= tx.amount;
      if (cat.assigned < 0) cat.assigned = 0;
    }
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
  if (!panel) return;
  if (panel.style.display === 'none' || panel.style.display === '') {
    panel.style.display = 'block';
    await loadAccountTransactionHistory(index);
  } else {
    panel.style.display = 'none';
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
  if (!confirm('Delete this transaction? This will reverse the account balance only.')) return;
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

// Automatically load budget section after login
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
      alert('Please select both start and end dates for custom range.');
      return;
    }
    
    if (new Date(fromDate) > new Date(toDate)) {
      alert('Start date must be before end date.');
      return;
    }
  }

  updateActiveFilters();
  loadAllReports();
  showToast('Reports updated successfully', 'success');
}















  


  function formatCurrency(amount, isOutflow = false) {
  if (isNaN(amount)) return "";
  
  const currencySymbols = {
    "USD": "$",
    "PHP": "₱",
    "EUR": "€",
    "JPY": "¥"
  };
  
  const symbol = currencySymbols[userCurrency] || "$";
  
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
                    alert("Your account is not yet approved.");
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

            if (!confirm(`Are you sure you want to delete "${goal.name}"? This action cannot be undone.`)) {
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
        // Load saved theme
        const savedTheme = localStorage.getItem('budgetmaster-theme') || 'classic';
        this.setTheme(savedTheme);

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

      setTheme(theme) {
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
        
        // Save theme preference
        localStorage.setItem('budgetmaster-theme', theme);
        
        // Emit theme change event for other parts of the app
        window.dispatchEvent(new CustomEvent('themeChanged', { detail: { theme } }));
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
      const doc = await firebase.firestore().collection("users").doc(currentUser.uid).get();
      if (doc.exists) {
        const data = doc.data();
        document.getElementById("displayName").value = data.displayName || currentUser.displayName || "";
        document.getElementById("email").value = currentUser.email || "";
        
        const savedCurrency = data.currency || "USD";
        document.getElementById("currency").value = savedCurrency;
      }
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
    
    console.log("💰 Currency updated to:", userCurrency);
    
    // ✅ Reload all data with new currency format
    await loadBudget();
    await loadAccounts();
    await loadBudgetSection();
    await loadGoals(); // This reloads goals with new currency
    
    // ✅ Force re-render of goals UI
    renderGoals();
    
    // ✅ Re-render budget data
    const docRef = db.collection("budget").doc(currentUser.uid);
    const docSnap = await docRef.get();
    const data = docSnap.data();
    if (data) {
      const currentMonth = data.currentMonth || new Date().toISOString().slice(0, 7);
      const monthDocRef = docRef.collection("months").doc(currentMonth);
      const monthSnap = await monthDocRef.get();
      if (monthSnap.exists) {
        renderBudget(monthSnap.data());
      }
    }
    
    alert("✅ Settings saved! Currency updated to " + currency);
  } catch (error) {
    console.error("Error saving settings:", error);
    alert("❌ Failed to save settings. Please try again.");
  }
});

 logoutLink.addEventListener('click', (e) => {
    e.preventDefault(); // prevent jumping to #logout
    firebase.auth().signOut()
      .then(() => {
        window.location.href = "auth.html"; // redirect after logout
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
      if (!password) return alert("Please enter your password.");

      const credential = firebase.auth.EmailAuthProvider.credential(currentUser.email, password);
      try {
        await currentUser.reauthenticateWithCredential(credential);
        modal.style.display = "none";
        resolve(true);
      } catch (err) {
        alert("❌ Incorrect password. Try again.");
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

  if (!confirm("Clear all your budget data?")) return;

  const monthsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("months").get();
  for (const d of monthsSnap.docs) await d.ref.delete();

  const goalsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("goals").get();
  for (const d of goalsSnap.docs) await d.ref.delete();

  alert("🗑️ Data cleared.");
});

// ===== Delete Account =====
document.getElementById("deleteAccountBtn").addEventListener("click", async () => {
  const ok = await reauthenticateUserModal();
  if (!ok) return;

  if (!confirm("Delete account permanently? This cannot be undone.")) return;

  await firebase.firestore().collection("users").doc(currentUser.uid).delete();

  const monthsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("months").get();
  for (const d of monthsSnap.docs) await d.ref.delete();

  const goalsSnap = await firebase.firestore().collection("budget").doc(currentUser.uid).collection("goals").get();
  for (const d of goalsSnap.docs) await d.ref.delete();

  await currentUser.delete();

  alert("🚫 Account deleted.");
  window.location.href = "sign_auth.html";
});


// Set today's date as default when opening modals
function openModal(id) {
  document.getElementById(id).classList.remove("hidden");
  
  // Set today's date for income modal
  if (id === 'incomeModal') {
    const today = new Date().toISOString().slice(0, 10);
    document.getElementById("incomeDate").value = today;
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

  window.applyCatColorAll = function() {
    const bg   = getBgColor();
    const text = getTextColor(bg);
    if (!confirm(`Apply this color to ALL budget category cards?`)) return;
    applyColor(bg, text, null, null, true);
    closeCatColorModal();
  };

  function applyColor(bg, text, index, name, all) {
    // Persist in localStorage keyed by category name
    const store = JSON.parse(localStorage.getItem('catColors') || '{}');

    if (all) {
      // Apply same color to every visible card
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
        // Recolor nested text elements that have explicit inline colors
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
    localStorage.setItem('catColors', JSON.stringify(store));
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

  // --- Restore saved colors after renderCategories rebuilds DOM ---
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
