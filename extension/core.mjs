// No runtime preference or message accepts a trade limit or lockout duration.
export const LOCK_SECONDS = 8 * 60 * 60;
export const READ_HOSTS = new Set(["prod-trade-read.tradesea.ai", "api-trades-r-delprod.tradesea.ai"]);

export function validId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(value);
}

export function newState(accountId) {
  if (!validId(accountId)) throw new Error("The saved account selection is invalid.");
  return {version: 1, accountId, externalAccountId: null, accountName: "Saved account",
    readHost: null, positions: {}, snapshotReady: false, hasOpen: false,
    lock: null, serverTimeFloor: 0, revision: 0, error: null};
}

export function validateState(state, accountId) {
  if (!state || state.version !== 1 || state.accountId !== accountId ||
      !state.positions || typeof state.positions !== "object" || Array.isArray(state.positions) ||
      typeof state.hasOpen !== "boolean" || typeof state.snapshotReady !== "boolean" ||
      !Number.isFinite(state.serverTimeFloor) || !Number.isInteger(state.revision)) {
    throw new Error("Saved protection data is invalid or belongs to another account. Protection needs attention.");
  }
  if (state.lock && (!Number.isInteger(state.lock.start) || !Number.isInteger(state.lock.end) ||
      state.lock.end <= state.lock.start || typeof state.lock.confirmed !== "boolean" ||
      !["trade", "existing"].includes(state.lock.reason) ||
      (state.lock.reason === "trade" && state.lock.end - state.lock.start < LOCK_SECONDS))) {
    throw new Error("Saved lockout data is invalid. Refusing to reset it.");
  }
  for (const position of Object.values(state.positions)) {
    if (!position || !Number.isFinite(position.qty) || !Number.isFinite(position.modified)) {
      throw new Error("Saved position data is invalid. Protection needs attention.");
    }
  }
  return state;
}

export function streamInfo(value) {
  try {
    const url = new URL(value);
    const match = /^\/v1\/users\/([A-Za-z0-9_-]{1,512})\/ws\/unified$/.exec(url.pathname);
    return url.protocol === "wss:" && READ_HOSTS.has(url.hostname) && match
      ? {accountId: match[1], host: url.hostname} : null;
  } catch { return null; }
}

export function accountIdsInSnapshot(body) {
  const accounts = body?.userFullStates?.accounts;
  if (!accounts || typeof accounts !== "object" || Array.isArray(accounts)) return [];
  return Object.entries(accounts).filter(([id, summary]) => id && summary &&
    ["balance", "realizedPl", "commission"].every(field => Number.isFinite(summary[field]))).map(([id]) => id);
}

export function parseFrame(frame) {
  try {
    const message = typeof frame === "string" ? JSON.parse(frame) : frame;
    if (!["unifiedSnapshot", "positionUpdates"].includes(message?.event)) return null;
    const data = typeof message.data === "string" ? JSON.parse(message.data) : message.data ?? message;
    return {event: message.event, positions: data?.positions,
      ...(message.event === "unifiedSnapshot" ? {snapshotAccountIds: Array.isArray(data?.snapshotAccountIds)
        ? data.snapshotAccountIds.filter(id => typeof id === "string" && id) : accountIdsInSnapshot(data)} : {})};
  } catch { return null; }
}

export function quantity(state) {
  return Object.values(state.positions).reduce((sum, p) => sum + Math.abs(p.qty), 0);
}

export function positionEntries(frame, externalAccountId) {
  if (Array.isArray(frame?.positions)) return frame.positions;
  // TradeSea's complete flat snapshots can omit positions (or encode null).
  // Require a full summary for THIS account; an empty/error object isn't flat.
  if (frame?.event === "unifiedSnapshot" && frame.positions == null &&
      typeof externalAccountId === "string" && Array.isArray(frame.snapshotAccountIds) &&
      frame.snapshotAccountIds.includes(externalAccountId)) return [];
  throw new Error("Unrecognized position message. Monitoring needs a fresh snapshot.");
}

// TradeSea positionUpdates are deltas, NOT complete account snapshots. Empty
// deltas mean no changes. Only a complete unifiedSnapshot can clear the map.
export function applyPositions(state, frame, serverNow) {
  if (!frame || !state.externalAccountId) return {state, changed: false, triggered: false};
  const snapshot = frame.event === "unifiedSnapshot";
  if (!snapshot && frame.event !== "positionUpdates") return {state, changed: false, triggered: false};
  const entries = positionEntries(frame, state.externalAccountId);
  if (!snapshot && !state.snapshotReady) return {state, changed: false, triggered: false};
  const positions = snapshot ? {} : {...state.positions};
  let relevant = snapshot;
  for (const item of entries) {
    if (!item || item.accountId === undefined || item.accountId === null) {
      throw new Error("A position has no account identifier. Monitoring needs a fresh snapshot.");
    }
    if (String(item.accountId) !== state.externalAccountId) continue;
    if (item.qty === null || item.qty === undefined || typeof item.qty === "boolean" ||
        (typeof item.qty === "string" && !item.qty.trim()) ||
        !Number.isFinite(Number(item.qty)) || !["string", "number"].includes(typeof item.id) || !String(item.id)) {
      throw new Error("Unrecognized position fields. Monitoring needs a fresh snapshot.");
    }
    const id = String(item.id);
    if (["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid position identifier.");
    const modified = Number(item.lastModified ?? 0);
    if (!Number.isFinite(modified)) throw new Error("Invalid position timestamp.");
    // Zero-quantity entries retain a timestamp so delayed opens cannot resurrect them.
    if (!snapshot && positions[id] && modified < positions[id].modified) continue;
    positions[id] = {qty: Number(item.qty), modified};
    relevant = true;
  }
  if (!relevant) return {state, changed: false, triggered: false};
  const next = {...state, positions, snapshotReady: true, revision: state.revision + 1};
  const current = quantity(next);
  let triggered = false;
  if (!next.lock && state.hasOpen && current === 0) {
    if (!Number.isFinite(serverNow) || serverNow <= 0) throw new Error("TradeSea server time is not available.");
    const start = Math.ceil(serverNow);
    next.lock = {start, end: start + LOCK_SECONDS, reason: "trade", confirmed: false};
    triggered = true;
  }
  next.hasOpen = current > 0;
  return {state: next, changed: true, triggered};
}

export function readServerLock(body) {
  if (!["ok", "success"].includes(body?.status)) throw new Error("TradeSea did not accept the lockout request.");
  const data = body.data;
  if (!data || typeof data !== "object") throw new Error("Unrecognized TradeSea lockout response.");
  const start = data.lockoutStartTimeEpoch;
  const end = data.lockoutEndTimeEpoch;
  if ((start === null || start === undefined || start === 0) &&
      (end === null || end === undefined || end === 0)) return null;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end <= start) {
    throw new Error("Unrecognized TradeSea lockout times.");
  }
  return {start, end};
}

// A local deadline can only grow. Existing longer server locks are preserved.
// Only a successful server read, using server time, is allowed to expire a lock.
export function reconcileLock(state, remote, serverNow) {
  if (!Number.isFinite(serverNow) || serverNow <= 0) throw new Error("TradeSea did not provide a valid server clock.");
  const next = {...state, serverTimeFloor: Math.max(state.serverTimeFloor, serverNow)};
  if (next.lock && serverNow >= next.lock.end && next.lock.confirmed) {
    next.lock = null;
    next.hasOpen = false;
    next.positions = {};
    next.snapshotReady = false;
  }
  if (remote && remote.end > serverNow) {
    if (!next.lock && remote.start > serverNow) {
      throw new Error("A future personal lockout is scheduled. Protection will not replace it; check the TradeSea lockout panel before trading.");
    }
    if (!next.lock) next.lock = {...remote, reason: "existing", confirmed: true};
    else if (remote.start <= serverNow && remote.end >= next.lock.end) {
      next.lock = {...next.lock, end: remote.end, confirmed: true};
    } else next.lock = {...next.lock, end: Math.max(next.lock.end, remote.end), confirmed: false};
  } else if (next.lock) next.lock = {...next.lock, confirmed: false};
  return next;
}

export function lockPayload(lock) {
  return {lockoutStartTimeEpoch: lock.start, lockoutEndTimeEpoch: lock.end};
}

export function lockRule(accountId, extensionId) {
  if (!validId(accountId)) throw new Error("Invalid account selection.");
  return {id: 1, priority: 1, action: {type: "block"}, condition: {
    urlFilter: `|https://prod-identity.tradesea.ai/eum/v1/prop-fund/${accountId}/lockout^`,
    requestMethods: ["put", "post", "patch", "delete"],
    excludedInitiatorDomains: [extensionId]
  }};
}
