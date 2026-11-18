import { validatePlaybackEvent } from "./validation.js";
import { validateAnalysisJob, validateAnalysisResult } from "./analysis.js";
import { safeSettingsExport } from "./settings.js";
import { isUnidentifiedYouTubeURL } from "./auto-analysis.js";

export const DATABASE_NAME = "watchwise";
export const DATABASE_VERSION = 4;
export const STORES = Object.freeze({ EVENTS: "playbackEvents", JOBS: "analysisJobs", RESULTS: "analysisResults" });

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

function ensureIndex(store, name, keyPath, options = {}) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, options);
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
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      let events;
      if (!database.objectStoreNames.contains(STORES.EVENTS)) {
        events = database.createObjectStore(STORES.EVENTS, { keyPath: "eventID" });
      } else events = transaction.objectStore(STORES.EVENTS);
      ensureIndex(events, "byOccurredAt", "occurredAtMs");
      ensureIndex(events, "byPageSite", "pageSite");
      ensureIndex(events, "bySessionOccurred", ["sessionID", "occurredAtMs"]);
      ensureIndex(events, "byPlayerOccurred", ["tabID", "frameID", "playerID", "occurredAtMs"]);

      let jobs;
      if (!database.objectStoreNames.contains(STORES.JOBS)) jobs = database.createObjectStore(STORES.JOBS, { keyPath: "jobID" });
      else jobs = transaction.objectStore(STORES.JOBS);
      ensureIndex(jobs, "byStatus", "status");
      ensureIndex(jobs, "byUpdatedAt", "updatedAtMs");
      ensureIndex(jobs, "byURL", "url");

      let results;
      if (!database.objectStoreNames.contains(STORES.RESULTS)) results = database.createObjectStore(STORES.RESULTS, { keyPath: "jobID" });
      else results = transaction.objectStore(STORES.RESULTS);
      ensureIndex(results, "byCompletedAt", "completedAtMs");
      void event.oldVersion; // Documents that this upgrade function handles all prior versions.
    };
    const pending = requestPromise(request).then((database) => {
      this.database = database;
      database.onversionchange = () => {
        database.close();
        if (this.database === database) this.database = null;
        this.openPromise = null;
      };
      return this;
    }).catch((error) => {
      this.database = null;
      throw error;
    });
    this.openPromise = pending;
    try { return await pending; }
    finally { if (this.openPromise === pending) this.openPromise = null; }
  }

  async putEvent(event) { await this.#put(STORES.EVENTS, validatePlaybackEvent(event)); }
  async putAnalysisJob(job) { validateAnalysisJob(job); await this.#put(STORES.JOBS, job); }
  async putAnalysisResult(result) { await this.#put(STORES.RESULTS, validateAnalysisResult(result)); }
  async getAnalysisJob(jobID) { return this.#get(STORES.JOBS, jobID); }
  async getAnalysisResult(jobID) { return this.#get(STORES.RESULTS, jobID); }

  async listEvents(startMs = -Infinity, endMs = Infinity) {
    const values = await this.#all(STORES.EVENTS);
    return values.filter((event) => event.occurredAtMs >= startMs && event.occurredAtMs < endMs)
      .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventID.localeCompare(b.eventID));
  }

  async listAnalysisJobs() {
    return (await this.#all(STORES.JOBS)).sort((a, b) => a.createdAtMs - b.createdAtMs || a.jobID.localeCompare(b.jobID));
  }

  async listAnalysisJobsForURL(url) {
    return (await this.listAnalysisJobs()).filter((job) => job.url === url);
  }

  async prune(beforeMs) {
    if (!Number.isFinite(beforeMs)) throw new TypeError("invalid prune timestamp");
    await this.open();
    const events = await this.#all(STORES.EVENTS);
    const jobs = await this.#all(STORES.JOBS);
    const results = await this.#all(STORES.RESULTS);
    const terminal = new Set(["succeeded", "failed", "cancelled"]);
    const transaction = this.database.transaction(Object.values(STORES), "readwrite");
    for (const event of events) if (event.occurredAtMs < beforeMs) transaction.objectStore(STORES.EVENTS).delete(event.eventID);
    for (const job of jobs) if (terminal.has(job.status) && job.updatedAtMs < beforeMs) transaction.objectStore(STORES.JOBS).delete(job.jobID);
    for (const result of results) if (result.completedAtMs < beforeMs) transaction.objectStore(STORES.RESULTS).delete(result.jobID);
    await transactionDone(transaction);
  }

  async exportData(settings = {}) {
    const playbackEvents = (await this.#all(STORES.EVENTS)).filter((event) => !isUnidentifiedYouTubeURL(event.url));
    return Object.freeze({
      schemaVersion: 1,
      exportedAtMs: Date.now(),
      settings: safeSettingsExport(settings),
      playbackEvents,
      analysisJobs: await this.#all(STORES.JOBS),
      analysisResults: await this.#all(STORES.RESULTS)
    });
  }

  async deleteAll() {
    await this.open();
    const transaction = this.database.transaction(Object.values(STORES), "readwrite");
    for (const store of Object.values(STORES)) transaction.objectStore(store).clear();
    await transactionDone(transaction);
  }

  async #put(storeName, value) {
    await this.open();
    const transaction = this.database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    await transactionDone(transaction);
  }

  async #get(storeName, key) {
    await this.open();
    const transaction = this.database.transaction(storeName, "readonly");
    return requestPromise(transaction.objectStore(storeName).get(key));
  }

  async #all(storeName) {
    await this.open();
    const transaction = this.database.transaction(storeName, "readonly");
    return requestPromise(transaction.objectStore(storeName).getAll());
  }
}

export class InMemoryRepository {
  constructor() {
    this.events = new Map();
    this.jobs = new Map();
    this.results = new Map();
  }
  async open() { return this; }
  async putEvent(event) { const value = validatePlaybackEvent(event); this.events.set(value.eventID, value); }
  async putAnalysisJob(job) { validateAnalysisJob(job); this.jobs.set(job.jobID, Object.freeze({ ...job })); }
  async putAnalysisResult(result) { const value = validateAnalysisResult(result); this.results.set(value.jobID, value); }
  async getAnalysisJob(jobID) { return this.jobs.get(jobID); }
  async getAnalysisResult(jobID) { return this.results.get(jobID); }
  async listEvents(startMs = -Infinity, endMs = Infinity) {
    return [...this.events.values()].filter((event) => event.occurredAtMs >= startMs && event.occurredAtMs < endMs)
      .sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.eventID.localeCompare(b.eventID));
  }
  async listAnalysisJobs() { return [...this.jobs.values()].sort((a, b) => a.createdAtMs - b.createdAtMs || a.jobID.localeCompare(b.jobID)); }
  async listAnalysisJobsForURL(url) { return (await this.listAnalysisJobs()).filter((job) => job.url === url); }
  async prune(beforeMs) {
    if (!Number.isFinite(beforeMs)) throw new TypeError("invalid prune timestamp");
    for (const [key, event] of this.events) if (event.occurredAtMs < beforeMs) this.events.delete(key);
    for (const [key, job] of this.jobs) if (["succeeded", "failed", "cancelled"].includes(job.status) && job.updatedAtMs < beforeMs) this.jobs.delete(key);
    for (const [key, result] of this.results) if (result.completedAtMs < beforeMs) this.results.delete(key);
  }
  async exportData(settings = {}) {
    const playbackEvents = (await this.listEvents()).filter((event) => !isUnidentifiedYouTubeURL(event.url));
    return Object.freeze({ schemaVersion: 1, exportedAtMs: Date.now(), settings: safeSettingsExport(settings), playbackEvents, analysisJobs: await this.listAnalysisJobs(), analysisResults: [...this.results.values()] });
  }
  async deleteAll() { this.events.clear(); this.jobs.clear(); this.results.clear(); }
}
