import { ProtocolWithReturn } from "webext-bridge";
import { MediaContentType } from "../types";
import type { PostDiagnostic, SkipReason } from "../utils/diagnostics";

export interface ScanPageMediaMessage {
  success: boolean;
  data: {
    totalPosts: number;
    mediaUrls: {
      urls: string[];
      type: MediaContentType;
      subredditName: string;
      mediaPostId: string;
      postTitle?: string;
      postAuthor?: string;
      postDate?: string;
    }[];
    /** Every post the scan looked at and did not turn into a candidate. */
    skipped?: PostDiagnostic[];
    /**
     * Counts per reason for ALL skips this scan, including the routine ones
     * that were counted but not individually recorded. Keeps the report's
     * summary honest about what happened.
     */
    skipTally?: Record<string, number>;
    /** How many post elements were examined in this pass. */
    examined?: number;
  };
}

export interface HighlightPostMessage {
  mediaPostId: string;
  subredditName: string;
  mediaType: string;
}

export interface HighlightPostResponse {
  success: boolean;
}

export interface ScrollToLoadMoreResponse {
  success: boolean;
  /** Whether more posts (or more page) actually appeared after scrolling. */
  grew: boolean;
  postsBefore: number;
  postsAfter: number;
  heightBefore: number;
  heightAfter: number;
  atBottom: boolean;
}

export interface PingResponse {
  success: boolean;
  url: string;
  posts: number;
  layout: "feed" | "search" | "old-reddit";
}

export interface DownloadRequestMessage {
  timestamp: number;
  mediaContentType: MediaContentType;
  urls: string[];
  folderDestination: string;
  subredditName: string;
  useGalleryFolders: boolean;
  addTitleToImages: boolean;
  addTitleToVideos: boolean;
  postTitle?: string;
  postAuthor?: string;
  /** Reddit thing id (t3_...), needed to save the post archive. */
  postId?: string;
  savePostArchive?: boolean;
}

export interface DownloadRequestResponse {
  success: boolean;
  message?: string;
  /** Diagnostic reason code when success is false. */
  reason?: SkipReason;
}

declare module "webext-bridge" {
  export interface ProtocolMap {
    SCAN_PAGE_MEDIA: ProtocolWithReturn<
      { scrollUp?: boolean; anchorPostId?: string; skipPostIds?: string[] },
      ScanPageMediaMessage
    >;
    GET_CURRENT_POST_ID: ProtocolWithReturn<
      void,
      { success: boolean; postId?: string }
    >;
    MARK_POST_VISITED: ProtocolWithReturn<
      { mediaPostId: string },
      { success: boolean }
    >;
    HIGHLIGHT_CURRENT_POST: ProtocolWithReturn<
      HighlightPostMessage,
      HighlightPostResponse
    >;
    SCROLL_TO_LOAD_MORE: ProtocolWithReturn<
      { scrollUp?: boolean },
      ScrollToLoadMoreResponse
    >;
    PING: ProtocolWithReturn<void, PingResponse>;
    DOWNLOAD_REQUEST: ProtocolWithReturn<
      DownloadRequestMessage,
      DownloadRequestResponse
    >;
  }
}
