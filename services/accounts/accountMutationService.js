/**
 * services/accounts/accountMutationService.js
 *
 * Pure functions that compute and apply account-balance deltas.
 * ZERO side-effects: every function takes data in, returns new data out.
 * Nothing in production calls these yet (Phase 1 is additive-only).
 *
 * Account data lives in the Firestore root accounts array:
 *   budget/{uid}.accounts = [{ name, type, balance, ... }, ...]
 *
 * All monetary values flowing through these functions are integer CENTS.
 * The root doc stores float pesos; toCents / fromCents bridge the gap.
 */





// ---------------------------------------------------------------------------
// AccountDelta type
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} AccountEntry
 * @property {string} accountName
 * @property {number} balanceDeltaCents  — positive = increase, negative = decrease
 */

/**
 * @typedef {Object} AccountDelta
 * @property {AccountEntry[]} entries   — list of accounts to mutate (0–2 entries)
 * @property {string}         reason    — human-readable explanation
 */

// ---------------------------------------------------------------------------
// computeAccountDelta
// ---------------------------------------------------------------------------

/**
 * Given a TransactionIntent and the accounts array, compute the account
 * balance changes required.
 *
 * Rules (mirror existing account-transaction handlers in script.js):
 *
 *  TYPE_INCOME
 *    → No account balance change (income goes to TBB, not an account ledger)
 *      Exception: if an accountName is provided (deposit to account), credit it.
 *
 *  TYPE_EXPENSE, SOURCE_AVAILABLE
 *    → No account balance change (paid from budget pool, not account)
 *
 *  TYPE_EXPENSE, SOURCE_ASSET
 *    → asset account balance -= amount
 *
 *  TYPE_EXPENSE, SOURCE_LIABILITY
 *    → liability account balance += amount  (debt grows)
 *
 *  TYPE_TRANSFER
 *    → fromAccount balance -= amount
 *    → toAccount   balance += amount
 *
 *  TYPE_LIABILITY_PAYMENT
 *    → liability account balance -= amount  (debt shrinks, cash already left via TBB)
 *
 * @param {import('../transactions/transactionIntent').TransactionIntent} intent
 * @param {Array<{name: string, type: string, balance: number}>} accounts
 * @returns {AccountDelta}
 */
function computeAccountDelta(intent, accounts) {
  _requireIntent(intent);
  if (!Array.isArray(accounts)) {
    throw new Error("computeAccountDelta: accounts must be an array");
  }

  switch (intent.type) {

    case TYPE_INCOME: {
      // Income with a named account = deposit into that account
      if (intent.accountName) {
        const acc = _findAccount(accounts, intent.accountName);
        return {
          entries: [{ accountName: acc.name, balanceDeltaCents: intent.amountCents }],
          reason: `Income deposited into account "${acc.name}" +${_fmt(intent.amountCents)}`,
        };
      }
      return _noOp("Income to TBB — no account balance change");
    }

    case TYPE_EXPENSE: {
      if (intent.source === SOURCE_AVAILABLE) {
        return _noOp(`Expense from available balance — no account balance change`);
      }

      if (intent.source === SOURCE_ASSET) {
        const acc = _findAccount(accounts, intent.accountName);
        _assertCategory(acc, ACCOUNT_CATEGORY_ASSET, "SOURCE_ASSET expense");
        return {
          entries: [{ accountName: acc.name, balanceDeltaCents: -intent.amountCents }],
          reason: `Expense of ${_fmt(intent.amountCents)} deducted from asset "${acc.name}"`,
        };
      }

      if (intent.source === SOURCE_LIABILITY) {
        const acc = _findAccount(accounts, intent.accountName);
        _assertCategory(acc, ACCOUNT_CATEGORY_LIABILITY, "SOURCE_LIABILITY expense");
        // Liability balance stored as positive owed amount; charging increases it
        return {
          entries: [{ accountName: acc.name, balanceDeltaCents: intent.amountCents }],
          reason: `Expense of ${_fmt(intent.amountCents)} charged to liability "${acc.name}" (balance increases)`,
        };
      }

      throw new Error(`computeAccountDelta: unknown source "${intent.source}" for TYPE_EXPENSE`);
    }

    case TYPE_TRANSFER: {
      const fromAcc = _findAccount(accounts, intent.fromAccountName);
      const toAcc   = _findAccount(accounts, intent.toAccountName);
      return {
        entries: [
          { accountName: fromAcc.name, balanceDeltaCents: -intent.amountCents },
          { accountName: toAcc.name,   balanceDeltaCents:  intent.amountCents },
        ],
        reason: `Transfer of ${_fmt(intent.amountCents)} from "${fromAcc.name}" to "${toAcc.name}"`,
      };
    }

    case TYPE_LIABILITY_PAYMENT: {
      const acc = _findAccount(accounts, intent.accountName);
      _assertCategory(acc, ACCOUNT_CATEGORY_LIABILITY, "liability payment");
      // Payment reduces what is owed → balance decreases
      return {
        entries: [{ accountName: acc.name, balanceDeltaCents: -intent.amountCents }],
        reason: `Liability payment of ${_fmt(intent.amountCents)} reduces balance of "${acc.name}"`,
      };
    }

    // Phase 3: assign/unassign never touch account balances — pure budget operation
    case "assign":
    case "unassign":
      return _noOp(`${intent.type} — no account balance change`);

    default:
      throw new Error(`computeAccountDelta: unknown intent type "${intent.type}"`);
  }
}

// ---------------------------------------------------------------------------
// applyAccountDeltaToRoot
// ---------------------------------------------------------------------------

/**
 * Applies an AccountDelta to the root-doc accounts array and returns a NEW
 * array (never mutates the original).
 *
 * The root-doc shape (relevant portion):
 * {
 *   accounts: Array<{
 *     name:     string,
 *     type:     string,
 *     balance:  number,   // float pesos
 *     ...other fields preserved verbatim
 *   }>
 * }
 *
 * @param {Array<Object>} accounts  — current accounts array from root doc
 * @param {AccountDelta}  delta
 * @returns {Array<Object>}  new accounts array with changes applied
 */
function applyAccountDeltaToRoot(accounts, delta) {
  if (!Array.isArray(accounts)) {
    throw new Error("applyAccountDeltaToRoot: accounts must be an array");
  }
  _requireDelta(delta);

  if (delta.entries.length === 0) return accounts.map(a => ({ ...a }));

  // Build a lookup of name → deltaCents for O(1) access
  const deltaMap = new Map(
    delta.entries.map(e => [e.accountName, e.balanceDeltaCents])
  );

  return accounts.map(acc => {
    const deltaCents = deltaMap.get(acc.name);
    if (deltaCents === undefined) return { ...acc };

    const currentCents = toCents(acc.balance || 0);
    const newCents     = currentCents + deltaCents;

    return {
      ...acc,
      balance: fromCents(newCents),
    };
  });
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Finds an account by name (case-insensitive).
 * Throws a descriptive error if not found — avoids silent no-ops.
 */
function _findAccount(accounts, name) {
  const normalised = name.trim().toLowerCase();
  const acc = accounts.find(a => (a.name || "").toLowerCase() === normalised);
  if (!acc) {
    throw new Error(
      `computeAccountDelta: account "${name}" not found. ` +
      `Available: ${accounts.map(a => a.name).join(", ") || "(none)"}`
    );
  }
  return acc;
}

/**
 * Asserts that an account belongs to the expected category ('asset' or 'liability').
 * Relies on ACCOUNT_TYPES being consistent with the account's .type field
 * (same convention as script.js's ACCOUNT_TYPES map).
 *
 * We don't import ACCOUNT_TYPES (it's defined in the browser global scope in
 * script.js) — instead we carry the resolved category on each account as
 * acc.category, OR we accept that callers may skip this check in Phase 1.
 *
 * For Phase 1, we do a best-effort guard: if the account has a `.category`
 * field we check it; otherwise we warn and continue so that existing data
 * (which may not have .category) doesn't break.
 */
function _assertCategory(acc, expectedCategory, context) {
  if (acc.category && acc.category !== expectedCategory) {
    throw new Error(
      `computeAccountDelta (${context}): account "${acc.name}" is category ` +
      `"${acc.category}" but expected "${expectedCategory}"`
    );
  }
  // If no .category field, skip the guard — Phase 2 will normalise this.
}

function _noOp(reason) {
  return { entries: [], reason };
}

function _requireIntent(intent) {
  if (!intent || typeof intent !== "object") {
    throw new Error("computeAccountDelta: intent must be a plain object");
  }
  if (!intent.type) {
    throw new Error("computeAccountDelta: intent.type is required");
  }
  if (typeof intent.amountCents !== "number" || intent.amountCents <= 0) {
    throw new Error("computeAccountDelta: intent.amountCents must be a positive number");
  }
}

function _requireDelta(delta) {
  if (!delta || !Array.isArray(delta.entries)) {
    throw new Error("applyAccountDeltaToRoot: delta.entries must be an array");
  }
}

function _fmt(cents) {
  return (cents / 100).toFixed(2);
}
