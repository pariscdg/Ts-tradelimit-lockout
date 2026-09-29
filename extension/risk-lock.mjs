import {READ_HOSTS, validId} from "./core.mjs";

const LEGACY_RISK_LOCK_SECONDS = 23 * 60 * 60;
const easternHour = new Intl.DateTimeFormat("en-US", {timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23"});
// Used only to validate timed records from earlier releases before migration.
function nextRiskDeadline(serverNow) {
  if (!Number.isFinite(serverNow) || serverNow <= 0) throw new Error("TradeSea server time is unavailable.");
  const hour = Math.floor(serverNow / 3600) * 3600;
  for (let offset = 1; offset <= 26; offset++) {
    const candidate = hour + offset * 3600;
    if (easternHour.format(new Date(candidate * 1000)) === "17") return candidate;
  }
  throw new Error("Could not calculate the next 5 p.m. Eastern deadline.");
}
export const RISK_RULE_BASE = 1000000000;
const RISK_RULE_END = 1100000000;
const sameIdentity = (lock, account) => lock.externalAccountId === account.externalAccountId && lock.readHost === account.readHost;
export const isRiskRule = rule => rule.id >= RISK_RULE_BASE && rule.id < RISK_RULE_END;

function validateLedger(value, version) {
  if (!value || value.version !== version || !Number.isInteger(value.nextId) || value.nextId < 1 || value.nextId > 1000000 || !Array.isArray(value.locks)) {
    throw new Error("Saved risk-setting locks are invalid. Existing browser restrictions have been retained.");
  }
  const ids = new Set();
  const identities = new Set();
  for (const lock of value.locks) {
    if (!lock || typeof lock !== "object") throw new Error("Saved risk-setting locks are invalid. Existing browser restrictions have been retained.");
    const identity = JSON.stringify([lock.externalAccountId, lock.readHost]);
    const validTerm = version === 2 ? lock.permanent === true && lock.end === null && lock.schedule === undefined
      : Number.isInteger(lock.end) && (lock.schedule === "eastern-1700" ? lock.end === nextRiskDeadline(lock.start)
        : lock.schedule === undefined && lock.end - lock.start >= LEGACY_RISK_LOCK_SECONDS);
    if (!Number.isInteger(lock.id) || lock.id < 1 || lock.id >= value.nextId || ids.has(lock.id) || identities.has(identity) ||
        typeof lock.externalAccountId !== "string" || !lock.externalAccountId || !READ_HOSTS.has(lock.readHost) ||
        typeof lock.accountName !== "string" || !Array.isArray(lock.accountIds) || !lock.accountIds.length || lock.accountIds.length > 32 ||
        lock.accountIds.some(id => !validId(id)) || new Set(lock.accountIds).size !== lock.accountIds.length ||
        !Number.isInteger(lock.start) || lock.start <= 0 || !validTerm ||
        !Number.isFinite(lock.serverTimeFloor) || lock.serverTimeFloor < lock.start - 1) {
      throw new Error("Saved risk-setting locks are invalid. Existing browser restrictions have been retained.");
    }
    ids.add(lock.id);
    identities.add(identity);
  }
  return value;
}

export const validateRiskLedger = value => validateLedger(value, 2);

function migrateLedger(value) {
  validateLedger(value, 1);
  return {version: 2, nextId: value.nextId, locks: value.locks.map(({schedule, end, ...lock}) =>
    ({...lock, permanent: true, end: null}))};
}

export function riskRules(locks) {
  return locks.flatMap(lock => lock.accountIds.flatMap((accountId, index) => {
    const writeHost = lock.readHost === "api-trades-r-delprod.tradesea.ai" ? "api-trades-w-delprod.tradesea.ai" : "prod-trade-write.tradesea.ai";
    return [
      `https://prod-identity.tradesea.ai/eum/v1/prop-fund/${accountId}/risk-limits`,
      `https://${writeHost}/v1/internal/accounts/${accountId}/riskSettings`
    ].map((url, offset) => ({id: RISK_RULE_BASE + lock.id * 100 + index * 2 + offset, priority: 1,
      action: {type: "block"}, condition: {urlFilter: `|${url}^`, requestMethods: ["post", "put", "patch", "delete"]}}));
  }));
}

// Permanent per-account locks are independent of timed one-trade lockouts.
// Refresh can add account ID aliases, but never releases a saved risk lock.
export class RiskSettingsLock {
  constructor({storage, api, rules, monotonic = () => performance.now()}) {
    Object.assign(this, {storage, api, rules, monotonic});
    this.ledger = null;
    this.tail = Promise.resolve();
    this.lastRefresh = -Infinity;
    this.error = null;
    this.rulesReady = false;
    this.hadLedger = false;
  }

  run(action) {
    const job = this.tail.then(async () => {
      try {
        if (!this.ledger) {
          const saved = await this.storage.load();
          this.hadLedger = saved !== undefined;
          // Commit the migration before touching persistent browser rules. A
          // failed save leaves ledger null so the next request retries safely.
          if (saved?.version === 1) await this.save(migrateLedger(saved));
          else this.ledger = saved === undefined ? {version: 2, nextId: 1, locks: []} : validateRiskLedger(saved);
          // Dynamic browser rules remain installed while the worker is asleep.
          await this.installRules();
        }
        return await action();
      } catch (error) { this.error = error.message; throw error; }
    });
    this.tail = job.catch(() => {});
    return job;
  }

  async save(ledger) {
    validateRiskLedger(ledger);
    await this.storage.save(structuredClone(ledger));
    this.ledger = ledger;
    this.hadLedger = true;
  }

  async installRules() {
    this.rulesReady = false;
    await this.rules(riskRules(this.ledger.locks));
    this.rulesReady = true;
  }

  view() {
    return {error: this.error, enforced: this.rulesReady, locks: (this.ledger?.locks ?? []).map(lock => ({
      accountIds: [...lock.accountIds], externalAccountId: lock.externalAccountId, readHost: lock.readHost,
      accountName: lock.accountName, start: lock.start, end: null, permanent: true
    }))};
  }

  enable(accountId) {
    return this.run(async () => {
      if (!validId(accountId)) throw new Error("Select a TradeSea account first.");
      const account = await this.api.account(accountId);
      const existing = this.ledger.locks.find(lock => sameIdentity(lock, account));
      if (existing) {
        if (!existing.accountIds.includes(account.accountId)) {
          await this.save({...this.ledger, locks: this.ledger.locks.map(lock => lock === existing
            ? {...lock, accountIds: [...lock.accountIds, account.accountId]} : lock)});
        }
        await this.installRules();
        this.error = null;
        return this.view();
      }
      const result = await this.api.riskSettings(account.accountId);
      if (!Number.isFinite(result.serverNow) || result.serverNow <= 0 || result.serverNow < account.serverNow) {
        throw new Error("TradeSea server time is unavailable. The risk lock was not started.");
      }
      const start = Math.ceil(result.serverNow);
      const lock = {id: this.ledger.nextId, accountIds: [account.accountId], externalAccountId: account.externalAccountId,
        readHost: account.readHost, accountName: account.accountName, start, permanent: true, end: null,
        serverTimeFloor: result.serverNow};
      await this.save({...this.ledger, nextId: lock.id + 1, locks: [...this.ledger.locks, lock]});
      await this.installRules();
      this.error = null;
      return this.view();
    });
  }

  disable(accountId) {
    return this.run(async () => {
      const lock = this.ledger.locks.find(item => item.accountIds.includes(accountId));
      if (lock) throw new Error("This account's risk settings are permanently locked and cannot be unlocked.");
      return this.view();
    });
  }

  refresh(force = false) {
    return this.run(async () => {
      if (!this.rulesReady) await this.installRules();
      if (!this.ledger.locks.length || (!force && this.monotonic() - this.lastRefresh < 30000)) return this.view();
      this.lastRefresh = this.monotonic();
      const accounts = await this.api.accounts();
      const nextLocks = [];
      let error = null;
      for (const lock of this.ledger.locks) {
        const matches = accounts.filter(account => sameIdentity(lock, account));
        const account = matches.length === 1 ? matches[0] : null;
        if (!account || !Number.isFinite(account.serverNow) || account.serverNow < lock.serverTimeFloor) {
          nextLocks.push(lock);
          error = "Reconnect this account to TradeSea to update its account connection. Its existing lock remains in place.";
          continue;
        }
        const accountIds = lock.accountIds.includes(account.accountId) ? lock.accountIds : [...lock.accountIds, account.accountId];
        nextLocks.push({...lock, accountIds, accountName: account.accountName, serverTimeFloor: account.serverNow});
      }
      await this.save({...this.ledger, locks: nextLocks});
      await this.installRules();
      this.error = error;
      return this.view();
    });
  }
}
