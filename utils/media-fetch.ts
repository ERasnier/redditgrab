import { logger } from "./logger";

/**
 * Fetching media bytes from Reddit.
 *
 * The post-JSON path (reddit-post-api) already sent credentials, honoured
 * Retry-After and retried once on 429. The media path — the fetches that
 * actually produce the files — did none of that: one plain request, and any
 * non-200 permanently failed the post for the rest of the run. A single rate
 * limit mid-run therefore lost a post silently, which on long bulk runs is
 * exactly the failure mode that is hardest to notice.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Worth trying again: rate limits, timeouts and transient server faults. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1000;
/** However long Reddit asks us to wait, don't stall a run past this. */
const MAX_RETRY_AFTER_MS = 30_000;

/** Carries the HTTP status so callers can group failures meaningfully. */
export class MediaFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    /** HTTP status, or 0 for a network-level failure. */
    readonly status: number,
  ) {
    super(message);
    this.name = "MediaFetchError";
  }
}

const parseRetryAfter = (header: string | null): number | null => {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS);
  }
  return null;
};

/** Exponential backoff with jitter, so parallel images don't retry in step. */
const backoffFor = (attempt: number) =>
  BASE_BACKOFF_MS * 2 ** (attempt - 1) + Math.random() * 250;

export type FetchedMedia = {
  blob: Blob;
  contentType: string | null;
};

/**
 * Fetch one media file, retrying transient failures.
 *
 * `credentials: "include"` matches what the post-JSON requests already do:
 * some preview URLs are only served to a signed-in session, and without the
 * cookies they come back 404 rather than 403, which makes the failure look
 * like a missing file.
 *
 * The previous `mode: "no-cors"` was counterproductive. The extension holds
 * host permissions for the Reddit domains, so those requests are not subject
 * to CORS anyway; for any other host it would force an opaque response whose
 * body reads as zero bytes, turning a clear CORS failure into a misleading
 * "empty response".
 */
export const fetchMediaBlob = async (url: string): Promise<FetchedMedia> => {
  let lastError: MediaFetchError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { credentials: "include" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastError = new MediaFetchError(
        `Network error fetching ${url}: ${message}`,
        url,
        0,
      );
      if (attempt < MAX_ATTEMPTS) {
        await sleep(backoffFor(attempt));
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      const blob = await response.blob();
      if (blob.size === 0) {
        // A 200 with no body is not worth retrying; the source is broken.
        throw new MediaFetchError(`Empty response for ${url}`, url, 200);
      }
      return { blob, contentType: response.headers.get("content-type") };
    }

    lastError = new MediaFetchError(
      `Failed to fetch ${url}: ${response.status}`,
      url,
      response.status,
    );

    if (!RETRYABLE_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      throw lastError;
    }

    const wait = parseRetryAfter(response.headers.get("retry-after"));
    const delay = wait ?? backoffFor(attempt);
    logger.warn(
      `${response.status} fetching media, retrying in ${Math.round(delay)}ms (attempt ${attempt}/${MAX_ATTEMPTS})`,
    );
    await sleep(delay);
  }

  throw lastError ?? new MediaFetchError(`Failed to fetch ${url}`, url, 0);
};

/**
 * Summarise a batch of failures by HTTP status.
 *
 * "all 15 image(s) failed: …404" told us one image's story and left the shape
 * of the problem to guesswork. Whether fifteen images all 404 or split between
 * 404 and 429 points at completely different causes, so the counts go in the
 * message.
 */
export const summariseFetchFailures = (errors: unknown[]): string => {
  const byStatus = new Map<string, number>();
  let example = "";

  for (const error of errors) {
    const key =
      error instanceof MediaFetchError
        ? error.status === 0
          ? "network error"
          : `HTTP ${error.status}`
        : "error";
    byStatus.set(key, (byStatus.get(key) ?? 0) + 1);
    if (!example) {
      example = error instanceof Error ? error.message : String(error);
    }
  }

  const breakdown = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => `${count}×${status}`)
    .join(", ");

  return example ? `${breakdown} — ${example}` : breakdown;
};
