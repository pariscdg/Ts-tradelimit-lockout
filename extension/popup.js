const labels = {ready: "Monitoring", locked: "Account lockout confirmed", pending: "Lockout awaiting confirmation",
  error: "Protection needs attention", disconnected: "Live monitoring disconnected", starting: "Checking protection…",
  unselected: "Choose an account"};
const choice = document.getElementById("account-choice");
const protect = document.getElementById("protect-account");
const selectionMessage = document.getElementById("selection-message");
const selectionPrompt = "Choose an unlocked account, then click Protect this account. Other accounts keep their lockouts.";
const fixedPrompt = "Finish the open trade before changing the protected account.";
let canSelect = false;
let busy = false;
let loaded = false;
let loadingAccounts = false;
let accounts = [];
let selectedAccountId = null;
let optionsSignature = "";

function renderChoices(view) {
  const locks = view.lockouts ?? [];
  const choices = accounts.map(account => {
    const lock = locks.find(item => item.accountId === account.accountId ||
      (item.externalAccountId === account.externalAccountId && item.readHost === account.readHost));
    return lock ? {...account, selectable: false, lockStatus: lock.confirmed ? "locked" : "pending"} : account;
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
  const states = {locked: "Locked", pending: "Locked · confirmation pending", scheduled: "Scheduled lockout", unknown: "Status unavailable"};
  for (const account of choices) {
    const option = document.createElement("option");
    option.value = account.accountId;
    option.disabled = account.selectable !== true;
    option.textContent = account.accountName + (account.accountName !== account.externalAccountId ? ` (${account.externalAccountId})` : "") +
      (states[account.lockStatus] ? ` · ${states[account.lockStatus]}` : "") +
      (account.accountId === selectedAccountId ? " · selected in TradeSea" : "");
    choice.append(option);
  }
  const preferred = [previous, selectedAccountId, view.accountId].find(id => choices.some(account => account.accountId === id && account.selectable));
  choice.value = preferred || choices.find(account => account.selectable)?.accountId || view.accountId || "";
}

function render(view) {
  const status = document.getElementById("status");
  status.textContent = labels[view.status] || "Protection needs attention";
  status.dataset.state = view.status;
  document.getElementById("message").textContent = view.message;
  document.getElementById("account").textContent = view.accountName || "Choose an account below";
  document.getElementById("end").textContent = view.end ? new Date(view.end * 1000).toLocaleString() : "—";
  renderChoices(view);
  const others = (view.lockouts ?? []).filter(lock => !lock.selected);
  document.getElementById("other-lockouts").hidden = others.length === 0;
  document.getElementById("other-lockouts-label").textContent = `Other locked accounts (${others.length})`;
  const list = document.getElementById("other-lockouts-list");
  list.replaceChildren();
  for (const lock of others) {
    const item = document.createElement("li");
    item.textContent = `${lock.accountName} · until ${new Date(lock.end * 1000).toLocaleString()}${lock.confirmed ? "" : " · confirmation pending"}`;
    list.append(item);
  }
  canSelect = view.canSelect === true;
  choice.disabled = busy || !loaded || !canSelect;
  protect.disabled = choice.disabled || !choice.value || choice.selectedOptions[0]?.disabled;
  if (!canSelect && view.openQuantity > 0) {
    if ([...choice.options].some(option => option.value === view.accountId)) choice.value = view.accountId;
    selectionMessage.textContent = fixedPrompt;
  } else if (selectionMessage.textContent === fixedPrompt) selectionMessage.textContent = selectionPrompt;
}

async function loadAccounts() {
  if (busy || loadingAccounts) return;
  loadingAccounts = true;
  try {
    const result = await chrome.runtime.sendMessage({type: "selection"});
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
  } finally { loadingAccounts = false; }
}

async function refresh() {
  if (busy) return;
  try {
    render(await chrome.runtime.sendMessage({type: "status"}));
  } catch {
    document.getElementById("status").textContent = "Protection is unavailable";
    document.getElementById("status").dataset.state = "error";
    document.getElementById("message").textContent = "Reload the TradeSea tab and check protection before trading.";
    canSelect = false;
    choice.disabled = protect.disabled = true;
  }
}

choice.addEventListener("change", () => { protect.disabled = busy || !canSelect || !choice.value || choice.selectedOptions[0]?.disabled; });
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
void refresh();
setInterval(refresh, 1000);
setInterval(loadAccounts, 15000);
