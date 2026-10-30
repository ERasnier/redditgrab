import { logger } from "./logger";
import { verifyDownloads } from "./storage";

/**
 * Object URL for a blob. Firefox's background page has URL.createObjectURL, so
 * the base64 data-URL fallback the Chrome MV3 service worker needed is gone.
 *
 * Every URL handed out here pins its blob in memory until revoked, so callers
 * must pass it to `downloadAndRelease` (or revoke it themselves).
 */
export async function createBlobUrl(blob: Blob): Promise<string> {
  return URL.createObjectURL(blob);
}

/** Give up after this long with no new bytes. Progress resets the clock. */
const DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1000;
/** Absolute ceiling, so nothing waits forever. */
const DOWNLOAD_MAX_WAIT_MS = 30 * 60 * 1000;
/** How often to ask the downloads API for progress. */
const DOWNLOAD_POLL_INTERVAL_MS = 2000;

type TerminalState =
  | { state: "complete"; filename?: string; bytes?: number }
  | { state: "interrupted"; error: string }
  | { state: "stalled"; bytes: number };

/**
 * Wait for the browser's own terminal state for a download.
 *
 * `downloads.onChanged` does NOT fire for byte progress — only for state,
 * filename, danger, pause and error changes. A large video can therefore
 * produce no events for minutes and then complete, so a flat timeout can't tell
 * "slow" from "stalled". Polling `bytesReceived` can.
 */
function waitForDownloadToSettle(downloadId: number): Promise<TerminalState> {
  return new Promise((resolve) => {
    let settled = false;
    let lastBytes = -1;
    let lastProgressAt = Date.now();
    const startedAt = Date.now();

    const finish = (result: TerminalState) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      browser.downloads.onChanged.removeListener(listener);
      resolve(result);
    };

    // Fast path: settle the moment the browser announces a terminal state.
    const listener = (delta: Browser.downloads.DownloadDelta) => {
      if (delta.id !== downloadId) return;
      const state = delta.state?.current;
      if (state === "complete") {
        finish({ state: "complete", filename: delta.filename?.current });
      } else if (state === "interrupted") {
        finish({
          state: "interrupted",
          error: delta.error?.current ?? "interrupted",
        });
      }
    };
    browser.downloads.onChanged.addListener(listener);

    const poll = setInterval(async () => {
      if (settled) return;
      let item: Browser.downloads.DownloadItem | undefined;
      try {
        [item] = await browser.downloads.search({ id: downloadId });
      } catch {
        // An API hiccup is "no news", not a failure.
        return;
      }
      if (settled) return;

      if (!item) {
        // Gone from the download list entirely (cleared, or never started).
        finish({ state: "stalled", bytes: Math.max(lastBytes, 0) });
        return;
      }
      if (item.state === "complete") {
        finish({
          state: "complete",
          filename: item.filename,
          bytes: item.fileSize > 0 ? item.fileSize : item.bytesReceived,
        });
        return;
      }
      if (item.state === "interrupted") {
        finish({ state: "interrupted", error: item.error ?? "interrupted" });
        return;
      }

      const received = item.bytesReceived ?? 0;
      if (received > lastBytes) {
        lastBytes = received;
        lastProgressAt = Date.now();
        return;
      }
      if (
        Date.now() - lastProgressAt >= DOWNLOAD_STALL_TIMEOUT_MS ||
        Date.now() - startedAt >= DOWNLOAD_MAX_WAIT_MS
      ) {
        finish({ state: "stalled", bytes: Math.max(lastBytes, 0) });
      }
    }, DOWNLOAD_POLL_INTERVAL_MS);
  });
}

/**
 * Start a download and wait until the browser has actually written the file.
 *
 * This used to wait only for `blob:` URLs, because the point was keeping the
 * blob alive long enough to be read. But `downloads.download()` resolves as
 * soon as the download is *queued*, so for a direct URL a 403 from the CDN, a
 * full disk or a dropped connection all looked like success — the post was
 * marked processed with nothing on disk. Every download is now waited on, and a
 * failure throws.
 */
export async function downloadAndWait(url: string, filename?: string) {
  const downloadId = await browser.downloads.download({
    url,
    filename,
    saveAs: false,
  });

  if (downloadId === undefined) {
    throw new Error("browser did not return a download id");
  }
  if (!(await verifyDownloads.getValue())) {
    return;
  }

  const result = await waitForDownloadToSettle(downloadId);
  if (result.state === "interrupted") {
    throw new Error(`download interrupted: ${result.error}`);
  }
  if (result.state === "stalled") {
    throw new Error(
      `download stalled after ${result.bytes} bytes with no progress for ${DOWNLOAD_STALL_TIMEOUT_MS / 1000}s`,
    );
  }
  logger.log(`Download ${downloadId} complete: ${result.filename ?? filename}`);
}

/** Free an object URL's blob. No-op for regular and data URLs. */
export function revokeIfObjectUrl(url: string) {
  if (url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Revoking after teardown, or from the wrong context, is harmless.
    }
  }
}

/**
 * Download a file and release its object URL afterwards. Object URLs keep
 * their blob in memory until revoked, so without this every downloaded image
 * and video stayed resident until the extension was reloaded.
 */
export async function downloadAndRelease(url: string, filename: string) {
  try {
    await downloadAndWait(url, filename);
  } finally {
    revokeIfObjectUrl(url);
  }
}

/** Object URL for a generated text file, such as a post archive. */
export function createTextFileUrl(text: string, mimeType: string): string {
  return URL.createObjectURL(new Blob([text], { type: mimeType }));
}
