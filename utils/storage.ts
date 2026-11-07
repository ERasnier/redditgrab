import { storage } from "#imports";

export const folderDestination = storage.defineItem("local:folderDestination", {
  fallback: "Reddit Downloads/{subreddit}",
});

export const filenamePattern = storage.defineItem("local:filenamePattern", {
  fallback: "{subreddit}_{timestamp}_{filename}",
});

export const processedPostIds = storage.defineItem("local:processedPostIds", {
  fallback: [] as string[],
});

/**
 * Buffered writes to the processed list.
 *
 * Appending read the whole array, scanned it with `includes`, spread it into a
 * new array and re-serialised — O(n) per download and O(n²) copying over a long
 * run, with the full id list resident several times during each write. Ids are
 * now buffered and flushed in batches, and the in-memory Set makes the
 * duplicate check O(1).
 */
let pendingProcessedIds: string[] = [];
let knownProcessedIds: Set<string> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

// Every flush rewrites the whole list, and storage.onChanged then delivers both
// the old and the new copy to every extension context that listens — the
// background page, the sidebar and each open Reddit tab. With tens of thousands
// of ids that was a few megabytes of copying every three seconds. Batches are
// larger now; the end of each scan batch and the end of a run still flush, so
// a crash loses at most a few seconds of a batch.
const PROCESSED_FLUSH_SIZE = 50;
const PROCESSED_FLUSH_MS = 10_000;

/** Write any buffered ids to storage. Safe to call with nothing pending. */
export const flushProcessedPostIds = async () => {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingProcessedIds.length === 0) return;

  const batch = pendingProcessedIds;
  pendingProcessedIds = [];

  const current = await processedPostIds.getValue();
  const merged = new Set(current);
  for (const id of batch) merged.add(id);
  if (merged.size !== current.length) {
    await processedPostIds.setValue([...merged]);
  }
  knownProcessedIds = merged;
};

/** Queue a post id for the processed list (no-op if already present). */
export const addProcessedPostId = async (id: string) => {
  knownProcessedIds ??= new Set(await processedPostIds.getValue());
  if (knownProcessedIds.has(id)) return;

  knownProcessedIds.add(id);
  pendingProcessedIds.push(id);

  if (pendingProcessedIds.length >= PROCESSED_FLUSH_SIZE) {
    await flushProcessedPostIds();
    return;
  }
  flushTimer ??= setTimeout(() => {
    flushTimer = null;
    void flushProcessedPostIds();
  }, PROCESSED_FLUSH_MS);
};

/** Add several ids at once (posts skipped by the media type filter). */
export const addProcessedPostIds = async (ids: string[]) => {
  for (const id of ids) await addProcessedPostId(id);
  await flushProcessedPostIds();
};

/** Drop the cached view of the processed list, e.g. after clearing history. */
export const resetProcessedPostIdCache = () => {
  pendingProcessedIds = [];
  knownProcessedIds = null;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
};

export const useGalleryFolders = storage.defineItem("local:useGalleryFolders", {
  fallback: false,
});

export const addTitleToImages = storage.defineItem("local:addTitleToImages", {
  fallback: false,
});

export const addTitleToVideos = storage.defineItem("local:addTitleToVideos", {
  fallback: false,
});

export const useDateRange = storage.defineItem("local:useDateRange", {
  fallback: false,
});

export const dateRangeStart = storage.defineItem("local:dateRangeStart", {
  fallback: "",
});

export const dateRangeEnd = storage.defineItem("local:dateRangeEnd", {
  fallback: "",
});

export const darkMode = storage.defineItem("local:darkMode", {
  fallback: false,
});

export const showDownloadedMarkers = storage.defineItem(
  "local:showDownloadedMarkers",
  { fallback: false },
);

export const markDownloadedAsVisited = storage.defineItem(
  "local:markDownloadedAsVisited",
  { fallback: false },
);

// When on, mass download ignores the processed-post history and re-grabs posts
// that were already downloaded. Lets the user redownload a page without clearing
// their entire history.
export const forceDownloadProcessed = storage.defineItem(
  "local:forceDownloadProcessed",
  { fallback: false },
);

// Pause between mass-download requests, in seconds. Reddit stops serving posts
// when requests arrive too quickly, so users who hit that limit can raise it.
export const requestDelaySeconds = storage.defineItem(
  "local:requestDelaySeconds",
  { fallback: 1 },
);

// Also save each downloaded post's text and comments as a standalone HTML page.
export const savePostArchive = storage.defineItem("local:savePostArchive", {
  fallback: false,
});

// Stay on the page after the listing runs out, re-checking for posts that
// appear later, until the run is stopped by hand. This is what makes a single
// page download a long-running watch. It does not apply to a URL queue, which
// has to move on to the next page.
export const keepWatching = storage.defineItem("local:keepWatching", {
  fallback: true,
});

// The mass-download URL queue, stored as the raw textarea text so the user's
// own formatting and comments survive closing the sidebar.
export const urlQueueText = storage.defineItem("local:urlQueueText", {
  fallback: "",
});

// Verbose console logging in production builds. Without this the logger is a
// no-op outside dev builds, so an installed extension can't say why it skipped
// a post.
export const debugLogging = storage.defineItem("local:debugLogging", {
  fallback: false,
});

// Wait for each download to actually finish before counting it a success.
// `downloads.download()` resolves as soon as the download is queued, so without
// this a 403, a disk error or an interrupted transfer is recorded as a success
// and the post is marked processed with nothing on disk.
export const verifyDownloads = storage.defineItem("local:verifyDownloads", {
  fallback: true,
});

// Remove posts from the Reddit page once a mass download has finished with
// them. Reddit's feed never unloads posts, so a long run left thousands of them
// in the tab — each with its video player, images and a mounted download
// button — and the tab grew until Firefox, and then the whole machine, slowed
// down. Posts are only removed once their outcome is settled and they are well
// above the screen.
export const freeMemoryDuringRuns = storage.defineItem(
  "local:freeMemoryDuringRuns",
  { fallback: true },
);

// Take finished downloads off Firefox's download list. The files stay on disk.
// Every saved file is an entry in that list and in history, and a run of
// thousands left Firefox carrying all of them for the rest of the session.
export const clearFinishedDownloads = storage.defineItem(
  "local:clearFinishedDownloads",
  { fallback: true },
);

/**
 * Progress through the page list, saved as the run goes so a run that was
 * stopped — or cut short by Firefox closing — can carry on from where it got
 * to. Pages already finished are skipped on resume; the page that was in
 * progress starts again from the top, and posts already saved from it are
 * skipped by the download history as usual.
 */
export type SavedQueueRun = {
  entries: { url: string; label: string }[];
  statuses: ("pending" | "active" | "done" | "failed")[];
  startedAt: number;
  updatedAt: number;
};

export const savedQueueRun = storage.defineItem<SavedQueueRun | null>(
  "local:savedQueueRun",
  { fallback: null },
);
