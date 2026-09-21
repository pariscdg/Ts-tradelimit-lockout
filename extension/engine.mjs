import {newState, validateState, parseFrame, applyPositions, reconcileLock, quantity, legacyConfirmationError} from "./core.mjs";

// The service worker is the sole writer. Serializing operations prevents two
// tabs, alarm callbacks, or duplicate close events from racing the lock ledger.
export class ProtectionEngine {
  constructor({accountId, storage, api, guard, publish = async () => {}, monotonic = () => performance.now()}) {
    Object.assign(this, {accountId, storage, api, guard, publish, monotonic});
    this.state = null;
    this.tail = Promise.resolve();
    this.anchor = null;
    this.verified = false;
    this.lastCheck = -Infinity;
  }

  enqueue(action) {
    const job = this.tail.then(async () => {
      try {
        if (!this.state) {
          const saved = await this.storage.load();
          this.state = saved === undefined ? newState(this.accountId) : validateState(saved, this.accountId);
          this.state = {...this.state, snapshotReady: false};
          if (legacyConfirmationError(this.state.error)) this.state.error = null;
          // Reinstall the browser safeguard before any network activity.
          await this.guard(this.state.lock?.confirmed === true, this.accountId);
        }
        await action();
      } catch (error) {
        this.verified = false;
        if (this.state) {
          this.state = {...this.state, error: error.message};
          try { await this.storage.save(this.state); } catch { /* Keep the in-memory deadline. */ }
        }
        const view = this.state ? this.view() : {status: "error", message: error.message};
        await this.publish(view);
        return view;
      }
      const view = this.view();
      await this.publish(view);
      return view;
    });
    this.tail = job.catch(() => {});
    return job;
  }

  setClock(serverNow) {
    this.anchor = {seconds: Math.max(serverNow, this.state.serverTimeFloor), at: this.monotonic()};
    this.state.serverTimeFloor = this.anchor.seconds;
  }

  now() {
    return this.anchor ? this.anchor.seconds + Math.max(0, this.monotonic() - this.anchor.at) / 1000 : NaN;
  }

  activeLock() {
    const lock = this.state?.lock;
    return lock?.confirmed && this.lastCheck !== -Infinity && lock.end > this.now() ? lock : null;
  }

  async save() { await this.storage.save(this.state); }

  async identify() {
    if (this.verified) return;
    const account = await this.api.account(this.accountId, {
      externalAccountId: this.state.externalAccountId, readHost: this.state.readHost
    });
    await this.adoptAccount(account);
  }

  async adoptAccount(account) {
    if (this.state.externalAccountId && this.state.externalAccountId !== account.externalAccountId) {
      throw new Error("The saved account's identity changed. Protection needs attention.");
    }
    if (this.state.readHost && this.state.readHost !== account.readHost) {
      throw new Error("The protected account's environment changed. Protection needs attention.");
    }
    this.state = {...this.state, accountId: account.accountId ?? this.accountId, externalAccountId: account.externalAccountId,
      accountName: account.accountName, readHost: account.readHost};
    this.accountId = this.state.accountId;
    this.setClock(account.serverNow);
    this.verified = true;
    await this.save();
    await this.guard(this.state.lock?.confirmed === true, this.accountId);
  }

  async checkLock() {
    const result = await this.api.getLock(this.accountId);
    await this.applyLockResult(result);
  }

  async applyLockResult(result) {
    this.setClock(result.serverNow);
    this.state = reconcileLock(this.state, result.remote, result.serverNow);
    await this.save();
    await this.guard(this.state.lock !== null, this.accountId);
    this.lastCheck = this.monotonic();
  }

  async enforce() {
    const lock = this.state.lock;
    if (!lock || lock.confirmed) return;
    // Called only by a newly completed trade. Maintenance and dropdown reads
    // never resubmit a failed/old request, including after a worker restart.
    const result = await this.api.setLock(this.accountId, lock);
    if (result.accepted !== true) throw new Error("TradeSea did not accept the lockout request.");
    this.setClock(result.serverNow);
    // Keep the legacy field for saved-state compatibility. It now records a
    // successful request/read, without a separate confirmation workflow.
    this.state = {...this.state, lock: {...lock, confirmed: true}, error: null};
    this.lastCheck = this.monotonic();
    await this.save();
    await this.guard(true, this.accountId);
  }

  async accept(frame) {
    const result = applyPositions(this.state, frame, this.now());
    this.state = result.state;
    if (result.changed) await this.save();
    if (result.triggered) {
      this.state.error = null;
      await this.publish(this.view());
      await this.enforce();
    }
  }

  receive(raw, source = null) {
    return this.enqueue(async () => {
      const frame = parseFrame(raw);
      if (!frame) return;
      await this.identify();
      // Check inside the serialized operation: a popup selection may have
      // finished while this message was queued behind it.
      if (source && (source.accountId !== this.accountId || source.readHost !== this.state.readHost)) return;
      if (this.lastCheck === -Infinity) await this.checkLock();
      try { await this.accept(frame); }
      catch (error) {
        // Unknown event shapes must never be interpreted as a zero position.
        this.state.snapshotReady = false;
        throw error;
      }
      // A position frame cannot clear a failed server check. Only maintenance
      // verifies connectivity and the remote deadline before clearing an error.
      await this.save();
    });
  }

  invalidate(message) {
    return this.enqueue(async () => {
      this.state.snapshotReady = false;
      this.state.error = message;
      await this.save();
    });
  }

  maintain({force = false, connected = false, monitor = true} = {}) {
    return this.enqueue(async () => {
      await this.identify();
      if (force || this.monotonic() - this.lastCheck >= 15000) await this.checkLock();
      if (monitor && !this.state.lock && (!this.state.snapshotReady || !connected)) {
        const result = await this.api.snapshot(this.state);
        this.setClock(result.serverNow);
        await this.accept(result.frame);
      }
      this.state.error = null;
      await this.save();
    });
  }

  view() {
    const state = this.state;
    if (!state) return {status: "starting", message: "Checking protection…"};
    const common = {accountId: state.accountId, accountName: state.accountName, readHost: state.readHost, end: state.lock?.end ?? null,
      secondsRemaining: state.lock ? Math.max(0, Math.ceil(state.lock.end - this.now())) : null,
      openQuantity: quantity(state)};
    if (state.error) return {...common, status: "error", message: state.error};
    if (this.activeLock()) return {...common, status: "locked", message: "This account has an active TradeSea lockout."};
    if (state.lock) return {...common, end: null, secondsRemaining: null, status: "starting", message: "Refreshing this account's lockout status…"};
    if (!state.snapshotReady) return {...common, status: "starting", message: "Waiting for a complete account position snapshot."};
    return {...common, status: "ready", message: state.hasOpen
      ? "Monitoring your open trade. The lockout starts when this account is flat."
      : "One completed trade, then an eight-hour lockout."};
  }
}
