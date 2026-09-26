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
  if (value.automatic !== undefined && (typeof value.automatic?.enabled !== "boolean" ||
      !Array.isArray(value.automatic.recordIds) || new Set(value.automatic.recordIds).size !== value.automatic.recordIds.length ||
      (value.automatic.enabled && !value.automatic.recordIds.length) ||
      value.automatic.recordIds.some(id => !ids.has(id) || isUnselected(value.accounts.find(record => record.id === id).state)))) {
    throw new Error("Saved automatic protection settings are invalid. Existing lockouts have not been reset.");
  }
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
  get automatic() { return this.ledger?.automatic ?? {enabled: false, recordIds: []}; }

  monitors(id, engine) {
    return !!engine.state && !isUnselected(engine.state) && (engine.state.hasOpen || quantity(engine.state) > 0 ||
      (this.automatic.enabled ? this.automatic.recordIds.includes(id) : id === this.ledger.active));
  }

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

  async enroll(account) {
    let record = this.findRecord(account);
    if (!record) {
      const id = Math.max(...this.ledger.accounts.map(item => item.id)) + 1;
      if (id > 2147483647) throw new Error("Account protection storage is full.");
      record = {id, state: {...newState(account.accountId), externalAccountId: account.externalAccountId,
        accountName: account.accountName, readHost: account.readHost}};
      await this.commit({...this.ledger, accounts: [...this.ledger.accounts, record]});
      this.createEngine(record);
    }
    return record;
  }

  setAutomaticEnabled(enabled) {
    return this.run(async () => {
      if (typeof enabled !== "boolean") throw new Error("Invalid automatic protection setting.");
      if (enabled && !this.automatic.recordIds.length) throw new Error("Check at least one account first.");
      await this.commit({...this.ledger, automatic: {...this.automatic, enabled}});
      return this.emit();
    });
  }

  setAutomaticAccount(accountId, checked) {
    return this.run(async () => {
      if (!validId(accountId) || typeof checked !== "boolean") throw new Error("Invalid automatic account selection.");
      let record;
      if (checked) record = await this.enroll(await this.api.account(accountId));
      else record = this.ledger.accounts.find(item => item.state.accountId === accountId);
      if (!record || isUnselected(record.state)) throw new Error("That account is unavailable. Refresh the account list.");
      const alreadyChecked = this.automatic.recordIds.includes(record.id);
      if (alreadyChecked === checked) return this.emit();
      const target = this.engines.get(record.id);
      // Checking an account while automatic mode is off only saves a preference.
      // Reading its timer must not start following an unselected open position.
      const result = await target.maintain({force: true, monitor: this.monitors(record.id, target)});
      if (target.activeLock()) throw new Error("This account is locked. Its selection can change after the timer ends.");
      if (target.state.hasOpen || quantity(target.state) > 0) throw new Error("Finish this account's open trade before changing its selection.");
      if (result.status === "error") throw new Error(result.message);
      const recordIds = checked ? [...this.automatic.recordIds, record.id] : this.automatic.recordIds.filter(id => id !== record.id);
      await this.commit({...this.ledger, automatic: {enabled: this.automatic.enabled && recordIds.length > 0, recordIds}});
      return this.emit();
    });
  }

  canSelect() { return !this.automatic.enabled && !!this.state && !this.state.hasOpen && quantity(this.state) === 0; }

  view() {
    let current = isUnselected(this.state) && !this.state.error
      ? {status: "unselected", message: "Choose an account below to start protection.",
        accountId: null, accountName: null, readHost: null, end: null, secondsRemaining: null, openQuantity: 0}
      : this.active?.view() ?? {status: "starting", message: "Checking protection…"};
    const lockouts = (this.ledger?.accounts ?? []).filter(record => this.engines.get(record.id)?.activeLock()).map(record => ({
      accountId: record.state.accountId, accountName: record.state.accountName,
      externalAccountId: record.state.externalAccountId, readHost: record.state.readHost,
      end: record.state.lock.end, confirmed: record.state.lock.confirmed, error: record.state.error,
      selected: record.id === this.ledger.active
    }));
    const autoAccounts = this.automatic.recordIds.map(id => {
      const engine = this.engines.get(id);
      const state = engine.state ?? this.ledger.accounts.find(record => record.id === id).state;
      return {accountId: state.accountId, accountName: state.accountName, readHost: state.readHost,
        openQuantity: quantity(state), ...engine.view(), recordId: id, externalAccountId: state.externalAccountId};
    });
    if (this.automatic.enabled) {
      const attention = autoAccounts.find(account => account.status === "error");
      const checking = autoAccounts.some(account => account.status === "starting");
      const allLocked = autoAccounts.length > 0 && autoAccounts.every(account => account.status === "locked");
      current = {accountId: null, readHost: null, accountName: `${autoAccounts.length} selected account${autoAccounts.length === 1 ? "" : "s"}`, end: null,
        secondsRemaining: null, openQuantity: autoAccounts.reduce((total, account) => total + account.openQuantity, 0),
        status: attention ? "error" : checking ? "starting" : allLocked ? "locked" : "ready",
        message: attention ? `${attention.accountName}: ${attention.message}` : checking ? "Checking selected accounts…"
          : allLocked ? "All checked accounts are locked. Protection resumes when their timers end."
          : "Automatic protection is on. Each checked account gets one trade, then eight hours off."};
      for (const lock of lockouts) lock.selected = false;
    }
    return {...current, canSelect: this.canSelect(), lockouts,
      automatic: {enabled: this.automatic.enabled, accounts: autoAccounts}};
  }

  async emit() { const view = this.view(); await this.publish(view); return view; }

  maintain({force = false, connected = () => false} = {}) {
    return this.run(async () => {
      for (const [id, engine] of this.engines) {
        if (isUnselected(engine.state)) continue;
        const monitor = this.monitors(id, engine);
        if (monitor || engine.state?.lock) await engine.maintain({force, monitor,
          connected: monitor && connected(engine.accountId, engine.state?.readHost)});
      }
      return this.emit();
    });
  }

  receive(raw, source) {
    return this.run(async () => {
      if (source) {
        for (const [id, engine] of this.engines) {
          if (this.monitors(id, engine) && engine.accountId === source.accountId && engine.state.readHost === source.readHost) {
            await engine.receive(raw, source);
          }
        }
      } else if (!this.automatic.enabled && !isUnselected(this.state)) await this.active.receive(raw);
      return this.emit();
    });
  }

  invalidate(message) {
    return this.run(async () => {
      for (const [id, engine] of this.engines) if (this.monitors(id, engine)) await engine.invalidate(message);
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
        const fresh = check.status === "fulfilled" && (!record ||
          (record.state.revision === revisions.get(record.id) && check.value.serverNow >= record.state.serverTimeFloor));
        if (record && fresh) {
          const engine = this.engines.get(record.id);
          await engine.enqueue(async () => {
            await engine.adoptAccount(account);
            await engine.applyLockResult(check.value);
          });
        }
        const local = record && this.engines.get(record.id).activeLock();
        const remote = fresh && check.value.remote;
        const activeRemote = remote && remote.end > check.value.serverNow;
        const scheduled = activeRemote && remote.start > check.value.serverNow;
        const locked = !!local || (activeRemote && !scheduled);
        const end = (local?.end ?? (activeRemote ? remote.end : null)) || null;
        choices.push({...account, end, selectable: !locked && !scheduled && fresh,
          automaticChecked: !!record && this.automatic.recordIds.includes(record.id),
          lockStatus: locked ? "locked" : scheduled ? "scheduled" : !fresh ? "unknown" : "available"});
      }
      await this.emit();
      return choices;
    });
  }

  selectAccount(accountId) {
    return this.run(async () => {
      try {
        if (this.automatic.enabled) throw new Error("Automatic protection is on. Choose accounts using the checkboxes above.");
        if (!this.canSelect()) throw new Error("Finish the open trade before changing the protected account.");
        const previous = this.active;
        if (previous.state.lock) {
          await previous.save();
          await previous.guard(!!previous.activeLock(), previous.accountId);
        } else if (previous.state.externalAccountId) {
          const current = await this.api.account(previous.accountId, {
            externalAccountId: previous.state.externalAccountId, readHost: previous.state.readHost
          });
          await previous.enqueue(async () => previous.adoptAccount(current));
          const checked = await previous.maintain({force: true, connected: false});
          if (checked.status === "error") throw new Error(checked.message);
          if (!this.canSelect()) throw new Error("Finish the open trade before changing the protected account.");
        }

        const account = await this.api.account(accountId);
        const record = await this.enroll(account);
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
