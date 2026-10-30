// "text" is a post with no downloadable media; only its archive is saved.
export type MediaContentType =
  | "video"
  | "single-image"
  | "multiple-images"
  | "text";

export type DownloadVideoOptions = {
  url: string;
  folderDestination: string;
  subredditName: string;
  addTitleToVideo: boolean;
  postTitle: string;
  postAuthor?: string;
  filenamePattern: string;
};

export type DownloadImageOptions = {
  urls: string[];
  folderDestination?: string;
  subredditName?: string;
  useGalleryFolders?: boolean;
  addTitleToImages?: boolean;
  postTitle?: string;
  postAuthor?: string;
  filenamePattern: string;
};
