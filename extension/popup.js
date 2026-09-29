const labels = {ready: "Monitoring", locked: "Account locked",
  error: "Protection needs attention", disconnected: "Live monitoring disconnected", starting: "Checking protection…",
  unselected: "Choose an account"};
const choice = document.getElementById("account-choice");
const protect = document.getElementById("protect-account");
const selectionMessage = document.getElementById("selection-message");
const automaticToggle = document.getElementById("automatic-enabled");
const automaticList = document.getElementById("automatic-accounts");
const automaticMessage = document.getElementById("automatic-message");
const riskToggle = document.getElementById("risk-lock-enabled");
const riskReconnect = document.getElementById("risk-reconnect");
let riskSelection = null;
let riskError = "";
let riskSelectionError = "";
let riskLoading = true;
let loadingRiskAccount = false;
const selectionPrompt = "Choose an unlocked account, then click Protect this account. Other accounts keep their lockouts.";
const fixedPrompt = "Finish the open trade before changing the protected account.";
let canSelect = false;
let busy = false;
let loaded = false;
let loadingAccounts = false;
let accounts = [];
let selectedAccountId = null;
let optionsSignature = "";
let automaticSignature = "";
let lastView = {};
let preferenceError = "";
let preferenceRevision = 0;

function sameAccount(a, b) {
  return a.accountId === b.accountId || (a.externalAccountId && a.externalAccountId === b.externalAccountId && a.readHost === b.readHost);
}

function renderRisk(view) {
  const state = view.riskSettings ?? {loading: true, locks: []};
  const lock = riskSelection && state.locks.find(item => item.accountIds.includes(riskSelection.accountId) || sameAccount(item, riskSelection));
  riskToggle.checked = !!lock;
  riskToggle.disabled = busy || !riskSelection || !!lock || !!state.loading || state.enforced === false;
  riskReconnect.hidden = !!riskSelection || riskLoading;
  riskReconnect.disabled = busy;
  document.getElementById("risk-lock-account").textContent = riskSelection ? `Current account: ${riskSelection.accountName}`
    : riskLoading ? "Connecting to the account in your TradeSea tab…" : riskSelectionError || "Open TradeSea, then reconnect below.";
  const message = lock ? "Permanently locked. No expiry. This account's risk-settings lock cannot be switched off."
    : "Save your risk settings in TradeSea first. Once enabled, this account's risk-settings lock is permanent and cannot be switched off.";
  document.getElementById("risk-lock-message").textContent = riskError || state.error || (busy ? "Saving…" : message);
  const others = state.locks.filter(item => item !== lock);
  const list = document.getElementById("risk-other-locks");
  list.hidden = !others.length;
  list.replaceChildren();
  for (const item of others) {
    const row = document.createElement("li");
    row.textContent = `${item.accountName} · risk settings permanently locked`;
    list.append(row);
  }
}

function renderAutomatic(view) {
  const automatic = view.automatic ?? {enabled: false, accounts: []};
  automaticToggle.checked = automatic.enabled;
  automaticToggle.disabled = busy || (!automatic.enabled && (!loaded || !automatic.accounts.length));
  const listed = [...accounts, ...automatic.accounts.filter(saved => !accounts.some(account => sameAccount(account, saved)))];
  const rows = listed.map(account => {
    const saved = automatic.accounts.find(item => sameAccount(account, item));
    const lock = (view.lockouts ?? []).find(item => sameAccount(account, item));
    const locked = !!lock || account.lockStatus === "locked";
    const end = lock?.end ?? account.end;
    const open = saved?.openQuantity > 0;
    const unavailable = account.lockStatus === "unknown" || !accounts.some(item => sameAccount(account, item));
    return {accountId: saved?.accountId ?? account.accountId, name: account.accountName, checked: !!saved,
      disabled: busy || !loaded || locked || open || unavailable || account.lockStatus === "scheduled",
      status: locked && end ? `Locked until ${new Date(end * 1000).toLocaleString()}`
        : open ? "Open trade · locks when flat"
        : unavailable ? "Status unavailable"
        : account.lockStatus === "scheduled" ? "Scheduled lockout"
        : saved && automatic.enabled ? (saved.status === "disconnected" ? "Open a TradeSea tab for live monitoring"
          : saved.status === "error" ? saved.message : labels[saved.status] || "Checking protection…")
        : saved ? "Selected · automatic protection off" : "Not selected"};
  });
  const signature = JSON.stringify(rows);
  if (signature !== automaticSignature) {
    automaticSignature = signature;
    automaticList.replaceChildren();
    for (const row of rows) {
      const label = document.createElement("label");
      label.className = "auto-account";
      label.dataset.disabled = String(row.disabled);
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = row.checked;
      input.disabled = row.disabled;
      input.addEventListener("change", () => saveAutomatic({type: "setAutomaticAccount", accountId: row.accountId, checked: input.checked}));
      const name = document.createElement("span");
      name.textContent = row.name;
      const detail = document.createElement("small");
      detail.textContent = row.status;
      name.append(detail);
      label.append(input);
      label.append(name);
      automaticList.append(label);
    }
  }
  automaticMessage.textContent = preferenceError || (busy ? "Saving…" : automatic.enabled
    ? "On · your checked accounts are protected automatically."
    : automatic.accounts.length ? "Choices saved. Turn on automatic protection when ready." : "Check one or more accounts, then turn on the toggle.");
}

async function saveAutomatic(message) {
  if (busy) return;
  busy = true;
  preferenceRevision++;
  preferenceError = "";
  render(lastView);
  try {
    const view = await chrome.runtime.sendMessage(message);
    preferenceError = view.preferenceError || "";
    busy = false;
    render(view);
  } catch {
    busy = false;
    preferenceError = "Could not save your choices. Check the extension connection and try again.";
    render(lastView);
  }
}

function renderChoices(view) {
  const locks = view.lockouts ?? [];
  const choices = accounts.map(account => {
    const lock = locks.find(item => sameAccount(account, item));
    return lock ? {...account, end: lock.end, selectable: false, lockStatus: "locked"} : account;
  });
  const signature = JSON.stringify(choices);
  if (signature === optionsSignature) return;
  optionsSignature = signature;
  const previous = choice.value;
  choice.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose an account";
  choice.append(placeholder);
  const states = {scheduled: "Scheduled lockout", unknown: "Status unavailable"};
  for (const account of choices) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.disabled = account.selectable !== true;
    const status = account.lockStatus === "locked" && account.end
      ? `Locked until ${new Date(account.end * 1000).toLocaleString()}` : states[account.lockStatus];
    option.textContent = account.accountName + (status ? ` · ${status}` : "") +
      (account.accountId === selectedAccountId ? " · selected in TradeSea" : "");
    choice.append(option);
  }
  const preferred = [previous, selectedAccountId, view.accountId].find(id => choices.some(account => account.accountId === id && account.selectable));
  choice.value = preferred || choices.find(account => account.selectable)?.accountId || view.accountId || "";
}

function render(view) {
  lastView = view;
  renderRisk(view);
  renderAutomatic(view);
  const status = document.getElementById("status");
  status.textContent = labels[view.status] || "Protection needs attention";
  status.dataset.state = view.status;
  document.getElementById("message").textContent = view.message;
  document.getElementById("account").textContent = view.accountName || "Choose an account below";
  document.getElementById("account-label").textContent = view.automatic?.enabled ? "Protected accounts" : "Protected account";
  document.getElementById("lockout-summary").hidden = view.automatic?.enabled === true;
  document.getElementById("manual-protection").hidden = view.automatic?.enabled === true;
  document.getElementById("end").textContent = view.end ? new Date(view.end * 1000).toLocaleString() : "—";
  renderChoices(view);
  const others = (view.lockouts ?? []).filter(lock => !lock.selected &&
    (!view.automatic?.enabled || !view.automatic.accounts.some(account => sameAccount(account, lock))));
  document.getElementById("other-lockouts").hidden = others.length === 0;
  document.getElementById("other-lockouts-label").textContent = `Other locked accounts (${others.length})`;
  const list = document.getElementById("other-lockouts-list");
  list.replaceChildren();
  for (const lock of others) {
    const item = document.createElement("li");
    item.textContent = `${lock.accountName} · until ${new Date(lock.end * 1000).toLocaleString()}`;
    list.append(item);
  }
  canSelect = view.canSelect === true;
  choice.disabled = busy || !loaded || !canSelect;
  protect.disabled = choice.disabled || !choice.value || choice.selectedOptions[0]?.disabled;
  if (view.automatic?.enabled) selectionMessage.textContent = "Automatic protection is on. Use the account checkboxes above.";
  else if (!canSelect && view.openQuantity > 0) {
    if ([...choice.options].some(option => option.value === view.accountId)) choice.value = view.accountId;
    selectionMessage.textContent = fixedPrompt;
  } else if (selectionMessage.textContent === fixedPrompt || selectionMessage.textContent.startsWith("Automatic protection is on.")) selectionMessage.textContent = selectionPrompt;
}

async function loadAccounts() {
  if (busy || loadingAccounts) return;
  loadingAccounts = true;
  const revision = preferenceRevision;
  try {
    const result = await chrome.runtime.sendMessage({type: "selection"});
    if (revision !== preferenceRevision) return;
    if (!Array.isArray(result.accounts)) throw new Error(result.message || "Could not load your TradeSea accounts.");
    accounts = result.accounts;
    selectedAccountId = result.selectedAccountId;
    optionsSignature = "";
    if (!loaded) selectionMessage.textContent = accounts.length ? selectionPrompt : "No supported accounts are available in this Chrome login.";
    loaded = true;
    render(result.view);
  } catch (error) {
    loaded = false;
    choice.disabled = protect.disabled = true;
    selectionMessage.textContent = error.message;
    renderAutomatic(lastView);
    renderRisk(lastView);
  } finally { loadingAccounts = false; }
}

async function loadRiskAccount() {
  if (busy || loadingRiskAccount) return;
  loadingRiskAccount = true;
  const revision = preferenceRevision;
  try {
    const result = await chrome.runtime.sendMessage({type: "riskSelection"});
    if (revision !== preferenceRevision) return;
    if (riskSelection?.accountId !== result.riskSelection?.accountId) riskError = "";
    riskSelection = result.riskSelection ?? null;
    riskSelectionError = result.riskSelectionError || "";
  } catch {
    riskSelection = null;
    riskSelectionError = "The extension connection was interrupted. Reload this popup and reconnect TradeSea.";
  } finally {
    loadingRiskAccount = false;
    riskLoading = false;
    renderRisk(lastView);
  }
}

async function refresh() {
  if (busy) return;
  const revision = preferenceRevision;
  try {
    const view = await chrome.runtime.sendMessage({type: "status"});
    if (!busy && revision === preferenceRevision) render(view);
  } catch {
    document.getElementById("status").textContent = "Protection is unavailable";
    document.getElementById("status").dataset.state = "error";
    document.getElementById("message").textContent = "Reload the TradeSea tab and check protection before trading.";
    canSelect = false;
    choice.disabled = protect.disabled = true;
    riskToggle.disabled = true;
  }
}

choice.addEventListener("change", () => { protect.disabled = busy || !canSelect || !choice.value || choice.selectedOptions[0]?.disabled; });
automaticToggle.addEventListener("change", () => saveAutomatic({type: "setAutomaticEnabled", enabled: automaticToggle.checked}));
riskReconnect.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  riskError = "";
  renderRisk(lastView);
  try {
    const result = await chrome.runtime.sendMessage({type: "reconnectRiskTab"});
    riskSelectionError = result.riskSelectionError || "TradeSea is refreshing. Its selected account will connect automatically.";
  } catch { riskSelectionError = "Could not reconnect. Refresh the TradeSea tab, then reopen this popup."; }
  busy = false;
  renderRisk(lastView);
});
riskToggle.addEventListener("change", async () => {
  if (busy || riskToggle.disabled || !riskSelection) return;
  const enabled = riskToggle.checked;
  busy = true;
  preferenceRevision++;
  riskError = "";
  render(lastView);
  try {
    const view = await chrome.runtime.sendMessage({type: "setRiskLock", enabled, accountId: riskSelection.accountId, tabId: riskSelection.tabId});
    riskError = view.riskError || "";
    busy = false;
    render(view);
  } catch {
    busy = false;
    riskError = "Could not verify the risk lock. Reload the popup and check its status.";
    render(lastView);
  }
});
protect.addEventListener("click", async () => {
  if (!canSelect || busy || !choice.value || choice.selectedOptions[0]?.disabled) return;
  busy = true;
  choice.disabled = protect.disabled = true;
  selectionMessage.textContent = "Verifying this account, its open positions, and any lockout…";
  try {
    const view = await chrome.runtime.sendMessage({type: "selectAccount", accountId: choice.value});
    busy = false;
    selectionMessage.textContent = view.selectionError
      ? `${view.accountId === choice.value ? "Protection needs attention." : "Account selection was not saved."} ${view.selectionError}`
      : view.status === "error" ? view.message : "Protected account saved.";
    render(view);
  } catch (error) {
    busy = false;
    selectionMessage.textContent = error.message;
    await refresh();
  }
});
void loadAccounts();
void loadRiskAccount();
void refresh();
setInterval(refresh, 1000);
setInterval(loadAccounts, 15000);
setInterval(loadRiskAccount, 5000);
