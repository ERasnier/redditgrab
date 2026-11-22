import { onMessage } from "webext-bridge/background";
import { DownloadRequestMessage } from "@/types/shim";
import type { SkipReason } from "@/utils/diagnostics";
import { getExtensionMemoryStats } from "@/utils/memory-stats";
import { autoImportPresets } from "@/utils/presets";
import {
  autoImportHistory,
  backfillFromProcessedList,
  clearHistoryEverywhere,
  countRecords,
  recordDownload,
  writeHistoryFile,
  type HistoryAutoImport,
} from "@/utils/download-history";
import { listenForSavedFiles } from "@/utils/blob-utils";

/** Download requests in progress, for telling whose files are whose. */
let activeRequests = 0;
/** Set when requests overlapped; cleared once none are running. */
let overlapped = false;

export default defineBackground(() => {
  // A temporarily loaded add-on starts every Firefox session with empty
  // storage. If presets were exported into the extension's folder, put them
  // back before anything reads the settings.
  // Presets first: they carry the folder setting the history file is written
  // to. Then the download history, which puts the processed-posts list back
  // so nothing already saved is downloaded again.
  let historyStartup: HistoryAutoImport | { status: "failed"; error: string } = {
    status: "none",
  };
  void autoImportPresets()
    .then((result) => {
      if (result.status === "imported") {
        logger.always(
          `Presets restored from the extension folder (exported ${new Date(result.exportedAt).toLocaleString()}).`,
        );
      }
    })
    .catch((error) => logger.error("Automatic preset import failed:", error))
    .then(() => autoImportHistory())
    .then(async (result) => {
      historyStartup = result;
      // Give every id from before this feature a record, so the first file
      // written holds the whole history.
      await backfillFromProcessedList();
    })
    .catch((error) => {
      historyStartup = { status: "failed", error: String(error) };
      logger.error("Automatic history import failed:", error);
    });

  onMessage("HISTORY_STATUS", async () => ({
    records: await countRecords(),
    startup: historyStartup,
  }));
  onMessage("HISTORY_WRITE", () => writeHistoryFile());
  onMessage("HISTORY_CLEAR", () => clearHistoryEverywhere());

  // For the sidebar's memory panel: what the download side is holding now.
  onMessage("GET_MEMORY_STATS", () => getExtensionMemoryStats());

  onMessage("DOWNLOAD_REQUEST", async ({ data }) => {
    // Collect where this post's files are saved, for the history record. If
    // two requests overlap, a file can't be told apart, so neither records
    // paths it may not own.
    activeRequests += 1;
    if (activeRequests > 1) overlapped = true;
    const files: string[] = [];
    const stopListening = listenForSavedFiles((path) => files.push(path));
    try {
      await handleDownloadRequest(data);
      if (data.postId) {
        void recordDownload({
          postId: data.postId,
          permalink: data.postId.startsWith("t3_")
            ? `https://www.reddit.com/comments/${data.postId.slice(3)}/`
            : undefined,
          subreddit: data.subredditName || undefined,
          title: data.postTitle,
          author: data.postAuthor,
          mediaType: data.mediaContentType,
          urls: data.urls,
          files: activeRequests > 1 || overlapped ? [] : files,
          folder: data.folderDestination,
          downloadedAt: Date.now(),
        });
      }
      return { success: true };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown");
      // Always logged, debug mode or not. A download that fails silently is
      // indistinguishable from one that never ran.
      logger.error(
        `Download failed for ${data.mediaContentType} post "${data.postTitle ?? "(untitled)"}" in r/${data.subredditName}: ${message}`,
        { postId: data.postId, urls: data.urls },
      );
      return { success: false, message, reason: classifyFailure(message) };
    } finally {
      stopListening();
      activeRequests -= 1;
      if (activeRequests === 0) overlapped = false;
    }
  });

  const handleIconClick = async () => {
    try {
      const sidebarAction = (browser as any).sidebarAction;
      if (sidebarAction?.toggle) {
        await sidebarAction.toggle();
      } else {
        logger.error("sidebarAction is unavailable; cannot open the sidebar");
      }
    } catch (error) {
      logger.error("Failed to toggle sidebar:", error);
    }
  };

  (browser as any).browserAction.onClicked.addListener(handleIconClick);
});

/** Map a thrown message onto one of the diagnostic reason codes. */
function classifyFailure(message: string): SkipReason {
  const lower = message.toLowerCase();
  if (
    lower.includes("no media urls") ||
    lower.includes("called with no url") ||
    lower.includes("no images to download")
  ) {
    return "no-media-urls";
  }
  if (lower.includes("for archiving")) return "archive-unavailable";
  // Anything from the ffmpeg wrapper, which names the step that failed.
  if (lower.startsWith("ffmpeg ") || lower.includes("errnoerror")) {
    return "video-processing-failed";
  }
  if (lower.includes("no video data")) return "video-processing-failed";
  if (lower.includes("interrupted")) return "download-interrupted";
  if (lower.includes("stalled")) return "download-timed-out";
  if (lower.includes("images failed")) return "download-partial";
  if (lower.includes("not handled")) return "unknown-media-type";
  return "download-threw";
}

async function handleDownloadRequest(data: DownloadRequestMessage) {
  logger.log("Processing download request:", data);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab found");
  }

  // A media post that resolved to zero URLs used to fall through every branch
  // below and come back as `{ success: true }`, so it was marked processed and
  // never retried despite nothing being saved. Text posts legitimately have no
  // URLs — their archive is the payload.
  if (data.mediaContentType !== "text" && data.urls.length === 0) {
    throw new Error("no media URLs resolved for this post");
  }

  const folderDestination = data.folderDestination || "Reddit Downloads";
  const subredditName = data.subredditName || "unknown";
  const pattern = await filenamePattern.getValue();

  const archive = async () => {
    if (!data.savePostArchive || !data.postId?.startsWith("t3_")) return;
    await downloadPostArchive({
      postId: data.postId,
      folderDestination,
      subredditName,
      filenamePattern: pattern,
      postTitle: data.postTitle,
      postAuthor: data.postAuthor,
    });
  };

  // Text posts have nothing else to save, so an archive failure is the
  // request's failure. For media posts the media is what matters; a missing
  // archive is only logged.
  if (data.mediaContentType === "text") {
    await archive();
    return;
  }
  const archiveAlongsideMedia = () =>
    archive().catch((error) => {
      logger.error("Failed to save post archive:", error);
    });

  if (
    data.mediaContentType === "multiple-images" ||
    data.mediaContentType === "single-image"
  ) {
    const downloadGalleryImagesOptions = {
      urls: data.urls,
      folderDestination,
      subredditName,
      useGalleryFolders: data.useGalleryFolders,
      addTitleToImages: data.addTitleToImages,
      postTitle: data.postTitle,
      postAuthor: data.postAuthor,
      filenamePattern: pattern,
    } as const satisfies Parameters<typeof downloadGalleryImages>[0];

    const result = await downloadGalleryImages(downloadGalleryImagesOptions);
    await archiveAlongsideMedia();
    // Some images landed and some didn't. Without this the post counts as a
    // clean success and is never looked at again, so a 20-image gallery saved
    // as 19 goes unnoticed — the exact silent loss these checks are for.
    if (result && "partialFailures" in result) {
      throw new Error(
        `${result.failedCount} of ${result.total} images failed: ${result.partialFailures[0]}`,
      );
    }
    return;
  }

  if (data.mediaContentType === "video") {
    const downloadVideoOptions = {
      url: data.urls[0],
      folderDestination,
      subredditName,
      addTitleToVideo: data.addTitleToVideos,
      postTitle: data.postTitle || "",
      postAuthor: data.postAuthor,
      filenamePattern: pattern,
    } as const satisfies Parameters<typeof downloadVideo>[0];

    await downloadVideo(downloadVideoOptions);
    await archiveAlongsideMedia();
    return;
  }

  // Reached only when mediaContentType is something no branch handles.
  // Previously this returned success with nothing downloaded.
  throw new Error(
    `media type "${data.mediaContentType}" is not handled by the downloader`,
  );
}
