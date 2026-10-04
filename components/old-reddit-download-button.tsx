import { useState } from "react";
import { sendMessage } from "webext-bridge/content-script";
import {
  folderDestination as folderDestinationStorage,
  useGalleryFolders as useGalleryFoldersStorage,
  addTitleToImages as addTitleToImagesStorage,
  addTitleToVideos as addTitleToVideosStorage,
  markDownloadedAsVisited as markDownloadedAsVisitedStorage,
  addProcessedPostId,
} from "@/utils/storage";
import { extractOldRedditPostMedia } from "@/utils/old-reddit";
import { markPostAsVisited } from "@/utils/mark-visited";
import { processFolderDestination } from "@/utils/post-utils";

type Status = "idle" | "downloading" | "no-media" | "failed";

const LABELS: Record<Status, string> = {
  idle: "download",
  downloading: "downloading...",
  "no-media": "no media found",
  failed: "download failed",
};

/**
 * Per-post download link for old Reddit, styled like the row's other action
 * links (comments, share, save...). Old Reddit rows carry no media, so it is
 * resolved from the post JSON when clicked.
 */
const OldRedditDownloadButton = ({ post }: { post: Element }) => {
  const [status, setStatus] = useState<Status>("idle");

  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (status === "downloading") return;

    setStatus("downloading");
    try {
      const media = await extractOldRedditPostMedia(post);
      if (!media) {
        setStatus("no-media");
        return;
      }

      const [
        folderConfig,
        useGalleryFolders,
        addTitleToImages,
        addTitleToVideos,
      ] = await Promise.all([
        folderDestinationStorage.getValue(),
        useGalleryFoldersStorage.getValue(),
        addTitleToImagesStorage.getValue(),
        addTitleToVideosStorage.getValue(),
      ]);

      const response = await sendMessage(
        "DOWNLOAD_REQUEST",
        {
          timestamp: Date.now(),
          mediaContentType: media.type,
          urls: media.urls,
          folderDestination: processFolderDestination(
            folderConfig,
            null,
            media.subredditName,
            media.postDate,
            media.postAuthor,
            media.postTitle,
          ),
          subredditName: media.subredditName,
          useGalleryFolders,
          addTitleToImages,
          addTitleToVideos,
          postTitle: media.postTitle,
          postAuthor: media.postAuthor,
        },
        "background",
      );

      if (!response?.success) {
        console.error("Download request failed:", response);
        setStatus("failed");
        return;
      }

      await addProcessedPostId(media.mediaPostId);
      if (await markDownloadedAsVisitedStorage.getValue()) {
        markPostAsVisited(post);
      }
      setStatus("idle");
    } catch (error) {
      console.error("Failed to send download request:", error);
      setStatus("failed");
    }
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={status === "downloading"}
      className="cursor-pointer bg-transparent border-0 p-0 px-1 text-[10px] font-bold text-[#888] hover:underline disabled:cursor-wait"
    >
      {LABELS[status]}
    </button>
  );
};

export default OldRedditDownloadButton;
