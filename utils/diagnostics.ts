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

  /**
   * @param storeRoutine keep per-post records for routine reasons too
   * @param limit hard cap on stored records, so one pathological page can't
   *   become the kind of unbounded growth this pass exists to remove
   */
  constructor(
    private readonly storeRoutine = false,
    private readonly limit = 500,
  ) {}

  /** True when a full record would be stored, so callers can skip DOM work. */
  willStore(reason: SkipReason) {
    if (this.records.length >= this.limit) return false;
    return this.storeRoutine || !isRoutine(reason);
  }

  add(
    entry: Omit<PostDiagnostic, "at" | "stage"> & { stage?: DiagnosticStage },
  ) {
    this.total += 1;
    this.counts[entry.reason] = (this.counts[entry.reason] ?? 0) + 1;
    if (!this.willStore(entry.reason)) return;
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

/** Render a set of records as a plain-text report the user can read or file. */
export const formatDiagnosticsReport = (
  records: PostDiagnostic[],
  meta: { url?: string; startedAt?: number; finishedAt?: number } = {},
): string => {
  const lines: string[] = [];
  lines.push("RedditGrab diagnostics report");
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (meta.url) lines.push(`Page: ${meta.url}`);
  if (meta.startedAt) {
    lines.push(`Run started: ${new Date(meta.startedAt).toISOString()}`);
  }
  if (meta.finishedAt) {
    lines.push(`Run ended: ${new Date(meta.finishedAt).toISOString()}`);
  }
  lines.push("");

  const counts: Record<string, number> = {};
  for (const record of records) {
    counts[record.reason] = (counts[record.reason] ?? 0) + 1;
  }

  lines.push(`Posts not downloaded: ${records.length}`);
  lines.push("");
  lines.push("Summary by reason");
  lines.push("-----------------");
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    lines.push("(nothing was skipped)");
  }
  for (const [reason, count] of sorted) {
    const text = SKIP_REASON_TEXT[reason as SkipReason] ?? reason;
    const marker = isFailure(reason as SkipReason) ? "FAIL" : "skip";
    lines.push(`${String(count).padStart(5)}  [${marker}] ${reason} — ${text}`);
  }

  lines.push("");
  lines.push("Detail");
  lines.push("------");
  for (const record of records) {
    const parts = [
      new Date(record.at).toISOString(),
      isFailure(record.reason) ? "FAIL" : "skip",
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

  return lines.join("\n");
};

/** Reddit permalink for a thing id, for pasting straight into a browser. */
export const permalinkForPostId = (postId: string): string | undefined => {
  const match = postId.match(/^t3_([a-z0-9]+)$/i);
  return match ? `https://www.reddit.com/comments/${match[1]}/` : undefined;
};
