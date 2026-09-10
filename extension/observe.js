(() => {
  "use strict";
  const CHANNEL = "tradesea-one-trade-v2";
  const post = window.postMessage.bind(window);
  const add = EventTarget.prototype.addEventListener;
  const streams = new Map();
  const emit = data => post({channel: CHANNEL, ...data}, location.origin);
  const selectedAccount = () => {
    try { emit({kind: "selectedAccount", accountId: window.sessionStorage.getItem("profit_selected_account")}); }
    catch { emit({kind: "selectedAccount", accountId: null}); }
  };
  const validSocket = value => {
    try {
      const u = new URL(value);
      return u.protocol === "wss:" &&
        ["prod-trade-read.tradesea.ai", "api-trades-r-delprod.tradesea.ai"].includes(u.hostname) &&
        /^\/v1\/users\/[A-Za-z0-9_-]+\/ws\/unified$/.test(u.pathname);
    } catch { return false; }
  };
  const frame = (id, payload) => {
    try {
      const data = typeof payload === "string" ? JSON.parse(payload) : payload;
      if (["unifiedSnapshot", "positionUpdates"].includes(data?.event)) {
        // Send positions and the identities covered by a full snapshot. Account
        // balances, order history, cookies and tokens stay in the TradeSea page.
        const body = typeof data.data === "string" ? JSON.parse(data.data) : data.data ?? data;
        const accounts = body?.userFullStates?.accounts;
        const snapshotAccountIds = data.event === "unifiedSnapshot" && accounts &&
          typeof accounts === "object" && !Array.isArray(accounts)
          ? Object.entries(accounts).filter(([id, summary]) => id && summary &&
              ["balance", "realizedPl", "commission"].every(field => Number.isFinite(summary[field]))).map(([id]) => id)
          : [];
        emit({kind: "frame", streamId: id, frame: {event: data.event,
          data: {positions: body?.positions, ...(data.event === "unifiedSnapshot" ? {snapshotAccountIds} : {})}}});
      }
    } catch { emit({kind: "fault", message: "Could not read a TradeSea position message."}); }
  };
  const connection = (id, url, connected) => {
    streams.set(id, {url, connected});
    emit({kind: "connection", streamId: id, url, connected});
  };

  // Observe the worker boundary without modifying or recreating the worker's
  // WebSocket. This supports TradeSea's current tradingSocketWorker protocol.
  if (window.Worker) {
    const NativeWorker = window.Worker;
    window.Worker = new Proxy(NativeWorker, {construct(Target, args, newTarget) {
      const worker = Reflect.construct(Target, args, newTarget);
      let url = null;
      const id = crypto.randomUUID();
      const nativePost = worker.postMessage;
      const nativeTerminate = worker.terminate;
      worker.postMessage = function (...postArgs) {
        const message = postArgs[0];
        const result = Reflect.apply(nativePost, this, postArgs);
        if (message?.type === "connect" && validSocket(message.payload?.websocketUrl)) {
          url = message.payload.websocketUrl;
          connection(id, url, false);
        } else if (url && message?.type === "disconnect") connection(id, url, false);
        return result;
      };
      worker.terminate = function (...terminateArgs) {
        const result = Reflect.apply(nativeTerminate, this, terminateArgs);
        if (url) connection(id, url, false);
        streams.delete(id);
        return result;
      };
      add.call(worker, "message", event => {
        if (!url) return;
        const message = event.data;
        if (message?.type === "connected") connection(id, url, true);
        if (["disconnected", "reconnecting", "error"].includes(message?.type)) connection(id, url, false);
        if (message?.type === "message") {
          connection(id, url, true);
          frame(id, message.payload);
        }
      });
      return worker;
    }});
  }

  // Also support the earlier application version's page-owned WebSocket.
  if (window.WebSocket) {
    const NativeSocket = window.WebSocket;
    window.WebSocket = new Proxy(NativeSocket, {construct(Target, args, newTarget) {
      const socket = Reflect.construct(Target, args, newTarget);
      if (validSocket(socket.url)) {
        const id = crypto.randomUUID();
        connection(id, socket.url, false);
        add.call(socket, "open", () => connection(id, socket.url, true));
        add.call(socket, "close", () => { connection(id, socket.url, false); streams.delete(id); });
        add.call(socket, "error", () => connection(id, socket.url, false));
        let decodeQueue = Promise.resolve();
        add.call(socket, "message", event => {
          decodeQueue = decodeQueue.then(async () => {
            const data = event.data instanceof Blob ? await event.data.text()
              : event.data instanceof ArrayBuffer ? new TextDecoder().decode(event.data) : event.data;
            frame(id, data);
          }).catch(() => emit({kind: "fault", message: "Could not decode a TradeSea position message."}));
        });
      }
      return socket;
    }});
  }
  add.call(window, "message", event => {
    if (event.source === window && event.origin === location.origin &&
        event.data?.channel === CHANNEL && event.data.kind === "probe") {
      emit({kind: "alive"});
      selectedAccount();
      for (const [id, stream] of streams) connection(id, stream.url, stream.connected);
    }
  });
  emit({kind: "alive"});
  selectedAccount();
})();
