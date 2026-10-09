import { onMessage } from "webext-bridge/background";
import { DownloadRequestMessage } from "@/types/shim";

export default defineBackground(() => {
  browser.runtime.onMessage.addListener(handleOffscreenMessages);

  onMessage("DOWNLOAD_REQUEST", async ({ data }) => {
    try {
      await handleDownloadRequest(data);
      return { success: true };
    } catch (error) {
      console.error("Download request failed:", error);
      return { success: false, message: (error as Error).message };
    }
  });

  const handleIconClick = async (tab: Browser.tabs.Tab) => {
    try {
      logger.log(
        "Extension icon clicked, browser.sidePanel:",
        browser.sidePanel
      );
      if (browser.sidePanel && browser.sidePanel.open) {
        await browser.sidePanel.open({
          tabId: tab.id,
          windowId: tab.windowId,
        });
        logger.log("Opened Chrome side panel");
      } else if (
        (browser as any).sidebarAction &&
        (browser as any).sidebarAction.toggle
      ) {
        await (browser as any).sidebarAction.toggle();
        logger.log("Toggled Firefox sidebar");
      } else {
        logger.log("Sidebar API not available");
      }
    } catch (error) {
      console.error("Failed to open/toggle sidebar:", error);
    }
  };

  if (import.meta.env.MANIFEST_VERSION === 2) {
    (browser as any).browserAction.onClicked.addListener(handleIconClick);
    logger.log("Registered MV2 browserAction.onClicked listener");
  } else {
    browser.action.onClicked.addListener(handleIconClick);
    logger.log("Registered MV3 action.onClicked listener");
  }
});

async function handleDownloadRequest(data: DownloadRequestMessage) {
  logger.log("Processing download request22:", data);

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });

  if (!tab?.id) {
    throw new Error("No active tab found");
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

    if (browser.offscreen) {
      await offscreenDownloadGalleryImages(downloadGalleryImagesOptions);
    } else {
      await downloadGalleryImages(downloadGalleryImagesOptions);
    }
    await archiveAlongsideMedia();
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

    if (browser.offscreen) {
      await offscreenDownloadVideo(downloadVideoOptions);
    } else {
      await downloadVideo(downloadVideoOptions);
    }
    await archiveAlongsideMedia();
  }
}
