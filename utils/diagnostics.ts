/**
 * Structured diagnostics for every post the mass downloader does NOT download.
 *
 * A post could previously vanish from the pipeline in a dozen places with
 * nothing but a dev-only `logger.log` to show for it, so "it skipped some
 * posts" was unfalsifiable. Each drop point now emits one record with a reason
 * code; the content script attaches scan-stage records to its scan response and
 * the sidebar accumulates them alongside its own filter/download-stage records.
 *
 * All three scan paths are covered: the shreddit feed, search results, and
 * old.reddit.
 */

export type DiagnosticStage = "scan" | "filter" | "download";

export type SkipReason =
  // --- scan stage: the post never became a download candidate -------------
  | "no-post-id"
  | "no-media-container"
  | "no-media-urls"
  | "already-processed"
  | "failed-earlier-this-run"
  | "handled-earlier-this-run"
  | "unsupported-cached"
  | "outside-date-range"
  | "extract-threw"
  | "post-json-unavailable"
  | "post-json-no-media"
  | "gallery-no-images"
  | "redgifs-no-id"
  | "promoted-post"
  // --- filter stage: a candidate was dropped by user settings -------------
  | "media-type-filtered"
  // --- download stage: a download was attempted and did not land ----------
  | "download-request-failed"
  | "download-threw"
  | "download-interrupted"
  | "download-timed-out"
  | "download-partial"
  | "archive-unavailable"
  | "unknown-media-type";

export type PostDiagnostic = {
  postId: string;
  stage: DiagnosticStage;
  reason: SkipReason;
  /** Free-text extra context: an error message, a URL, a count. */
  detail?: string;
  title?: string;
  subreddit?: string;
  permalink?: string;
  /** Which page layout the post came from, so blind spots are visible. */
  source?: string;
  at: number;
};

/** Human-readable one-liners, used in the console and the exported report. */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  "no-post-id": "No stable post id could be derived from the DOM",
  "no-media-container":
    "No image, gallery, video or RedGIFs element in the post",
  "no-media-urls": "Media element found but it yielded zero URLs",
  "already-processed": "Already in the processed-posts history",
  "failed-earlier-this-run": "Download failed earlier this run; not retried",
  "handled-earlier-this-run": "Already handled this run",
  "unsupported-cached":
    "Resolved to no downloadable media earlier this session",
  "outside-date-range": "Post date is outside the configured range",
  "extract-threw": "Media extraction threw",
  "post-json-unavailable": "Reddit post JSON could not be fetched",
  "post-json-no-media": "Post JSON contained no downloadable media",
  "gallery-no-images": "Gallery carousel contained no extractable images",
  "redgifs-no-id": "RedGIFs post with no resolvable embed id",
  "promoted-post": "Promoted/sponsored post",
  "media-type-filtered": "Excluded by the media type filter",
  "download-request-failed": "Background script reported the download failed",
  "download-threw": "Download threw an exception",
  "download-interrupted": "Browser reported the download was interrupted",
  "download-timed-out": "Download stalled before finishing",
  "download-partial": "Some files in this post downloaded, others did not",
  "archive-unavailable": "Post thread could not be loaded for archiving",
  "unknown-media-type": "Media type not handled by the downloader",
};

/** Reasons that mean something went wrong, as opposed to a deliberate skip. */
export const FAILURE_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  "no-media-urls",
  "extract-threw",
  "post-json-unavailable",
  "gallery-no-images",
  "redgifs-no-id",
  "download-request-failed",
  "download-threw",
  "download-interrupted",
  "download-timed-out",
  "download-partial",
  "archive-unavailable",
  "unknown-media-type",
]);

export const isFailure = (reason: SkipReason) => FAILURE_REASONS.has(reason);

/**
 * Reasons that are expected and uninteresting. On a feed already downloaded
 * once, nearly every post hits one of these on every scan cycle — storing a
 * full record for each would mean thousands of objects per cycle, serialised
 * across the message boundary every couple of seconds, and a report whose
 * signal is buried. These are counted but not individually recorded unless
 * debug logging is on.
 */
export const ROUTINE_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  "already-processed",
  "handled-earlier-this-run",
  "failed-earlier-this-run",
  "unsupported-cached",
  "outside-date-range",
  "promoted-post",
]);

export const isRoutine = (reason: SkipReason) => ROUTINE_REASONS.has(reason);

/**
 * Collector used inside a single scan pass. Kept small and discarded with the
 * scan so it can never become another thing that grows forever in memory.
 */
export class DiagnosticsCollector {
  private readonly records: PostDiagnostic[] = [];
  private readonly counts: Record<string, number> = {};
  private total = 0;
  private routineStored = 0;
  private problemStored = 0;

  /**
   * Routine skips and real problems get separate budgets.
   *
   * A single shared cap looked fine until a real run came back: re-scanning an
   * already-downloaded feed produced 498 "already-processed" records and filled
   * the cap, so the two records that actually mattered nearly didn't make it,
   * and on a bigger feed they would have been dropped entirely. The report
   * exists to not lose that information, so the two kinds can no longer compete
   * for the same space. Routine skips keep a small sample for context; their
   * full counts always survive in the summary regardless.
   *
   * @param storeRoutine keep a sample of routine skips as well
   * @param problemLimit cap on failure/non-routine records
   * @param routineLimit cap on the routine sample
   */
  constructor(
    private readonly storeRoutine = false,
    private readonly problemLimit = 500,
    private readonly routineLimit = 25,
  ) {}

  /** True when a full record would be stored, so callers can skip DOM work. */
  willStore(reason: SkipReason) {
    if (isRoutine(reason)) {
      return this.storeRoutine && this.routineStored < this.routineLimit;
    }
    return this.problemStored < this.problemLimit;
  }

  add(
    entry: Omit<PostDiagnostic, "at" | "stage"> & { stage?: DiagnosticStage },
  ) {
    this.total += 1;
    this.counts[entry.reason] = (this.counts[entry.reason] ?? 0) + 1;
    if (!this.willStore(entry.reason)) return;
    if (isRoutine(entry.reason)) this.routineStored += 1;
    else this.problemStored += 1;
    this.records.push({
      stage: "scan",
      at: Date.now(),
      ...entry,
    });
  }

  get all(): PostDiagnostic[] {
    return this.records;
  }

  /** Number of stored records (may be fewer than `totalSkipped`). */
  get length() {
    return this.records.length;
  }

  /** Every skip, routine ones included. */
  get totalSkipped() {
    return this.total;
  }

  /** Counts per reason across every skip, for a compact console summary. */
  tally(): Record<string, number> {
    return { ...this.counts };
  }
}

/**
 * Render a set of records as a plain-text report.
 *
 * Ordered by what the reader has to act on, not by what happened most. A real
 * run came back with 498 "already-processed" records around the single download
 * failure that mattered, so the failures and their permalinks lead, followed by
 * a bare URL list that pastes straight into "Pages to download" (or any
 * download manager) to retry them. The routine skips are a sample at the end,
 * for context only — their true counts are in the summary either way.
 */
export const formatDiagnosticsReport = (
  records: PostDiagnostic[],
  meta: {
    url?: string;
    startedAt?: number;
    finishedAt?: number;
    /** Full counts per reason, including records that were not stored. */
    counts?: Record<string, number>;
    downloaded?: number;
  } = {},
): string => {
  const lines: string[] = [];
  const failures = records.filter((record) => isFailure(record.reason));
  const skips = records.filter((record) => !isFailure(record.reason));

  // Prefer the caller's full tally; fall back to counting what we kept.
  const counts = meta.counts ?? {};
  if (Object.keys(counts).length === 0) {
    for (const record of records) {
      counts[record.reason] = (counts[record.reason] ?? 0) + 1;
    }
  }
  const totalSkipped = Object.values(counts).reduce((sum, n) => sum + n, 0);

  lines.push("RedditGrab diagnostics report");
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (meta.url) lines.push(`Page: ${meta.url}`);
  if (meta.startedAt) {
    lines.push(`Run started: ${new Date(meta.startedAt).toISOString()}`);
  }
  if (meta.finishedAt) {
    lines.push(`Run ended: ${new Date(meta.finishedAt).toISOString()}`);
  }
  if (meta.downloaded !== undefined) {
    lines.push(`Downloaded: ${meta.downloaded}`);
  }
  lines.push(`Failed: ${failures.length}`);
  lines.push(`Skipped: ${totalSkipped - failures.length}`);
  lines.push("");

  // --- 1. What needs doing something about. -------------------------------
  lines.push("NEEDS ATTENTION");
  lines.push("===============");
  if (failures.length === 0) {
    lines.push("Nothing failed. Everything below was skipped deliberately.");
  } else {
    lines.push(
      `${failures.length} post(s) were meant to download and did not:`,
    );
    lines.push("");
    for (const record of failures) {
      const where = [
        record.subreddit ? `r/${record.subreddit}` : null,
        // Which page layout it came from: needed to tell whether one layout
        // (old.reddit, search) fails differently from the others.
        record.source ? `via ${record.source}` : null,
        record.stage !== "scan" ? `at ${record.stage}` : null,
      ]
        .filter(Boolean)
        .join("  ");
      lines.push(
        `${record.permalink ?? record.postId}${where ? `   ${where}` : ""}`,
      );
      if (record.title) lines.push(`    ${record.title}`);
      lines.push(
        `    why: ${record.reason} — ${SKIP_REASON_TEXT[record.reason] ?? ""}`,
      );
      if (record.detail) lines.push(`    detail: ${record.detail}`);
      lines.push("");
    }

    // --- 2. The same posts as a bare list, ready to paste. ---------------
    const retryable = failures
      .map((record) => record.permalink)
      .filter((link): link is string => Boolean(link));
    if (retryable.length > 0) {
      lines.push("RETRY LIST");
      lines.push("==========");
      lines.push(
        'Paste into "Pages to download" in the sidebar, or into any download',
      );
      lines.push("manager. One post per line, nothing else on these lines:");
      lines.push("");
      lines.push(...retryable);
      lines.push("");
    }
  }

  // --- 3. Totals, including anything not individually recorded. ----------
  lines.push("SUMMARY BY REASON");
  lines.push("=================");
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    lines.push("(nothing was skipped)");
  }
  for (const [reason, count] of sorted) {
    const text = SKIP_REASON_TEXT[reason as SkipReason] ?? reason;
    const marker = isFailure(reason as SkipReason) ? "FAIL" : "skip";
    lines.push(`${String(count).padStart(6)}  [${marker}] ${reason} — ${text}`);
  }
  lines.push("");

  // --- 4. Skipped posts, as a sample. ------------------------------------
  const skipCount = totalSkipped - failures.length;
  lines.push("SKIPPED POSTS");
  lines.push("=============");
  if (skips.length === 0) {
    lines.push("(none recorded individually)");
  } else {
    if (skipCount > skips.length) {
      lines.push(
        `Showing ${skips.length} of ${skipCount}. The rest were routine skips,`,
      );
      lines.push("counted above but not listed one by one.");
    }
    lines.push("");
    for (const record of skips) {
      const parts = [
        new Date(record.at).toISOString(),
        record.stage,
        record.reason,
        record.postId,
      ];
      if (record.source) parts.push(`(${record.source})`);
      if (record.subreddit) parts.push(`r/${record.subreddit}`);
      lines.push(parts.join("  "));
      if (record.title) lines.push(`        title: ${record.title}`);
      if (record.permalink) lines.push(`        link:  ${record.permalink}`);
      if (record.detail) lines.push(`        detail: ${record.detail}`);
    }
  }

  return lines.join("\n");
};

/** Reddit permalink for a thing id, for pasting straight into a browser. */
export const permalinkForPostId = (postId: string): string | undefined => {
  const match = postId.match(/^t3_([a-z0-9]+)$/i);
  return match ? `https://www.reddit.com/comments/${match[1]}/` : undefined;
};
