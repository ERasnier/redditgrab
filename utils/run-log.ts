import { storage } from "#imports";
import { logger } from "./logger";
import { createTextFileUrl, downloadAndRelease } from "./blob-utils";
import {
  isFailure,
  SKIP_REASON_TEXT,
  type PostDiagnostic,
} from "./diagnostics";
import { sanitizeDownloadPath } from "./filename-utils";

/**
 * A log of a run, written to disk as it goes.
 *
 * The diagnostics report was assembled in the sidebar and only reached disk
 * when the button was pressed, so anything that ended the run early — a crash,
 * a closed sidebar, Firefox restarting during an overnight watch — took the
 * whole account of it. Entries are now appended to extension storage the moment
 * they happen, which survives all of those, and flushed to a per-run file on
 * disk so the record exists without anyone having to ask for it.
 *
 * There is no append in the downloads API, so the file is rewritten whole with
 * `conflictAction: "overwrite"`. That is throttled: a write puts an entry in
 * Firefox's downloads panel, and one per error would be unusable.
 */

export type RunLogEntry = {
  at: number;
  kind: "run" | "failure" | "note";
  text: string;
  postId?: string;
  permalink?: string;
};

type RunLogState = {
  /** Timestamp the run started, used for the filename. */
  runId: string;
  startedAt: number;
  url: string;
  entries: RunLogEntry[];
  downloaded: number;
  failed: number;
  /** True once the run has ended, so a stale log isn't resumed. */
  finished: boolean;
};

/**
 * Entries are capped so a pathological run cannot grow storage without bound.
 * Failures are what the log is for, and in practice number in the dozens.
 */
const MAX_ENTRIES = 2000;
/**
 * Minimum gap between disk writes while a run is going.
 *
 * Each write is an entry in Firefox's downloads panel, so this is a trade
 * against how fresh the file is. Two minutes suits reading the log after the
 * fact rather than tailing it live; the first failure and the end of the run
 * bypass it either way, so nothing waits on the interval to be recorded.
 */
const FLUSH_INTERVAL_MS = 120_000;

const runLogState = storage.defineItem<RunLogState | null>(
  "local:runLogState",
  { fallback: null },
);

let state: RunLogState | null = null;
let dirty = false;
let lastFlushAt = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

const fileNameFor = (runId: string) =>
  sanitizeDownloadPath(`RedditGrab/run-${runId}.log`);

/** Human-readable timestamp, safe in a filename. */
const stampFor = (date: Date) =>
  date.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);

export const startRunLog = async (url: string) => {
  const now = new Date();
  state = {
    runId: stampFor(now),
    startedAt: now.getTime(),
    url,
    entries: [
      {
        at: now.getTime(),
        kind: "run",
        text: `Run started on ${url}`,
      },
    ],
    downloaded: 0,
    failed: 0,
    finished: false,
  };
  dirty = true;
  lastFlushAt = 0;
  await persist();
  logger.always(`Run log: ${fileNameFor(state.runId)}`);
};

/** Mirror to storage, which is what makes the log survive losing the sidebar. */
const persist = async () => {
  if (!state) return;
  try {
    await runLogState.setValue(state);
  } catch (error) {
    // Never let logging break the run it is describing.
    logger.warn("Could not persist the run log", error);
  }
};

const append = async (entry: RunLogEntry) => {
  if (!state) return;
  if (state.entries.length < MAX_ENTRIES) {
    state.entries.push(entry);
  } else if (state.entries.length === MAX_ENTRIES) {
    state.entries.push({
      at: entry.at,
      kind: "note",
      text: `Entry limit of ${MAX_ENTRIES} reached; further entries are counted but not listed.`,
    });
  }
  dirty = true;
  await persist();
};

/** Record a post that failed, with everything needed to go back to it. */
export const logRunFailure = async (record: PostDiagnostic) => {
  if (!state) return;
  state.failed += 1;
  const reason = SKIP_REASON_TEXT[record.reason] ?? record.reason;
  const where = [
    record.subreddit ? `r/${record.subreddit}` : null,
    record.source ? `via ${record.source}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  await append({
    at: record.at,
    kind: "failure",
    postId: record.postId,
    permalink: record.permalink,
    text:
      `${record.reason} — ${reason}` +
      (where ? `\n    ${where}` : "") +
      (record.title ? `\n    ${record.title}` : "") +
      (record.detail ? `\n    detail: ${record.detail}` : ""),
  });
  // A failure is the thing worth seeing promptly, so bypass the throttle for
  // the first one; later ones ride the normal interval.
  await maybeFlush({ force: state.failed === 1 });
};

export const logRunNote = async (text: string) => {
  await append({ at: Date.now(), kind: "note", text });
  await maybeFlush();
};

export const noteDownloaded = async (count: number) => {
  if (!state) return;
  state.downloaded = count;
  dirty = true;
  // Counts alone don't justify a write; they ride along with the next one.
  await persist();
};

/** Render the log as the text that goes in the file. */
export const formatRunLog = (snapshot: RunLogState): string => {
  const lines: string[] = [];
  lines.push("RedditGrab run log");
  lines.push(`Run started: ${new Date(snapshot.startedAt).toISOString()}`);
  lines.push(`Page: ${snapshot.url}`);
  lines.push(
    `Status: ${snapshot.finished ? "finished" : "in progress"} — ` +
      `${snapshot.downloaded} downloaded, ${snapshot.failed} failed`,
  );
  lines.push(`Updated: ${new Date().toISOString()}`);
  lines.push("");

  const failures = snapshot.entries.filter((entry) => entry.kind === "failure");
  if (failures.length > 0) {
    lines.push("RETRY LIST");
    lines.push("==========");
    lines.push("One post per line, nothing else on these lines:");
    lines.push("");
    for (const entry of failures) {
      if (entry.permalink) lines.push(entry.permalink);
    }
    lines.push("");
  }

  lines.push("ENTRIES");
  lines.push("=======");
  for (const entry of snapshot.entries) {
    const time = new Date(entry.at).toISOString();
    const head = entry.postId ? `${entry.postId}  ` : "";
    lines.push(`${time}  ${entry.kind.toUpperCase()}  ${head}${entry.text}`);
    if (entry.permalink) lines.push(`    ${entry.permalink}`);
  }

  return lines.join("\n") + "\n";
};

const writeToDisk = async () => {
  if (!state) return;
  const snapshot = state;
  let url: string | null = null;
  try {
    url = createTextFileUrl(formatRunLog(snapshot), "text/plain;charset=utf-8");
    // No append in the downloads API, so the file is replaced each time.
    await downloadAndRelease(url, fileNameFor(snapshot.runId), {
      conflictAction: "overwrite",
    });
    url = null;
    lastFlushAt = Date.now();
    dirty = false;
  } catch (error) {
    // Keep `dirty` set so the next attempt retries; a failed log write must
    // never fail the run.
    logger.warn("Could not write the run log to disk", error);
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }
  }
};

const maybeFlush = async ({ force = false } = {}) => {
  if (!state || !dirty) return;

  const since = Date.now() - lastFlushAt;
  if (force || since >= FLUSH_INTERVAL_MS) {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await writeToDisk();
    return;
  }

  // Too soon: make sure the pending entries still reach disk shortly.
  if (!flushTimer) {
    flushTimer = setTimeout(
      () => {
        flushTimer = null;
        void writeToDisk();
      },
      FLUSH_INTERVAL_MS - since,
    );
  }
};

/** Close the log out and make sure the final state is on disk. */
export const finishRunLog = async (note: string) => {
  if (!state) return;
  state.finished = true;
  await append({ at: Date.now(), kind: "run", text: note });
  await maybeFlush({ force: true });
  logger.always(`Run log written: ${fileNameFor(state.runId)}`);
};

/**
 * A log left behind by a run that never finished — the sidebar was closed, or
 * Firefox stopped. Lets the next session offer to write it out.
 */
export const recoverUnfinishedRunLog = async (): Promise<RunLogState | null> => {
  try {
    const saved = await runLogState.getValue();
    if (!saved || saved.finished) return null;
    return saved;
  } catch {
    return null;
  }
};

/** Write a recovered log to disk under its original run id. */
export const writeRecoveredRunLog = async (saved: RunLogState) => {
  const url = createTextFileUrl(
    formatRunLog({ ...saved, finished: true }),
    "text/plain;charset=utf-8",
  );
  await downloadAndRelease(url, fileNameFor(saved.runId), {
    conflictAction: "overwrite",
  });
};

export const clearRunLog = async () => {
  state = null;
  dirty = false;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  try {
    await runLogState.setValue(null);
  } catch {}
};

export type { RunLogState };
