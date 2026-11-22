import initSqlJs, { type Database, type SqlJsStatic } from "sql.js";
import { logger } from "./logger";
import { readExtensionFolderFile, writeExtensionFolderFile } from "./extension-folder";
import { createBlobUrl, downloadAndRelease } from "./blob-utils";
import { permalinkForPostId } from "./diagnostics";
import { historySyncedAt, processedPostIds } from "./storage";

/**
 * A record of every post downloaded, kept so the download history can be
 * rebuilt if Firefox erases it.
 *
 * Firefox wipes a temporarily loaded add-on's storage when it closes, and the
 * processed-posts list — what stops a post being downloaded twice — went with
 * it. Each download is now recorded in the extension's IndexedDB as it
 * happens, and the whole record is written out as a SQLite database,
 * redditgrab-history.sqlite, in the extension's own folder. On every start the
 * extension reads that file back and restores the processed list from it.
 *
 * SQLite because the file is also for you: open it in DB Browser for SQLite,
 * the sqlite3 shell or Python, query it, or feed the links to something else.
 */

export const HISTORY_FILE_NAME = "redditgrab-history.sqlite";
const FORMAT = "redditgrab-history";
const VERSION = 1;

export type HistoryRecord = {
  /** Reddit thing id, e.g. t3_1n2o8dd — the same id the processed list uses. */
  postId: string;
  permalink?: string;
  subreddit?: string;
  title?: string;
  author?: string;
  mediaType?: string;
  /** Where the media came from. */
  urls: string[];
  /** Where Firefox saved it. */
  files: string[];
  /** The folder setting the download used. */
  folder?: string;
  /** When it was downloaded (ms). 0 when only the id is known. */
  downloadedAt: number;
  /**
   * download: recorded as it happened. history: carried over from the
   * processed-posts list, which only kept ids. imported: from a file.
   */
  source: "download" | "history" | "imported";
};

// ---------------------------------------------------------------- IndexedDB

const DB_NAME = "redditgrab";
const STORE = "downloads";
let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = () => {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE, { keyPath: "postId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
};

const requestToPromise = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

export const countRecords = async () => {
  const db = await openDb();
  return requestToPromise(db.transaction(STORE).objectStore(STORE).count());
};

export const getAllRecords = async (): Promise<HistoryRecord[]> => {
  const db = await openDb();
  return requestToPromise(db.transaction(STORE).objectStore(STORE).getAll());
};

const getAllKeys = async (): Promise<Set<string>> => {
  const db = await openDb();
  const keys = await requestToPromise(
    db.transaction(STORE).objectStore(STORE).getAllKeys(),
  );
  return new Set(keys.map(String));
};

/**
 * Add records. A record that is already there is only replaced by one that
 * says more: a real download beats an id carried over or imported, and a
 * later download beats an earlier one.
 */
const putRecords = async (records: HistoryRecord[]) => {
  if (records.length === 0) return 0;
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  let written = 0;
  for (const record of records) {
    const existing = (await requestToPromise(store.get(record.postId))) as
      | HistoryRecord
      | undefined;
    if (existing && !isBetter(record, existing)) continue;
    store.put(record);
    written += 1;
  }
  await transactionDone(tx);
  return written;
};

const isBetter = (incoming: HistoryRecord, existing: HistoryRecord) => {
  const rank = (r: HistoryRecord) => (r.source === "download" ? 2 : r.urls.length ? 1 : 0);
  if (rank(incoming) !== rank(existing)) return rank(incoming) > rank(existing);
  return incoming.downloadedAt > existing.downloadedAt;
};

export const clearRecords = async () => {
  const db = await openDb();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).clear();
  await transactionDone(tx);
};

// ------------------------------------------------------------- recording

/** Record a finished download, and schedule the file on disk to be updated. */
export const recordDownload = async (record: Omit<HistoryRecord, "source">) => {
  try {
    await putRecords([{ ...record, source: "download" }]);
    scheduleHistoryFileWrite();
  } catch (error) {
    // The download itself worked; never fail it over the record of it.
    logger.error("Could not record the download in the history database:", error);
  }
};

/**
 * Give every id already in the processed list a record, so the file holds the
 * whole history from the first save — including everything downloaded before
 * this feature existed, of which only the ids were kept.
 */
export const backfillFromProcessedList = async () => {
  const [ids, known] = await Promise.all([processedPostIds.getValue(), getAllKeys()]);
  const missing = ids.filter((id) => !known.has(id));
  await putRecords(
    missing.map((postId) => ({
      postId,
      permalink: permalinkForPostId(postId),
      urls: [],
      files: [],
      downloadedAt: 0,
      source: "history" as const,
    })),
  );
  return missing.length;
};

/** Put the given ids into the processed list, keeping what's there. */
const mergeIntoProcessedList = async (ids: string[]) => {
  const current = await processedPostIds.getValue();
  const merged = new Set(current);
  const before = merged.size;
  for (const id of ids) merged.add(id);
  if (merged.size !== before) await processedPostIds.setValue([...merged]);
  return merged.size - before;
};

// ---------------------------------------------------------------- SQLite

let sqlPromise: Promise<SqlJsStatic> | null = null;
const loadSql = () => {
  sqlPromise ??= initSqlJs({
    locateFile: () => browser.runtime.getURL("/sqljs/sql-wasm.wasm"),
  });
  return sqlPromise;
};

const SCHEMA = `
CREATE TABLE downloads (
  post_id TEXT PRIMARY KEY,   -- Reddit thing id, e.g. t3_1n2o8dd
  permalink TEXT,
  subreddit TEXT,
  title TEXT,
  author TEXT,
  media_type TEXT,
  urls TEXT,                  -- JSON array: where the media came from
  files TEXT,                 -- JSON array: where Firefox saved it
  folder TEXT,
  downloaded_at INTEGER,      -- ms since 1970; 0 when only the id is known
  downloaded_at_iso TEXT,
  source TEXT                 -- download | history | imported
);
CREATE INDEX downloads_subreddit ON downloads (subreddit);
CREATE INDEX downloads_downloaded_at ON downloads (downloaded_at);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

/** Build the SQLite file for a set of records. */
export const buildHistoryDatabase = async (
  records: HistoryRecord[],
  exportedAt: number,
): Promise<Uint8Array> => {
  const SQL = await loadSql();
  const db = new SQL.Database();
  try {
    db.run(SCHEMA);
    db.run("BEGIN");
    const insert = db.prepare(
      "INSERT OR REPLACE INTO downloads VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of records) {
      insert.run([
        r.postId,
        r.permalink ?? null,
        r.subreddit ?? null,
        r.title ?? null,
        r.author ?? null,
        r.mediaType ?? null,
        JSON.stringify(r.urls ?? []),
        JSON.stringify(r.files ?? []),
        r.folder ?? null,
        r.downloadedAt ?? 0,
        r.downloadedAt ? new Date(r.downloadedAt).toISOString() : null,
        r.source,
      ]);
    }
    insert.free();
    const meta = db.prepare("INSERT INTO meta VALUES (?, ?)");
    meta.run(["format", FORMAT]);
    meta.run(["version", String(VERSION)]);
    meta.run(["exported_at", String(exportedAt)]);
    meta.run(["exported_at_iso", new Date(exportedAt).toISOString()]);
    meta.free();
    db.run("COMMIT");
    return db.export();
  } finally {
    db.close();
  }
};

const parseJsonArray = (value: unknown): string[] => {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
};

/** Read records out of a history database. */
export const readHistoryDatabase = async (
  bytes: Uint8Array,
): Promise<{ records: HistoryRecord[]; exportedAt: number | null }> => {
  const SQL = await loadSql();
  let db: Database;
  try {
    db = new SQL.Database(bytes);
  } catch {
    throw new Error("the file isn't a SQLite database");
  }
  try {
    const tables = db.exec(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='downloads'",
    );
    if (!tables.length) {
      throw new Error("the database has no downloads table, so it isn't a RedditGrab history file");
    }
    let exportedAt: number | null = null;
    try {
      const meta = db.exec("SELECT value FROM meta WHERE key='exported_at'");
      const value = Number(meta[0]?.values[0]?.[0]);
      if (Number.isFinite(value)) exportedAt = value;
    } catch {}

    const records: HistoryRecord[] = [];
    const rows = db.prepare(
      "SELECT post_id, permalink, subreddit, title, author, media_type, urls, files, folder, downloaded_at, source FROM downloads",
    );
    while (rows.step()) {
      const [postId, permalink, subreddit, title, author, mediaType, urls, files, folder, downloadedAt, source] =
        rows.get();
      if (typeof postId !== "string" || !postId) continue;
      records.push({
        postId,
        permalink: (permalink as string) ?? undefined,
        subreddit: (subreddit as string) ?? undefined,
        title: (title as string) ?? undefined,
        author: (author as string) ?? undefined,
        mediaType: (mediaType as string) ?? undefined,
        urls: parseJsonArray(urls),
        files: parseJsonArray(files),
        folder: (folder as string) ?? undefined,
        downloadedAt: Number(downloadedAt) || 0,
        source: source === "download" ? "download" : source === "history" ? "history" : "imported",
      });
    }
    rows.free();
    return { records, exportedAt };
  } finally {
    db.close();
  }
};

/**
 * Pull post ids out of plain text: Reddit links (comments/<id>), thing ids
 * (t3_<id>), one or many per line. Covers the RETRY LIST, link lists from
 * other tools and exports from your own archives.
 */
export const idsFromText = (text: string): string[] => {
  const ids = new Set<string>();
  for (const match of text.matchAll(/(?:comments\/|\bt3_)([a-z0-9]{4,10})\b/gi)) {
    ids.add(`t3_${match[1].toLowerCase()}`);
  }
  return [...ids];
};

// ------------------------------------------------------------ the file

const WRITE_DELAY_MS = 5 * 60 * 1000;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<HistoryFileResult> | null = null;

export type HistoryFileResult = {
  savedTo: string;
  records: number;
  /** Whether the extension can read the file back, i.e. restore from it. */
  readable: boolean;
};

/**
 * Write the history file a few minutes after the latest download, so a run
 * doesn't rewrite it per post but never leaves it far behind. The end of a
 * run writes it straight away.
 */
export const scheduleHistoryFileWrite = () => {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void writeHistoryFile().catch((error) =>
      logger.error("Could not write the history file:", error),
    );
  }, WRITE_DELAY_MS);
};

/** Write the whole history to redditgrab-history.sqlite now. */
export const writeHistoryFile = async (): Promise<HistoryFileResult> => {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  // One write at a time; a second caller waits for, then repeats, the first.
  while (writing) await writing.catch(() => {});
  writing = (async () => {
    await backfillFromProcessedList();
    const records = await getAllRecords();
    const exportedAt = Date.now();
    let bytes: Uint8Array | null = await buildHistoryDatabase(records, exportedAt);
    const blob = new Blob([bytes as BlobPart], { type: "application/vnd.sqlite3" });
    bytes = null;
    const savedTo = await writeExtensionFolderFile(HISTORY_FILE_NAME, blob);
    await historySyncedAt.setValue(exportedAt);
    const check = await readExtensionFolderFile(HISTORY_FILE_NAME);
    const readable = !!check && (await check.arrayBuffer()).byteLength === blob.size;
    logger.always(`History file written: ${records.length} posts → ${savedTo}`);
    return { savedTo, records: records.length, readable };
  })();
  try {
    return await writing;
  } finally {
    writing = null;
  }
};

export type HistoryImportResult = {
  records: number;
  /** Ids newly added to the processed list. */
  restoredIds: number;
};

/** Merge records into the database and their ids into the processed list. */
export const importRecords = async (
  records: HistoryRecord[],
): Promise<HistoryImportResult> => {
  await putRecords(records);
  const restoredIds = await mergeIntoProcessedList(records.map((r) => r.postId));
  return { records: records.length, restoredIds };
};

/** Import a file the user picked: a history database or a text list of links. */
export const importHistoryFromFile = async (file: File) => {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isSqlite = new TextDecoder().decode(head).startsWith("SQLite format 3");
  if (isSqlite) {
    const { records } = await readHistoryDatabase(new Uint8Array(await file.arrayBuffer()));
    return importRecords(records.map((r) => ({ ...r, source: r.source })));
  }
  const ids = idsFromText(await file.text());
  if (ids.length === 0) {
    throw new Error("found no Reddit post links or t3_ ids in the file");
  }
  return importRecords(
    ids.map((postId) => ({
      postId,
      permalink: permalinkForPostId(postId),
      urls: [],
      files: [],
      downloadedAt: 0,
      source: "imported" as const,
    })),
  );
};

export type HistoryAutoImport =
  | { status: "none" }
  | { status: "up-to-date" }
  | ({ status: "imported"; exportedAt: number | null } & HistoryImportResult);

/**
 * Restore from the history file in the extension's folder when it's newer than
 * what was last written or read here — after Firefox wipes storage, always.
 */
export const autoImportHistory = async (): Promise<HistoryAutoImport> => {
  const response = await readExtensionFolderFile(HISTORY_FILE_NAME);
  if (!response) return { status: "none" };
  const { records, exportedAt } = await readHistoryDatabase(
    new Uint8Array(await response.arrayBuffer()),
  );
  const syncedAt = await historySyncedAt.getValue();
  if (syncedAt !== null && exportedAt !== null && exportedAt <= syncedAt) {
    return { status: "up-to-date" };
  }
  const result = await importRecords(records);
  await historySyncedAt.setValue(exportedAt ?? Date.now());
  logger.always(
    `History restored from ${HISTORY_FILE_NAME}: ${result.records} posts, ${result.restoredIds} added back to the processed list.`,
  );
  return { status: "imported", exportedAt, ...result };
};

/**
 * Empty the history everywhere — database, file on disk — for "Clear
 * processed posts history". Without the file being emptied too, the next
 * Firefox start would restore everything that was just cleared.
 */
export const clearHistoryEverywhere = async () => {
  // A copy of what's about to go, in the normal downloads folder, in case the
  // clear was a mistake. Import it from the sidebar to undo.
  const records = await getAllRecords();
  if (records.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const bytes = await buildHistoryDatabase(records, Date.now());
    const url = await createBlobUrl(new Blob([bytes as BlobPart]));
    await downloadAndRelease(url, `RedditGrab/redditgrab-history-backup-${stamp}.sqlite`);
  }
  await clearRecords();
  await processedPostIds.setValue([]);
  return writeHistoryFile();
};
