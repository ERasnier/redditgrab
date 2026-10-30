import { onMessage } from "webext-bridge/background";
import { DownloadRequestMessage } from "@/types/shim";
import type { SkipReason } from "@/utils/diagnostics";

export default defineBackground(() => {
  onMessage("DOWNLOAD_REQUEST", async ({ data }) => {
    try {
      await handleDownloadRequest(data);
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

    await downloadGalleryImages(downloadGalleryImagesOptions);
    await archiveAlongsideMedia();
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
