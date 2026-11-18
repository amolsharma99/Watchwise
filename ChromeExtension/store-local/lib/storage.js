import { validatePlaybackEvent } from "./validation.js";
import { safeSettingsExport } from "./settings.js";
import { isUnidentifiedYouTubeURL } from "./youtube.js";

export const DATABASE_NAME = "watchwise-local";
export const DATABASE_VERSION = 1;
export const EVENT_STORE = "playbackEvents";

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

function hasStore(database, name) { return database.objectStoreNames.contains(name); }
function ensureIndex(store, name, keyPath) { if (!store.indexNames.contains(name)) store.createIndex(name, keyPath); }

export function upgradeLocalDatabase(database, transaction) {
  const events = hasStore(database, EVENT_STORE)
    ? transaction.objectStore(EVENT_STORE)
    : database.createObjectStore(EVENT_STORE, { keyPath: "eventID" });
  ensureIndex(events, "byOccurredAt", "occurredAtMs");
  ensureIndex(events, "byPageSite", "pageSite");
  ensureIndex(events, "bySessionOccurred", ["sessionID", "occurredAtMs"]);
  ensureIndex(events, "byPlayerOccurred", ["tabID", "frameID", "playerID", "occurredAtMs"]);
}

export class IndexedDBRepository {
  constructor({ indexedDBFactory = globalThis.indexedDB, dbName = DATABASE_NAME } = {}) {
    if (!indexedDBFactory) throw new Error("IndexedDB is unavailable");
    this.indexedDB = indexedDBFactory;
    this.dbName = dbName;
    this.database = null;
    this.openPromise = null;
  }

  async open() {
    if (this.database) return this;
    if (this.openPromise) return this.openPromise;
    const request = this.indexedDB.open(this.dbName, DATABASE_VERSION);
    request.onupgradeneeded = () => upgradeLocalDatabase(request.result, request.transaction);
    const pending = requestPromise(request).then((database) => {
      this.database = database;
      database.onversionchange = () => { database.close(); this.database = null; this.openPromise = null; };
      return this;
    }).catch((error) => { this.database = null; throw error; });
    this.openPromise = pending;
    try { return await pending; } finally { if (this.openPromise === pending) this.openPromise = null; }
  }

  async putEvent(event) {
    await this.open();
    const transaction = this.database.transaction(EVENT_STORE, "readwrite");
    transaction.objectStore(EVENT_STORE).put(validatePlaybackEvent(event));
    await transactionDone(transaction);
  }

  async listEvents(startMs = -Infinity, endMs = Infinity) {
    await this.open();
    const transaction = this.database.transaction(EVENT_STORE, "readonly");
    const values = await requestPromise(transaction.objectStore(EVENT_STORE).getAll());
    await transactionDone(transaction);
    return values.filter((event) => event.occurredAtMs >= startMs && event.occurredAtMs < endMs)
      .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventID.localeCompare(b.eventID));
  }

  async prune(beforeMs) {
    if (!Number.isFinite(beforeMs)) throw new TypeError("invalid prune timestamp");
    const events = await this.listEvents();
    const transaction = this.database.transaction(EVENT_STORE, "readwrite");
    for (const event of events) if (event.occurredAtMs < beforeMs) transaction.objectStore(EVENT_STORE).delete(event.eventID);
    await transactionDone(transaction);
  }

  async exportData(settings = {}) {
    const playbackEvents = (await this.listEvents()).filter((event) => !isUnidentifiedYouTubeURL(event.url));
    return Object.freeze({ schemaVersion: 2, exportedAtMs: Date.now(), settings: safeSettingsExport(settings), playbackEvents });
  }

  async deleteAll() {
    await this.open();
    const transaction = this.database.transaction(EVENT_STORE, "readwrite");
    transaction.objectStore(EVENT_STORE).clear();
    await transactionDone(transaction);
  }
}
