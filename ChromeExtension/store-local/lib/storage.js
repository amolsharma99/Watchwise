import { validatePlaybackEvent } from "./validation.js";
import { safeSettingsExport } from "./settings.js";
import { isUnidentifiedYouTubeURL } from "./youtube.js";

export const DATABASE_NAME = "watchwise-local";
export const DATABASE_VERSION = 1;
export const RECORD_STORE = "encryptedRecords";
export const KEY_STORE = "keyMaterial";
const STATE_RECORD_ID = "e27d9033-8365-45f4-9251-6a52f53b9f72";
const PRIMARY_KEY_ID = "9bb64189-9081-4da0-9f39-107c18f855b2";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class SecureStorageError extends Error {
  constructor(message = "Encrypted local data is unavailable", options = {}) {
    super(message, options);
    this.name = "SecureStorageError";
    this.code = "secure_storage_unavailable";
  }
}
export function isSecureStorageError(error) {
  return error instanceof SecureStorageError || error?.code === "secure_storage_unavailable";
}

function requestPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}
function bytesToBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function base64ToBytes(value) { return Uint8Array.from(atob(value), (character) => character.charCodeAt(0)); }
function additionalData(recordID, recordType, schemaVersion = 1) { return encoder.encode(`watchwise-local|${schemaVersion}|${recordType}|${recordID}`); }
function validEncryptionKey(key) {
  return key?.extractable === false && key.algorithm?.name === "AES-GCM" && key.algorithm?.length === 256
    && Array.isArray(key.usages) && key.usages.length === 2 && key.usages.includes("encrypt") && key.usages.includes("decrypt");
}
function exactEnvelope(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid encrypted record");
  if (Object.keys(value).sort().join(",") !== "ciphertext,iv,recordID,recordType,schemaVersion") throw new TypeError("invalid encrypted record fields");
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > 255 || typeof value.recordID !== "string" || !/^[a-f0-9-]{36}$/.test(value.recordID)) throw new TypeError("invalid encrypted record identity");
  if (typeof value.iv !== "string" || typeof value.ciphertext !== "string") throw new TypeError("invalid encrypted record payload");
  if (!["e", "s"].includes(value.recordType)) throw new TypeError("invalid encrypted record type");
  return value;
}

export async function generateEncryptionKey(cryptoProvider = globalThis.crypto) {
  return cryptoProvider.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
export async function encryptEnvelope(recordID, recordType, payload, key, cryptoProvider = globalThis.crypto) {
  if (!validEncryptionKey(key)) throw new TypeError("valid non-extractable AES-GCM key required");
  const iv = cryptoProvider.getRandomValues(new Uint8Array(12));
  const ciphertext = await cryptoProvider.subtle.encrypt({ name: "AES-GCM", iv, additionalData: additionalData(recordID, recordType), tagLength: 128 }, key, encoder.encode(JSON.stringify(payload)));
  return Object.freeze({ schemaVersion: 1, recordID, recordType, iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(ciphertext)) });
}
export async function decryptEnvelope(envelope, key, cryptoProvider = globalThis.crypto) {
  try {
    const value = exactEnvelope(envelope);
    if (!validEncryptionKey(key)) throw new TypeError("valid non-extractable AES-GCM key required");
    const iv = base64ToBytes(value.iv);
    if (iv.byteLength !== 12) throw new TypeError("invalid IV");
    const plaintext = await cryptoProvider.subtle.decrypt({ name: "AES-GCM", iv, additionalData: additionalData(value.recordID, value.recordType, value.schemaVersion), tagLength: 128 }, key, base64ToBytes(value.ciphertext));
    return JSON.parse(decoder.decode(plaintext));
  } catch (error) {
    if (isSecureStorageError(error)) throw error;
    throw new SecureStorageError("Encrypted local data could not be authenticated", { cause: error });
  }
}

export function upgradeLocalDatabase(database) {
  if (!database.objectStoreNames.contains(RECORD_STORE)) {
    const records = database.createObjectStore(RECORD_STORE, { keyPath: "recordID" });
    records.createIndex("byIV", "iv", { unique: true });
  }
  if (!database.objectStoreNames.contains(KEY_STORE)) database.createObjectStore(KEY_STORE, { keyPath: "keyID" });
}
function defaultState() { return Object.freeze({ schemaVersion: 1, settings: {}, onboardingComplete: false, nudgeState: {}, goalCheckInState: {}, maintenance: { lastPruneAtMs: 0 } }); }
function normalizeState(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    schemaVersion: 1,
    settings: source.settings && typeof source.settings === "object" && !Array.isArray(source.settings) ? source.settings : {},
    onboardingComplete: source.onboardingComplete === true,
    nudgeState: source.nudgeState && typeof source.nudgeState === "object" && !Array.isArray(source.nudgeState) ? source.nudgeState : {},
    goalCheckInState: source.goalCheckInState && typeof source.goalCheckInState === "object" && !Array.isArray(source.goalCheckInState) ? source.goalCheckInState : {},
    maintenance: { lastPruneAtMs: Number.isFinite(source.maintenance?.lastPruneAtMs) ? Math.max(0, source.maintenance.lastPruneAtMs) : 0 }
  });
}

export function comparePlaybackEvents(left, right) {
  return left.occurredAtMs - right.occurredAtMs || left.eventID.localeCompare(right.eventID);
}
export function playbackEventLowerBound(events, occurredAtMs) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if (events[middle].occurredAtMs < occurredAtMs) low = middle + 1;
    else high = middle;
  }
  return low;
}
export function insertPlaybackEvent(events, event) {
  if (!events.length || comparePlaybackEvents(events[events.length - 1], event) <= 0) {
    events.push(event);
    return events.length - 1;
  }
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = low + ((high - low) >> 1);
    if (comparePlaybackEvents(events[middle], event) <= 0) low = middle + 1;
    else high = middle;
  }
  events.splice(low, 0, event);
  return low;
}
export function playbackEventRange(events, startMs = -Infinity, endMs = Infinity) {
  return events.slice(playbackEventLowerBound(events, startMs), playbackEventLowerBound(events, endMs));
}

export class IndexedDBRepository {
  constructor({ indexedDBFactory = globalThis.indexedDB, cryptoProvider = globalThis.crypto, dbName = DATABASE_NAME } = {}) {
    if (!indexedDBFactory || !cryptoProvider?.subtle) throw new Error("Secure local storage is unavailable");
    this.indexedDB = indexedDBFactory;
    this.crypto = cryptoProvider;
    this.dbName = dbName;
    this.database = null;
    this.openPromise = null;
    this.keyPromise = null;
    this.stateCache = null;
    this.eventsCache = null;
  }
  async open() {
    if (this.database) return this;
    if (this.openPromise) return this.openPromise;
    const request = this.indexedDB.open(this.dbName, DATABASE_VERSION);
    request.onupgradeneeded = () => upgradeLocalDatabase(request.result);
    const pending = requestPromise(request).then((database) => {
      this.database = database;
      database.onversionchange = () => { database.close(); this.database = null; this.openPromise = null; this.keyPromise = null; };
      return this;
    }).catch((error) => { this.database = null; throw error; });
    this.openPromise = pending;
    try { return await pending; } finally { if (this.openPromise === pending) this.openPromise = null; }
  }
  async #key() {
    if (this.keyPromise) return this.keyPromise;
    this.keyPromise = (async () => {
      await this.open();
      const read = this.database.transaction(KEY_STORE, "readonly");
      const readDone = transactionDone(read);
      const existing = await requestPromise(read.objectStore(KEY_STORE).get(PRIMARY_KEY_ID));
      await readDone;
      if (validEncryptionKey(existing?.key)) return existing.key;
      if (existing) throw new SecureStorageError("Secure local key is invalid");
      const countTransaction = this.database.transaction(RECORD_STORE, "readonly");
      const countDone = transactionDone(countTransaction);
      const recordCount = await requestPromise(countTransaction.objectStore(RECORD_STORE).count());
      await countDone;
      if (recordCount > 0) {
        const winnerRead = this.database.transaction(KEY_STORE, "readonly");
        const winnerDone = transactionDone(winnerRead);
        const winner = await requestPromise(winnerRead.objectStore(KEY_STORE).get(PRIMARY_KEY_ID));
        await winnerDone;
        if (validEncryptionKey(winner?.key)) return winner.key;
        throw new SecureStorageError("Secure local key is missing");
      }
      const candidate = await generateEncryptionKey(this.crypto);
      try {
        const write = this.database.transaction(KEY_STORE, "readwrite");
        const writeDone = transactionDone(write);
        write.objectStore(KEY_STORE).add({ keyID: PRIMARY_KEY_ID, key: candidate });
        await writeDone;
        return candidate;
      } catch {
        const retry = this.database.transaction(KEY_STORE, "readonly");
        const retryDone = transactionDone(retry);
        const winner = await requestPromise(retry.objectStore(KEY_STORE).get(PRIMARY_KEY_ID));
        await retryDone;
        if (validEncryptionKey(winner?.key)) return winner.key;
        throw new SecureStorageError("Could not initialize secure local storage");
      }
    })();
    try { return await this.keyPromise; } catch (error) { this.keyPromise = null; throw error; }
  }
  async #putPayload(recordID, recordType, payload) {
    await this.open();
    const key = await this.#key();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const envelope = await encryptEnvelope(recordID, recordType, payload, key, this.crypto);
      try {
        const transaction = this.database.transaction(RECORD_STORE, "readwrite");
        const done = transactionDone(transaction);
        transaction.objectStore(RECORD_STORE).put(envelope);
        await done;
        return;
      } catch (error) {
        if (error?.name !== "ConstraintError" || attempt === 2) throw error;
      }
    }
  }
  async #allDecoded() {
    await this.open();
    const transaction = this.database.transaction(RECORD_STORE, "readonly");
    const done = transactionDone(transaction);
    const envelopes = await requestPromise(transaction.objectStore(RECORD_STORE).getAll());
    await done;
    const key = await this.#key();
    return Promise.all(envelopes.map(async (envelope) => ({ envelope, payload: await decryptEnvelope(envelope, key, this.crypto) })));
  }
  async getState() {
    if (this.stateCache) return this.stateCache;
    await this.open();
    const transaction = this.database.transaction(RECORD_STORE, "readonly");
    const done = transactionDone(transaction);
    const envelope = await requestPromise(transaction.objectStore(RECORD_STORE).get(STATE_RECORD_ID));
    await done;
    if (!envelope) return defaultState();
    const payload = await decryptEnvelope(envelope, await this.#key(), this.crypto);
    if (payload?.kind !== "state") throw new SecureStorageError("Encrypted local state is invalid");
    this.stateCache = normalizeState(payload.value);
    return this.stateCache;
  }
  async setState(state) {
    const value = normalizeState(state);
    await this.#putPayload(STATE_RECORD_ID, "s", { kind: "state", value });
    this.stateCache = value;
  }
  async putEvent(event) {
    const value = validatePlaybackEvent(event);
    await this.#putPayload(this.crypto.randomUUID(), "e", { kind: "event", value });
    if (this.eventsCache) insertPlaybackEvent(this.eventsCache, value);
  }
  async listEvents(startMs = -Infinity, endMs = Infinity) {
    if (!this.eventsCache) {
      const decoded = await this.#allDecoded();
      this.eventsCache = decoded.filter(({ payload }) => payload?.kind === "event").map(({ payload }) => validatePlaybackEvent(payload.value))
        .sort(comparePlaybackEvents);
    }
    return playbackEventRange(this.eventsCache, startMs, endMs);
  }
  async prune(beforeMs) {
    if (!Number.isFinite(beforeMs)) throw new TypeError("invalid prune timestamp");
    const decoded = await this.#allDecoded();
    const expired = decoded.filter(({ payload }) => payload?.kind === "event" && validatePlaybackEvent(payload.value).occurredAtMs < beforeMs).map(({ envelope }) => envelope.recordID);
    if (!expired.length) return;
    const transaction = this.database.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    for (const recordID of expired) transaction.objectStore(RECORD_STORE).delete(recordID);
    await done;
    this.eventsCache = decoded.filter(({ payload }) => payload?.kind === "event").map(({ payload }) => validatePlaybackEvent(payload.value)).filter((event) => event.occurredAtMs >= beforeMs)
      .sort(comparePlaybackEvents);
  }
  async exportData(settings = {}) {
    this.eventsCache = null;
    const playbackEvents = (await this.listEvents()).filter((event) => !isUnidentifiedYouTubeURL(event.url));
    return Object.freeze({ schemaVersion: 2, exportedAtMs: Date.now(), settings: safeSettingsExport(settings), playbackEvents });
  }
  async resetSecureStorage() {
    await this.open();
    const transaction = this.database.transaction([RECORD_STORE, KEY_STORE], "readwrite");
    const done = transactionDone(transaction);
    transaction.objectStore(RECORD_STORE).clear();
    transaction.objectStore(KEY_STORE).clear();
    await done;
    this.keyPromise = null;
    this.stateCache = null;
    this.eventsCache = [];
    await this.#key();
    await this.setState(defaultState());
    return this.getState();
  }
  async deleteAll() {
    await this.open();
    const read = this.database.transaction(RECORD_STORE, "readonly");
    const readDone = transactionDone(read);
    const envelopes = await requestPromise(read.objectStore(RECORD_STORE).getAll());
    await readDone;
    const eventIDs = envelopes.map((envelope) => envelope?.recordID).filter((recordID) => typeof recordID === "string" && recordID !== STATE_RECORD_ID);
    if (!eventIDs.length) return;
    const transaction = this.database.transaction(RECORD_STORE, "readwrite");
    const done = transactionDone(transaction);
    for (const recordID of eventIDs) transaction.objectStore(RECORD_STORE).delete(recordID);
    await done;
    this.eventsCache = [];
  }
}
