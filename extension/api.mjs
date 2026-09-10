import {READ_HOSTS, validId, readServerLock, lockPayload, parseFrame, positionEntries} from "./core.mjs";

const IDENTITY = "https://prod-identity.tradesea.ai";

export class TradeSeaApi {
  // Chrome's native worker fetch requires its WorkerGlobalScope receiver.
  // Calling an unbound copy as this.fetcher() supplies the API instance instead.
  constructor(fetcher = globalThis.fetch.bind(globalThis)) { this.fetcher = fetcher; }

  async request(url, method = "GET", body, step = "TradeSea request") {
    const response = await this.fetcher(url, {
      method, credentials: "include", cache: "no-store", redirect: "error",
      headers: {Accept: "application/json", ...(body ? {"Content-Type": "application/json"} : {})},
      ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new Error(`${step} failed (HTTP ${response.status}). TradeSea login or account access needs attention. Sign in normally in your TradeSea tab.`);
      throw new Error(`${step} failed: TradeSea returned HTTP ${response.status}.`);
    }
    const date = Date.parse(response.headers.get("date"));
    if (!Number.isFinite(date)) throw new Error(`${step} failed: TradeSea server time is unavailable.`);
    return {body: await response.json(), serverNow: date / 1000};
  }

  async accounts() {
    // Follow the active AccountsService -> NewAccountsCenterService path.
    // The obsolete /um/tv/v1/accounts service still exists in the app bundle
    // but its server route returns 404.
    const result = await this.request(`${IDENTITY}/eum/v1/accountsWithDetails`, "GET", undefined, "Account lookup");
    if (!["ok", "success"].includes(result.body?.s) || !Array.isArray(result.body.d)) {
      throw new Error("Could not recognize TradeSea's account list.");
    }
    const accounts = result.body.d.filter(a => a && ["string", "number"].includes(typeof a.id) && validId(String(a.id)) &&
      a.externalAccountId !== undefined && a.externalAccountId !== null && String(a.externalAccountId)).map(a => ({
        accountId: String(a.id), externalAccountId: String(a.externalAccountId),
        accountName: String(a.name || a.accountName || a.externalAccountId),
        accountType: String(a.accountType || ""),
        restricted: a.type === "locked",
        readHost: a.accountType === "RD" ? "api-trades-r-delprod.tradesea.ai" : "prod-trade-read.tradesea.ai",
        serverNow: result.serverNow
      }));
    return accounts;
  }

  async account(accountId, reference = {}) {
    const accounts = await this.accounts();
    // Once enrolled, pin the external account and environment. A refreshed
    // opaque request ID must never select a different trading account.
    const matches = reference.externalAccountId
      ? accounts.filter(a => a.externalAccountId === reference.externalAccountId &&
          (!reference.readHost || a.readHost === reference.readHost))
      : accounts.filter(a => a.accountId === accountId);
    if (matches.length > 1) throw new Error("Account lookup is ambiguous. Protection has not switched accounts.");
    const account = matches[0];
    if (!account) {
      throw new Error("The saved account is unavailable in this Chrome login. Protection has not switched accounts.");
    }
    return account;
  }

  async snapshot(state) {
    if (!READ_HOSTS.has(state.readHost)) throw new Error("Account connection has not been verified.");
    const result = await this.request(`https://${state.readHost}/v1/users/${encodeURIComponent(state.accountId)}/snapshot/unified?status=placing%2Cworking%2Cfilled%2Ccancelled%2Crejected`, "GET", undefined, "Position snapshot");
    let payload = result.body;
    try {
      if (payload?.event !== undefined) {
        if (payload.event !== "unifiedSnapshot") throw new Error("Not a complete snapshot");
        payload = typeof payload.data === "string" ? JSON.parse(payload.data) : payload.data ?? payload;
      }
      for (const body of [result.body, payload]) {
        if (!body || typeof body !== "object" || Array.isArray(body) || body.error ||
            [body.status, body.s].some(status => status !== undefined && !["ok", "success"].includes(status))) {
          throw new Error("Snapshot request did not succeed");
        }
      }
      const frame = parseFrame({event: "unifiedSnapshot", data: payload});
      const positions = positionEntries(frame, state.externalAccountId);
      return {...result, frame: {event: "unifiedSnapshot", positions}};
    } catch {
      throw new Error("TradeSea did not provide a complete position snapshot for this account.");
    }
  }

  async getLock(accountId) {
    const result = await this.request(`${IDENTITY}/eum/v1/prop-fund/${encodeURIComponent(accountId)}/lockout`, "GET", undefined, "Lockout check");
    return {remote: readServerLock(result.body), serverNow: result.serverNow};
  }

  async setLock(accountId, lock) {
    // Cookies are supplied by Chrome on EVERY request. No copied or cached token.
    const result = await this.request(`${IDENTITY}/eum/v1/prop-fund/${encodeURIComponent(accountId)}/lockout`, "PUT", lockPayload(lock), "Lockout request");
    if (!["ok", "success"].includes(result.body?.status)) throw new Error("TradeSea did not accept the lockout request.");
    // A PUT acknowledgement alone is insufficient; confirm the persisted deadline.
    return this.getLock(accountId);
  }
}
