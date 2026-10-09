/**
 * Create a blob URL that works in both Chrome Manifest V3 and Firefox
 * Falls back to data URL if URL.createObjectURL is not available
 */
export async function createBlobUrl(blob: Blob): Promise<string> {
  if (typeof URL !== "undefined" && URL.createObjectURL) {
    return URL.createObjectURL(blob);
  }

  return await convertBlobToDataUrl(blob);
}

/**
 * Convert blob to data URL for Chrome Manifest V3 compatibility
 */
function convertBlobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(reader.result as string);
    };
    reader.onerror = () => {
      reject(new Error("Failed to convert blob to data URL"));
    };
    reader.readAsDataURL(blob);
  });
}

// Upper bound on how long we hold a file's memory waiting for the browser to
// finish writing it, so a stuck download can't pin it forever.
const DOWNLOAD_SETTLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Resolve once a download completes, is interrupted, or the timeout passes. */
function waitForDownloadToSettle(downloadId: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      browser.downloads.onChanged.removeListener(listener);
      resolve();
    };
    const listener = (delta: Browser.downloads.DownloadDelta) => {
      const state = delta.state?.current;
      if (delta.id === downloadId && state && state !== "in_progress") {
        finish();
      }
    };
    const timer = setTimeout(finish, DOWNLOAD_SETTLE_TIMEOUT_MS);
    browser.downloads.onChanged.addListener(listener);

    // The download may have finished before the listener was attached.
    browser.downloads
      .search({ id: downloadId })
      .then(([item]) => {
        if (!item || item.state !== "in_progress") finish();
      })
      .catch(() => {});
  });
}

/**
 * Start a download. For object URLs, also wait until the browser has written
 * the file, since the URL (and the blob behind it) must stay alive until then.
 */
export async function downloadAndWait(url: string, filename?: string) {
  const downloadId = await browser.downloads.download({
    url,
    filename,
    saveAs: false,
  });
  if (url.startsWith("blob:") && downloadId !== undefined) {
    await waitForDownloadToSettle(downloadId);
  }
}

/** Free an object URL's blob. No-op for regular and data URLs. */
export function revokeIfObjectUrl(url: string) {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
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

/**
 * URL for a generated text file. Uses an object URL where available; Chrome's
 * background service worker has neither URL.createObjectURL nor FileReader, so
 * it gets a base64 data URL instead.
 */
export function createTextFileUrl(text: string, mimeType: string): string {
  if (typeof URL !== "undefined" && URL.createObjectURL) {
    return URL.createObjectURL(new Blob([text], { type: mimeType }));
  }

  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
