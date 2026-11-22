import { createBlobUrl, revokeIfObjectUrl } from "./blob-utils";
import { presetFolder } from "./storage";

/**
 * Files the extension keeps in its own folder on disk.
 *
 * A temporarily loaded add-on loses all of its storage when Firefox closes.
 * It can't read arbitrary files either — but it can read its own folder, and
 * the folder sits inside the Downloads folder, where the downloads API can
 * write. So a file written there is one the extension can find again by
 * itself on the next start.
 */

/** Not build outputs, so WXT's typed public paths don't know them. */
const getURL = browser.runtime.getURL as (path: string) => string;

/** Read a file from the extension's folder, or null if there isn't one. */
export const readExtensionFolderFile = async (
  name: string,
): Promise<Response | null> => {
  try {
    const response = await fetch(getURL(`/${name}`), { cache: "no-store" });
    return response.ok ? response : null;
  } catch {
    // Firefox answers a missing extension file with a network error.
    return null;
  }
};

/**
 * Write a file into the extension's folder, replacing any earlier copy.
 * Returns the full path Firefox saved it to.
 */
export const writeExtensionFolderFile = async (
  name: string,
  blob: Blob,
): Promise<string> => {
  const folder = (await presetFolder.getValue()).replace(/^[\\/]+|[\\/]+$/g, "");
  const relativePath = folder ? `${folder}/${name}` : name;
  const url = await createBlobUrl(blob);
  try {
    const downloadId = await browser.downloads.download({
      url,
      filename: relativePath,
      saveAs: false,
      conflictAction: "overwrite",
    });
    return await waitForPath(downloadId, relativePath);
  } finally {
    revokeIfObjectUrl(url);
  }
};

/** Wait for a download to finish and return the full path it was saved to. */
const waitForPath = async (downloadId: number, fallback: string) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const [item] = await browser.downloads.search({ id: downloadId });
    if (item?.state === "complete") {
      // Housekeeping files; keep them off the download list.
      void browser.downloads.erase({ id: downloadId }).catch(() => {});
      return item.filename || fallback;
    }
    if (item?.state === "interrupted") {
      throw new Error(`Firefox couldn't save ${fallback}: ${item.error ?? "interrupted"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return fallback;
};
