(() => {
  "use strict";
  let policy = {loading: true, locks: []};
  let accountId = null;
  let scheduled = false;
  const lockedPanels = new Map();
  const text = element => element.textContent.trim();
  const reason = () => {
    if (policy.loading || (!accountId && policy.locks.length)) return "Checking this account's risk-settings lock…";
    const lock = policy.locks.find(item => item.accountIds.includes(accountId));
    return lock ? "Risk settings permanently locked. This account's saved settings cannot be changed. No expiry."
      : policy.error && !policy.locks.length ? "Risk-lock status is unavailable. Reconnect the extension before changing risk settings." : null;
  };
  const findPanels = () => {
    const result = [];
    for (const dialog of document.querySelectorAll('[role="dialog"]')) {
      if (!dialog.querySelector('button[aria-label="Risk Settings"]')) continue;
      const label = [...dialog.querySelectorAll("span,label")].find(element => text(element) === "Personal Daily Loss Limit (PDLL) - in $");
      if (!label) continue;
      let panel = label.parentElement;
      while (panel && panel !== dialog) {
        const buttons = [...panel.querySelectorAll("button")].map(text);
        if (buttons.includes("CLEAR") && buttons.includes("SAVE")) { result.push(panel); break; }
        panel = panel.parentElement;
      }
    }
    return result;
  };
  const restore = (panel, saved) => {
    panel.inert = saved.inert;
    panel.style.opacity = saved.opacity;
    if (saved.aria === null) panel.removeAttribute("aria-disabled");
    else panel.setAttribute("aria-disabled", saved.aria);
    saved.notice.remove();
    lockedPanels.delete(panel);
  };
  const apply = () => {
    scheduled = false;
    const message = reason();
    const panels = message ? findPanels() : [];
    for (const [panel, saved] of lockedPanels) if (!panels.includes(panel)) restore(panel, saved);
    for (const panel of panels) {
      let saved = lockedPanels.get(panel);
      if (!saved) {
        const notice = document.createElement("div");
        notice.setAttribute("role", "status");
        notice.style.cssText = "padding:12px 16px;margin:0 0 12px;border:1px solid #637b72;border-radius:8px;background:#20342c;color:#e1eee7;font:13px/1.5 system-ui";
        saved = {inert: panel.inert, opacity: panel.style.opacity, aria: panel.getAttribute("aria-disabled"), notice};
        lockedPanels.set(panel, saved);
      }
      if (saved.notice.textContent !== message) saved.notice.textContent = message;
      const tabs = panel.closest('[role="dialog"]').querySelector('button[aria-label="Risk Settings"]').parentElement;
      if (saved.notice.previousSibling !== tabs) tabs.after(saved.notice);
      if (!panel.inert) panel.inert = true;
      if (panel.style.opacity !== "0.45") panel.style.opacity = "0.45";
      if (panel.getAttribute("aria-disabled") !== "true") panel.setAttribute("aria-disabled", "true");
    }
  };
  const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(apply); } };
  const observer = new MutationObserver(schedule);
  observer.observe(document, {childList: true, subtree: true, attributes: true, attributeFilter: ["inert", "style", "aria-disabled"]});
  for (const type of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"]) {
    document.addEventListener(type, event => {
      if (!reason()) return;
      if ([...lockedPanels.keys()].some(panel => panel.contains(event.target))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    }, true);
  }
  globalThis.tradeSeaRiskPanel = {update(nextPolicy, selectedAccountId) {
    if (nextPolicy && Array.isArray(nextPolicy.locks)) policy = nextPolicy;
    accountId = selectedAccountId;
    apply();
  }};
  schedule();
})();
