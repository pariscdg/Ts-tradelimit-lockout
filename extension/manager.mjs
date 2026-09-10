import {ProtectionEngine} from "./engine.mjs";
import {newState, validateState, validId, quantity} from "./core.mjs";

// Fresh installs wait for an explicit popup selection. This marker is never
// sent to TradeSea, and an existing saved identity or lock always takes priority.
const UNSELECTED_ACCOUNT = "__select_account__";
function isUnselected(state) {
  return state?.accountId === UNSELECTED_ACCOUNT && !state.externalAccountId && !state.readHost &&
    !state.lock && !state.hasOpen && quantity(state) === 0;
}

export function validateLedger(value) {
  if (!value || value.version !== 2 || !Array.isArray(value.accounts) || !value.accounts.length) {
    throw new Error("Saved account protection data is invalid. Refusing to reset lockouts.");
  }
  const ids = new Set();
  const identities = new Set();
  for (const record of value.accounts) {
    if (!record || !Number.isInteger(record.id) || record.id < 1 || record.id > 2147483647 ||
        ids.has(record.id) || !validId(record.state?.accountId)) throw new Error("Saved account records are invalid.");
    validateState(record.state, record.state.accountId);
    ids.add(record.id);
    if (record.state.externalAccountId) {
      const identity = JSON.stringify([record.state.externalAccountId, record.state.readHost]);
      if (identities.has(identity)) throw new Error("Saved protection has duplicate account identities.");
      identities.add(identity);
    }
  }
  if (!ids.has(value.active)) throw new Error("The selected protected account is missing. Refusing to reset lockouts.");
  return value;
}

// One queue owns the complete ledger. Each account keeps its existing engine,
// deadline and browser-rule ID when the selected trading account changes.
export class ProtectionManager {
  constructor({accountId = UNSELECTED_ACCOUNT, storage, api, guard, publish = async () => {}, monotonic = () => performance.now()}) {
    Object.assign(this, {configuredAccountId: accountId, storage, api, guard, publish, monotonic});
    this.ledger = null;
    this.engines = new Map();
    this.tail = Promise.resolve();
  }

  get active() { return this.engines.get(this.ledger?.active); }
  get accountId() { return this.active?.accountId; }
  get state() { return this.active?.state; }

  async commit(ledger) {
    await this.storage.save(structuredClone(ledger));
    this.ledger = ledger;
  }

  createEngine(record) {
    const engine = new ProtectionEngine({accountId: record.state.accountId, api: this.api, monotonic: this.monotonic,
      storage: {
        load: async () => structuredClone(this.ledger.accounts.find(item => item.id === record.id).state),
        save: async state => this.commit({...this.ledger, accounts: this.ledger.accounts.map(item =>
          item.id === record.id ? {...item, state: structuredClone(state)} : item)})
      },
      guard: (active, accountId) => this.guard(active, accountId, record.id),
      publish: async () => this.publish(this.view())
    });
    this.engines.set(record.id, engine);
    return engine;
  }

  async initialize() {
    if (this.ledger) return;
    const saved = await this.storage.load();
    let ledger;
    if (saved?.version === 2) ledger = validateLedger(saved);
    else {
      const state = saved === undefined ? newState(this.configuredAccountId) : validateState(saved, saved?.accountId);
      ledger = validateLedger({version: 2, active: 1, accounts: [{id: 1, state}]});
      // Migration is one durable write; the existing deadline is copied intact.
      await this.storage.save(structuredClone(ledger));
    }
    this.ledger = ledger;
    for (const record of ledger.accounts) this.createEngine(record);
    for (const engine of this.engines.values()) await engine.enqueue(async () => {});
  }

  run(action) {
    const job = this.tail.then(async () => { await this.initialize(); return action(); });
    this.tail = job.catch(() => {});
    return job;
  }

  findRecord(account) {
    const matches = this.ledger.accounts.filter(({state}) => state.externalAccountId
      ? state.externalAccountId === account.externalAccountId && state.readHost === account.readHost
      : state.accountId === account.accountId);
    if (matches.length > 1) throw new Error("Saved protection has ambiguous account identities.");
    return matches[0];
  }

  canSelect() { return !!this.state && !this.state.hasOpen && quantity(this.state) === 0; }

  view() {
    const current = isUnselected(this.state) && !this.state.error
      ? {status: "unselected", message: "Choose an account below to start protection.",
        accountId: null, accountName: null, readHost: null, end: null, secondsRemaining: null, openQuantity: 0}
      : this.active?.view() ?? {status: "starting", message: "Checking protection…"};
    const lockouts = (this.ledger?.accounts ?? []).filter(record => record.state.lock).map(record => ({
      accountId: record.state.accountId, accountName: record.state.accountName,
      externalAccountId: record.state.externalAccountId, readHost: record.state.readHost,
      end: record.state.lock.end, confirmed: record.state.lock.confirmed, error: record.state.error,
      selected: record.id === this.ledger.active
    }));
    const view = {...current, canSelect: this.canSelect(), lockouts};
    const attention = lockouts.find(lock => !lock.selected && (lock.error || !lock.confirmed));
    if (attention && current.status !== "error") return {...view, status: "error",
      message: `${attention.accountName}: ${attention.error || "The saved lockout is awaiting server confirmation."}`};
    return view;
  }

  async emit() { const view = this.view(); await this.publish(view); return view; }

  maintain({force = false, connected = () => false} = {}) {
    return this.run(async () => {
      for (const [id, engine] of this.engines) {
        if (isUnselected(engine.state)) continue;
        const selected = id === this.ledger.active;
        const recordedOpen = engine.state && (engine.state.hasOpen || quantity(engine.state) > 0);
        if (selected || engine.state?.lock || recordedOpen) await engine.maintain({force, monitor: selected || recordedOpen,
          connected: selected && connected(engine.accountId, engine.state?.readHost)});
      }
      return this.emit();
    });
  }

  receive(raw, source) {
    return this.run(async () => {
      if (!isUnselected(this.state)) await this.active.receive(raw, source);
      return this.emit();
    });
  }

  invalidate(message) {
    return this.run(async () => {
      if (!isUnselected(this.state)) await this.active.invalidate(message);
      return this.emit();
    });
  }

  async choices() {
    const revisions = await this.run(async () => new Map(this.ledger.accounts.map(record => [record.id, record.state.revision])));
    // A slow dropdown lookup must not hold up a completed trade's lockout.
    const accounts = await this.api.accounts();
    const checks = await Promise.allSettled(accounts.map(account => this.api.getLock(account.accountId)));
    return this.run(async () => {
      const choices = [];
      for (let index = 0; index < accounts.length; index++) {
        const account = accounts[index];
        const check = checks[index];
        const record = this.findRecord(account);
        if (record && check.status === "fulfilled" && record.state.revision === revisions.get(record.id) &&
            check.value.serverNow >= record.state.serverTimeFloor) {
          const engine = this.engines.get(record.id);
          await engine.enqueue(async () => {
            await engine.adoptAccount(account);
            await engine.applyLockResult(check.value);
          });
        }
        const local = record && this.engines.get(record.id).state;
        const remote = check.status === "fulfilled" && check.value.remote;
        const activeRemote = remote && remote.end > check.value.serverNow;
        const scheduled = activeRemote && remote.start > check.value.serverNow;
        const locked = !!local?.lock || account.restricted || (activeRemote && !scheduled);
        const end = Math.max(local?.lock?.end ?? 0, activeRemote ? remote.end : 0) || null;
        choices.push({...account, end, selectable: !locked && !scheduled && check.status === "fulfilled",
          lockStatus: locked ? (local?.lock && !local.lock.confirmed ? "pending" : "locked")
            : scheduled ? "scheduled" : check.status === "rejected" ? "unknown" : "available"});
      }
      await this.emit();
      return choices;
    });
  }

  selectAccount(accountId) {
    return this.run(async () => {
      try {
        if (!this.canSelect()) throw new Error("Finish the open trade before changing the protected account.");
        const previous = this.active;
        if (previous.state.lock) {
          // Preserve even a pending deadline before allowing another account.
          await previous.save();
          await previous.guard(true, previous.accountId);
        } else if (previous.state.externalAccountId) {
          const current = await this.api.account(previous.accountId, {
            externalAccountId: previous.state.externalAccountId, readHost: previous.state.readHost
          });
          if (current.restricted) {
            // A broker-locked account may no longer expose its position API.
            // Its freshly verified Locked flag permits choosing another account;
            // any extension deadline was retained by the branch above.
            await previous.enqueue(async () => previous.adoptAccount(current));
            if (!previous.verified) throw new Error(previous.state.error || "Account verification failed.");
          } else {
            const checked = await previous.maintain({force: true, connected: false});
            if (checked.status === "error") throw new Error(checked.message);
          }
          if (!this.canSelect()) throw new Error("Finish the open trade before changing the protected account.");
        }

        const account = await this.api.account(accountId);
        if (account.restricted) throw new Error("That account is marked Locked by TradeSea. Choose an unlocked account.");
        let record = this.findRecord(account);
        if (!record) {
          const id = Math.max(...this.ledger.accounts.map(item => item.id)) + 1;
          if (id > 2147483647) throw new Error("Account protection storage is full.");
          record = {id, state: {...newState(account.accountId), externalAccountId: account.externalAccountId,
            accountName: account.accountName, readHost: account.readHost}};
          await this.commit({...this.ledger, accounts: [...this.ledger.accounts, record]});
          this.createEngine(record);
        }
        const target = this.engines.get(record.id);
        const checked = await target.maintain({force: true, connected: false});
        if (target.state?.lock) throw new Error("That account is Locked. Choose an unlocked account; its saved deadline has been preserved.");
        if (checked.status === "error") throw new Error(checked.message);
        await this.commit({...this.ledger, active: record.id});
        return this.emit();
      } catch (error) {
        const view = await this.emit();
        return {...view, selectionError: error.message};
      }
    });
  }
}
