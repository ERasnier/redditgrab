import {
  DownloadImageOptions,
  DownloadVideoOptions,
  isBackgroundMessage,
} from "@/types";
import { OFFSCREEN_DOCUMENT_PATH } from "@/utils/constants";
import { downloadAndWait } from "@/utils/blob-utils";

declare const self: ServiceWorkerGlobalScope;

const pendingDownloads = new Map<
  string,
  { resolve: () => void; reject: (err: any) => void }
>();

async function hasOffscreenDocument() {
  const contexts = await browser.runtime?.getContexts({
    contextTypes: [browser.runtime.ContextType.OFFSCREEN_DOCUMENT],
    documentUrls: [browser.runtime.getURL(OFFSCREEN_DOCUMENT_PATH)],
  });

  if (contexts != null) {
    return contexts.length > 0;
  } else {
    const matchedClients = await self.clients.matchAll();
    return matchedClients.some((client) =>
      client.url.includes(browser.runtime.id)
    );
  }
}

export async function createOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await browser.offscreen.createDocument({
    url: browser.runtime.getURL(OFFSCREEN_DOCUMENT_PATH),
    reasons: [browser.offscreen.Reason.WORKERS],
    justification: "FFmpeg",
  });
}

// Offscreen jobs in flight. When it drops to zero the document is closed,
// releasing every blob and ffmpeg instance it held; otherwise that memory
// stayed allocated until the extension was reloaded.
let activeOffscreenJobs = 0;
let closingOffscreenDocument: Promise<void> | null = null;

function closeOffscreenDocumentWhenIdle() {
  if (activeOffscreenJobs > 0 || closingOffscreenDocument) return;
  closingOffscreenDocument = (async () => {
    try {
      if (await hasOffscreenDocument()) {
        await browser.offscreen.closeDocument();
      }
    } catch (error) {
      logger.warn("Failed to close offscreen document:", error);
    }
  })().finally(() => {
    closingOffscreenDocument = null;
  });
}

async function runOffscreenJob(
  type: (typeof OFFSCREEN_KEYS)[keyof typeof OFFSCREEN_KEYS],
  options:
    | Omit<DownloadVideoOptions, "offscreen">
    | Omit<DownloadImageOptions, "offscreen">
) {
  activeOffscreenJobs++;
  try {
    // Never send work to a document that is in the middle of closing.
    await closingOffscreenDocument;
    await createOffscreenDocument();

    const downloadId = crypto.randomUUID();
    const downloadComplete = new Promise<void>((resolve, reject) => {
      pendingDownloads.set(downloadId, { resolve, reject });
    });

    await browser.runtime.sendMessage({
      type,
      target: MESSAGE_TARGET.OFFSCREEN,
      data: options,
      downloadId,
    });

    await downloadComplete;
  } finally {
    activeOffscreenJobs--;
    closeOffscreenDocumentWhenIdle();
  }
}

export const offscreenDownloadVideo = async (
  options: Omit<DownloadVideoOptions, "offscreen">
) => {
  if (!browser.offscreen) {
    return;
  }
  await runOffscreenJob(OFFSCREEN_KEYS.DOWNLOAD_VIDEO, options);
};

export const offscreenDownloadGalleryImages = async (
  options: Omit<DownloadImageOptions, "offscreen">
) => {
  if (!browser.offscreen) {
    return;
  }
  await runOffscreenJob(OFFSCREEN_KEYS.DOWNLOAD_IMAGE, options);
};

export async function handleOffscreenMessages(message: any) {
  if (!isBackgroundMessage(message)) {
    return;
  }

  const { downloadId } = message;

  try {
    switch (message.type) {
      case OFFSCREEN_KEYS.DOWNLOAD_VIDEO: {
        const video = message.data as { url?: string; filename?: string; error?: string };
        if (!video?.url) {
          throw new Error(video?.error || "No video file produced");
        }
        // Wait for the file to be written: the offscreen document (and the
        // blob behind this URL) is closed as soon as the job resolves.
        await downloadAndWait(video.url, video.filename);
        break;
      }
      case OFFSCREEN_KEYS.DOWNLOAD_IMAGE: {
        const items = message.data as
          | { url: string; filename: string }[]
          | { error?: string };
        if (!Array.isArray(items)) {
          throw new Error(items?.error || "No image files produced");
        }
        await Promise.all(
          items.map((item) => downloadAndWait(item.url, item.filename))
        );
        break;
      }
      default:
        console.warn(
          `Unexpected message received: '${JSON.stringify(message)}'.`
        );
        return;
    }

    if (downloadId) {
      pendingDownloads.get(downloadId)?.resolve();
      pendingDownloads.delete(downloadId);
    }
  } catch (error) {
    if (downloadId) {
      pendingDownloads.get(downloadId)?.reject(error);
      pendingDownloads.delete(downloadId);
    } else {
      throw error;
    }
  }
}
