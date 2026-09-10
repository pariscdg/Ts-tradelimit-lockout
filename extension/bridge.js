(() => {
  "use strict";
  const CHANNEL = "tradesea-one-trade-v2";
  let alive = false;
  let notice;
  let sending = Promise.resolve();
  const show = view => {
    const warning = ["error", "pending", "disconnected"].includes(view?.status);
    if (!warning) { notice?.remove(); notice = null; return; }
    if (!document.documentElement) return;
    if (!notice) {
      notice = document.createElement("div");
      notice.setAttribute("role", "status");
      const root = notice.attachShadow({mode: "closed"});
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;bottom:16px;left:16px;z-index:2147483647;max-width:350px;padding:12px 16px;background:#34210b;color:#fff1ce;border:1px solid #dba84d;border-radius:10px;font:13px/1.5 system-ui;box-shadow:0 3px 20px #0004;pointer-events:none";
      root.append(box);
      notice.update = text => { box.textContent = text; };
      document.documentElement.append(notice);
    }
    notice.update(`TradeSea One Trade: ${view.message}`);
  };
  const send = message => {
    sending = sending.then(async () => {
      try { show(await chrome.runtime.sendMessage(message)); }
      catch { show({status: "error", message: "Protection is disconnected. Reload this tab before trading."}); }
    });
  };
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== CHANNEL) return;
    const message = event.data;
    if (message.kind === "alive") { alive = true; return; }
    if (["frame", "connection", "fault", "selectedAccount"].includes(message.kind)) send({type: "observe", event: message});
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === "status") show(message.view);
  });
  const heartbeat = () => {
    window.postMessage({channel: CHANNEL, kind: "probe"}, location.origin);
    send({type: "heartbeat", alive});
  };
  setTimeout(heartbeat, 100);
  setInterval(heartbeat, 10000);
})();
