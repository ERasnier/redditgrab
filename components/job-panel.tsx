import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  clearJob,
  countJob,
  createJob,
  getJobMeta,
  postsWithStatus,
  retryFailed,
  type JobMeta,
  type JobStatus,
} from "@/utils/job-store";
import {
  findLinkColumns,
  isSqliteFile,
  MAX_SQLITE_BYTES,
  readPostIdsFromColumn,
  readPostIdsFromText,
  type LinkColumn,
} from "@/utils/link-import";
import { getHistoryPostIds } from "@/utils/download-history";
import { forceDownloadProcessed, processedPostIds } from "@/utils/storage";
import { createTextFileUrl, downloadAndRelease } from "@/utils/blob-utils";
import { logger } from "@/utils/logger";

type Notice = { kind: "ok" | "warn" | "error"; text: string };
const noticeClass: Record<Notice["kind"], string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-400",
};

/** A chosen file, and for a database, the column the posts are read from. */
type Source = {
  file: File;
  /** Set for a SQLite file: every column that holds posts, best first. */
  columns?: LinkColumn[];
  /** Index into `columns`. */
  column: number;
};

const columnLabel = (c: LinkColumn) =>
  `${c.table}.${c.column} — ${c.rows.toLocaleString()} rows, ${Math.round(
    (c.hits / c.sampled) * 100,
  )}% ${c.kind === "ids" ? "post ids" : "post links"}`;

const tooBig = (file: File) =>
  `${file.name} is ${(file.size / 1024 ** 3).toFixed(1)} GB; the in-browser SQLite reader stops at 1 GB. ` +
  `Export the links column to a text file and import that instead, e.g. ` +
  `sqlite3 "${file.name}" "SELECT permalink FROM posts" > links.txt`;

/** Open a chosen file: a database is checked for columns holding posts. */
const openSource = async (file: File): Promise<Source> => {
  if (!(await isSqliteFile(file))) return { file, column: 0 };
  if (file.size > MAX_SQLITE_BYTES) throw new Error(tooBig(file));
  const columns = await findLinkColumns(new Uint8Array(await file.arrayBuffer()));
  if (columns.length === 0) {
    throw new Error(
      `${file.name} has no column with Reddit post links or ids in it (looked at up to 500 rows of each text column).`,
    );
  }
  return { file, columns, column: 0 };
};

const readSource = async (source: Source) => {
  const chosen = source.columns?.[source.column];
  if (!chosen) return readPostIdsFromText(source.file);
  return readPostIdsFromColumn(new Uint8Array(await source.file.arrayBuffer()), chosen);
};

const describeSource = (source: Source) => {
  const chosen = source.columns?.[source.column];
  return chosen ? `${source.file.name} › ${chosen.table}.${chosen.column}` : source.file.name;
};

const STATUS_LABELS: [JobStatus, string][] = [
  ["done", "downloaded"],
  ["already", "already had"],
  ["excluded", "in skip file"],
  ["no-media", "nothing to download"],
  ["failed", "failed"],
  ["pending", "left"],
];

const SourcePicker = ({
  label,
  source,
  onChange,
  disabled,
  onError,
}: {
  label: string;
  source: Source | null;
  onChange: (source: Source | null) => void;
  disabled: boolean;
  onError: (message: string) => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const [opening, setOpening] = useState(false);
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={disabled || opening}
          onClick={() => input.current?.click()}
        >
          {opening ? "Reading…" : label}
        </Button>
        <span className="min-w-0 truncate text-[11px] text-gray-600 dark:text-gray-300">
          {source ? source.file.name : "none chosen"}
        </span>
        {source && (
          <button
            type="button"
            className="ml-auto text-[11px] text-gray-500 underline"
            disabled={disabled}
            onClick={() => onChange(null)}
          >
            clear
          </button>
        )}
        <input
          ref={input}
          type="file"
          accept=".sqlite,.db,.sqlite3,.txt,.csv,.tsv,.jsonl,.json,.log"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setOpening(true);
            try {
              onChange(await openSource(file));
            } catch (error) {
              onError(error instanceof Error ? error.message : String(error));
            } finally {
              setOpening(false);
            }
          }}
        />
      </div>
      {source?.columns && (
        <select
          className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-1 text-[11px]"
          value={source.column}
          disabled={disabled}
          onChange={(event) => onChange({ ...source, column: Number(event.target.value) })}
        >
          {source.columns.map((column, index) => (
            <option key={`${column.table}.${column.column}`} value={index}>
              {columnLabel(column)}
            </option>
          ))}
        </select>
      )}
      {source?.columns?.[source.column]?.example && (
        <p className="truncate text-[10px] text-gray-500 dark:text-gray-400">
          e.g. {source.columns[source.column].example}
        </p>
      )}
    </div>
  );
};

/**
 * Large jobs: a list of posts imported from a SQLite database or a text file,
 * checked against the download history, then downloaded by looking each post
 * up directly — no page to scroll — and resumable at any point.
 */
export const JobPanel = ({
  running,
  jobRunning,
  onStart,
}: {
  /** Any run is going (the panel's buttons are off). */
  running: boolean;
  /** The run going is this job. */
  jobRunning: boolean;
  onStart: () => void;
}) => {
  const [meta, setMeta] = useState<JobMeta | null>(null);
  const [counts, setCounts] = useState<Record<JobStatus, number> | null>(null);
  const [links, setLinks] = useState<Source | null>(null);
  const [skip, setSkip] = useState<Source | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const current = await getJobMeta();
      setMeta(current);
      setCounts(current ? await countJob() : null);
    } catch (error) {
      logger.warn("Could not read the large job", error);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  // Live counts while the job runs; one last refresh when it stops.
  useEffect(() => {
    if (!jobRunning) {
      void refresh();
      return;
    }
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [jobRunning]);

  const run = async (label: string, task: () => Promise<Notice | null>) => {
    setBusy(label);
    setNotice(null);
    try {
      const result = await task();
      if (result) setNotice(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Large job: ${label} failed:`, error);
      setNotice({ kind: "error", text: message });
    } finally {
      setBusy(null);
      void refresh();
    }
  };

  const create = () =>
    run("creating the job", async () => {
      if (!links) return null;
      const ids = await readSource(links);
      if (ids.length === 0) {
        return { kind: "warn", text: `No Reddit post links or ids found in ${describeSource(links)}.` };
      }
      const skipIds = skip ? new Set(await readSource(skip)) : new Set<string>();
      const force = await forceDownloadProcessed.getValue();
      const history = force ? new Set<string>() : await getHistoryPostIds();
      const processed = force ? new Set<string>() : new Set(await processedPostIds.getValue());

      let excluded = 0;
      let already = 0;
      const entries = ids.map((postId) => {
        let status: JobStatus = "pending";
        if (skipIds.has(postId)) {
          status = "excluded";
          excluded += 1;
        } else if (history.has(postId) || processed.has(postId)) {
          status = "already";
          already += 1;
        }
        return { postId, status };
      });
      await createJob(
        {
          name: links.file.name.replace(/\.[^.]+$/, ""),
          source: describeSource(links) + (skip ? `, skipping ${describeSource(skip)}` : ""),
        },
        entries,
      );
      setLinks(null);
      setSkip(null);
      const pending = entries.length - excluded - already;
      return {
        kind: "ok",
        text:
          `${entries.length.toLocaleString()} unique posts: ${already.toLocaleString()} already downloaded` +
          (force ? ' (not checked: "force download" is on)' : "") +
          (skip ? `, ${excluded.toLocaleString()} in the skip file` : "") +
          `, ${pending.toLocaleString()} to download.`,
      };
    });

  const exportList = (status: JobStatus, suffix: string) =>
    run("exporting", async () => {
      const posts = await postsWithStatus(status);
      if (posts.length === 0) return { kind: "warn", text: "Nothing to export." };
      const text = posts
        .map(
          (post) =>
            `https://www.reddit.com/comments/${post.postId.replace(/^t3_/, "")}/` +
            (post.reason ? `\t${post.reason}` : ""),
        )
        .join("\n");
      const filename = `RedditGrab/redditgrab-job-${suffix}.txt`;
      await downloadAndRelease(createTextFileUrl(text + "\n", "text/plain"), filename, {
        conflictAction: "overwrite",
      });
      return { kind: "ok", text: `Saved ${posts.length.toLocaleString()} links to Downloads/${filename}.` };
    });

  const off = running || busy !== null;
  const finished = counts
    ? (Object.entries(counts) as [JobStatus, number][])
        .filter(([status]) => status !== "pending")
        .reduce((sum, [, n]) => sum + n, 0)
    : 0;
  const total = meta?.total ?? 0;

  return (
    <details className="rounded border border-gray-200 dark:border-gray-700 p-2" open={jobRunning || undefined}>
      <summary className="cursor-pointer select-none text-xs font-medium text-gray-700 dark:text-gray-300">
        Large job
        {meta && counts ? ` · ${counts.pending.toLocaleString()} of ${total.toLocaleString()} left` : ""}
      </summary>
      <div className="mt-2 space-y-2">
        {meta && counts ? (
          <div className="space-y-1.5 rounded bg-gray-50 dark:bg-gray-800/60 p-2">
            <p className="text-[11px] font-medium text-gray-700 dark:text-gray-200">{meta.name}</p>
            <p className="truncate text-[10px] text-gray-500 dark:text-gray-400" title={meta.source}>
              {meta.source} · imported {new Date(meta.createdAt).toLocaleString()}
            </p>
            <div className="h-1.5 w-full overflow-hidden rounded bg-gray-200 dark:bg-gray-700">
              <div
                className="h-full bg-blue-500"
                style={{ width: `${total ? (finished / total) * 100 : 0}%` }}
              />
            </div>
            <ul className="grid grid-cols-2 gap-x-2 text-[11px] text-gray-600 dark:text-gray-300">
              {STATUS_LABELS.map(([status, label]) => (
                <li key={status}>
                  <span className="tabular-nums font-medium">{counts[status].toLocaleString()}</span> {label}
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                className="flex-1"
                disabled={off || counts.pending === 0}
                onClick={onStart}
              >
                {finished > 0 ? "Continue job" : "Start job"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={off || counts.failed === 0}
                onClick={() =>
                  run("retrying", async () => ({
                    kind: "ok",
                    text: `${(await retryFailed()).toLocaleString()} failed posts put back to do.`,
                  }))
                }
              >
                Retry failed
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" variant="outline" className="flex-1" disabled={off || counts.pending === 0} onClick={() => exportList("pending", "remaining")}>
                Export left
              </Button>
              <Button size="sm" variant="outline" className="flex-1" disabled={off || counts.failed === 0} onClick={() => exportList("failed", "failed")}>
                Export failed
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={off}
                onClick={() =>
                  run("discarding", async () => {
                    await clearJob();
                    return { kind: "ok", text: "Job discarded. Downloads and history are untouched." };
                  })
                }
              >
                Discard
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            No job imported.
          </p>
        )}

        <div className="space-y-1.5">
          <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
            Import a list of posts to download: a SQLite database (the column
            with the links is found for you; pick another if needed) or a text
            file of links or t3_ ids. Each post is checked against the download
            history (the Download history panel) and anything already
            downloaded is skipped. A second, optional file of links lists more
            posts to skip — e.g. another tool's database of what it downloaded.
            Posts are looked up 100 at a time, no scrolling; stop at any time
            and Continue picks up where it left off, even after Firefox restarts.
          </p>
          <SourcePicker
            label="Links file…"
            source={links}
            onChange={setLinks}
            disabled={off}
            onError={(text) => setNotice({ kind: "error", text })}
          />
          <SourcePicker
            label="Skip file…"
            source={skip}
            onChange={setSkip}
            disabled={off}
            onError={(text) => setNotice({ kind: "error", text })}
          />
          <Button size="sm" className="w-full" disabled={off || !links} onClick={create}>
            {busy === "creating the job"
              ? "Reading and comparing…"
              : meta
                ? "Replace job with this list"
                : "Create job"}
          </Button>
        </div>

        {notice && (
          <p className={`text-[11px] leading-snug ${noticeClass[notice.kind]}`}>{notice.text}</p>
        )}
      </div>
    </details>
  );
};
