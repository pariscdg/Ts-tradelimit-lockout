(() => {
  "use strict";
  const CHANNEL = "tradesea-one-trade-v2";
  let locked = new Set();
  const batchEndpoint = (url, method) => {
    try {
      const parsed = new URL(url, location.href);
      return ["POST", "PUT", "PATCH", "DELETE"].includes(String(method).toUpperCase()) &&
        ["https://prod-trade-write.tradesea.ai", "https://api-trades-w-delprod.tradesea.ai"].includes(parsed.origin) &&
        parsed.pathname.replace(/\/$/, "") === "/v1/internal/accounts/riskSettings/enabled";
    } catch { return false; }
  };
  const affectsLocked = body => {
    if (!locked.size) return false;
    try {
      if (typeof body !== "string") return true;
      const data = JSON.parse(body);
      if (!data || typeof data !== "object") return true;
      return ["enable_account_ids", "disable_account_ids"].some(key => {
        const ids = data[key];
        return ids !== undefined && (!Array.isArray(ids) || ids.some(id => locked.has(String(id))));
      });
    } catch { return true; }
  };
  window.addEventListener("message", event => {
    if (event.source === window && event.origin === location.origin && event.data?.channel === CHANNEL &&
        event.data.kind === "risk-policy" && Array.isArray(event.data.accountIds)) {
      locked = new Set(event.data.accountIds.filter(id => typeof id === "string"));
    }
  });
  // The batch route carries account IDs in its body, which a declarative URL
  // rule cannot scope. Only batches affecting a locked account are rejected.
  // Per-account daily limits and brackets also have persistent browser rules.
  const nativeFetch = window.fetch;
  if (nativeFetch) window.fetch = async function (input, options) {
    const request = typeof Request !== "undefined" && input instanceof Request;
    const url = request ? input.url : String(input);
    const method = options?.method ?? (request ? input.method : "GET");
    if (locked.size && batchEndpoint(url, method)) {
      const body = options?.body ?? (request ? await input.clone().text() : undefined);
      if (affectsLocked(body)) throw new TypeError("This account's risk settings are locked.");
    }
    return Reflect.apply(nativeFetch, window, arguments);
  };
  if (window.XMLHttpRequest) {
    const prototype = window.XMLHttpRequest.prototype;
    const nativeOpen = prototype.open;
    const nativeSend = prototype.send;
    const requests = new WeakMap();
    prototype.open = function (method, url) {
      requests.set(this, {method, url});
      return Reflect.apply(nativeOpen, this, arguments);
    };
    prototype.send = function (body) {
      const request = requests.get(this);
      if (request && batchEndpoint(request.url, request.method) && affectsLocked(body)) {
        throw new DOMException("This account's risk settings are locked.", "InvalidStateError");
      }
      return Reflect.apply(nativeSend, this, arguments);
    };
  }
})();
