/**
 * A large job: a list of Reddit posts to download, imported from a file, with
 * each post's progress kept in its own IndexedDB record.
 *
 * The page list keeps its progress in one storage item rewritten on every
 * change, which is fine for a hundred pages and hopeless for a hundred
 * thousand posts. Here each status change writes only the posts it touches,
 * and "what's next" is read off an index, so a job of any size stops and
 * resumes in place.
 */

export type JobStatus =
  /** Still to do. */
  | "pending"
  /** Downloaded by this job. */
  | "done"
  /** Already in the download history when the job reached it (or at import). */
  | "already"
  /** In the "skip these" file given at import. */
  | "excluded"
  /** The download failed; "Retry failed" puts these back to pending. */
  | "failed"
  /** Reddit has nothing to download: removed, deleted, a text post, an
   * unsupported host, or filtered out by the media type setting. */
  | "no-media";

export type JobLink = {
  postId: string;
  /** Import order, so the job runs in the file's order. */
  seq: number;
  status: JobStatus;
  /** Why it failed or had nothing, when known. */
  reason?: string;
  updatedAt: number;
};

export type JobMeta = {
  name: string;
  /** Where the links came from, e.g. "posts.db › submissions.permalink". */
  source: string;
  createdAt: number;
  total: number;
};

const DB_NAME = "redditgrab-jobs";
const LINKS = "links";
const META = "meta";
let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = () => {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const links = db.createObjectStore(LINKS, { keyPath: "postId" });
      // Status then import order: the next pending posts, in file order.
      links.createIndex("status_seq", ["status", "seq"]);
      db.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
  });
  return dbPromise;
};

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

const result = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Replace any existing job with a new one. */
export const createJob = async (
  meta: Omit<JobMeta, "total" | "createdAt">,
  links: { postId: string; status: JobStatus }[],
) => {
  const db = await openDb();
  const now = Date.now();
  const tx = db.transaction([LINKS, META], "readwrite");
  tx.objectStore(LINKS).clear();
  const store = tx.objectStore(LINKS);
  links.forEach((link, seq) => store.put({ ...link, seq, updatedAt: now }));
  tx.objectStore(META).put({ ...meta, createdAt: now, total: links.length }, "job");
  await done(tx);
};

export const getJobMeta = async (): Promise<JobMeta | null> => {
  const db = await openDb();
  return ((await result(db.transaction(META).objectStore(META).get("job"))) as JobMeta) ?? null;
};

const STATUSES: JobStatus[] = ["pending", "done", "already", "excluded", "failed", "no-media"];

/** How many posts are in each state. */
export const countJob = async (): Promise<Record<JobStatus, number>> => {
  const db = await openDb();
  const index = db.transaction(LINKS).objectStore(LINKS).index("status_seq");
  const counts = {} as Record<JobStatus, number>;
  for (const status of STATUSES) {
    counts[status] = await result(
      index.count(IDBKeyRange.bound([status, -Infinity], [status, Infinity])),
    );
  }
  return counts;
};

/** The next `limit` pending posts, in import order. */
export const nextPending = async (limit: number): Promise<JobLink[]> => {
  const db = await openDb();
  const index = db.transaction(LINKS).objectStore(LINKS).index("status_seq");
  return result(
    index.getAll(IDBKeyRange.bound(["pending", -Infinity], ["pending", Infinity]), limit),
  ) as Promise<JobLink[]>;
};

/** Set the status of some posts. */
export const setStatuses = async (
  updates: { postId: string; status: JobStatus; reason?: string }[],
) => {
  if (updates.length === 0) return;
  const db = await openDb();
  const tx = db.transaction(LINKS, "readwrite");
  const store = tx.objectStore(LINKS);
  const now = Date.now();
  for (const update of updates) {
    const existing = (await result(store.get(update.postId))) as JobLink | undefined;
    if (!existing) continue;
    store.put({ ...existing, status: update.status, reason: update.reason, updatedAt: now });
  }
  await done(tx);
};

/** Every post in one state, e.g. to export what's left or what failed. */
export const postsWithStatus = async (status: JobStatus): Promise<JobLink[]> => {
  const db = await openDb();
  const index = db.transaction(LINKS).objectStore(LINKS).index("status_seq");
  return result(
    index.getAll(IDBKeyRange.bound([status, -Infinity], [status, Infinity])),
  ) as Promise<JobLink[]>;
};

/** Put every failed post back to pending. Returns how many. */
export const retryFailed = async () => {
  const failed = await postsWithStatus("failed");
  await setStatuses(failed.map((link) => ({ postId: link.postId, status: "pending" })));
  return failed.length;
};

export const clearJob = async () => {
  const db = await openDb();
  const tx = db.transaction([LINKS, META], "readwrite");
  tx.objectStore(LINKS).clear();
  tx.objectStore(META).delete("job");
  await done(tx);
};
