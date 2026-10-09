import { format, fromUnixTime } from "date-fns";
import { fetchPostThread } from "./reddit-post-api";
import { createTextFileUrl, downloadAndRelease } from "./blob-utils";
import {
  generateFilename,
  getCurrentTimestamp,
  sanitizeDownloadPath,
} from "./filename-utils";
import { logger } from "./logger";

/**
 * Save a post as a standalone HTML page: title, metadata, body, images and the
 * full comment tree, without Reddit's sidebars or ads. Opening the file and
 * printing it ("Save as PDF") gives a clean PDF copy of the discussion.
 */

type RedditComment = {
  kind: string;
  data: {
    author?: string;
    body_html?: string;
    score?: number;
    created_utc?: number;
    count?: number;
    replies?: { data?: { children?: RedditComment[] } } | "";
  };
};

type RedditPost = {
  id?: string;
  title?: string;
  author?: string;
  subreddit?: string;
  created_utc?: number;
  score?: number;
  num_comments?: number;
  permalink?: string;
  url?: string;
  selftext_html?: string | null;
  post_hint?: string;
  domain?: string;
  is_video?: boolean;
  is_gallery?: boolean;
  media_metadata?: Record<string, { s?: { u?: string; gif?: string } }>;
  gallery_data?: { items?: { media_id: string; caption?: string }[] };
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const formatTimestamp = (utcSeconds?: number) =>
  utcSeconds ? format(fromUnixTime(utcSeconds), "yyyy-MM-dd HH:mm") : "";

const renderImages = (post: RedditPost): string => {
  if (post.is_gallery && post.media_metadata && post.gallery_data?.items) {
    return post.gallery_data.items
      .map((item) => {
        const source = post.media_metadata?.[item.media_id]?.s;
        const src = source?.u || source?.gif;
        if (!src) return "";
        const caption = item.caption
          ? `<figcaption>${escapeHtml(item.caption)}</figcaption>`
          : "";
        return `<figure><img src="${escapeHtml(src)}" alt="">${caption}</figure>`;
      })
      .join("\n");
  }
  if (post.post_hint === "image" || post.domain === "i.redd.it") {
    return post.url
      ? `<figure><img src="${escapeHtml(post.url)}" alt=""></figure>`
      : "";
  }
  if (post.is_video) {
    return `<p class="note">Video post: the video is saved as a separate file.</p>`;
  }
  // Link posts: keep the destination.
  if (post.url && !post.domain?.startsWith("self.")) {
    return `<p><a href="${escapeHtml(post.url)}">${escapeHtml(post.url)}</a></p>`;
  }
  return "";
};

const renderComments = (children: RedditComment[] = []): string => {
  const items = children
    .map((child) => {
      if (child.kind === "more") {
        const count = child.data.count ?? 0;
        return count > 0
          ? `<li class="more">${count} more ${count === 1 ? "reply" : "replies"} not loaded</li>`
          : "";
      }
      if (child.kind !== "t1") return "";

      const { author, body_html, score, created_utc, replies } = child.data;
      const nested =
        replies && typeof replies === "object"
          ? renderComments(replies.data?.children)
          : "";
      return `<li>
  <p class="meta">u/${escapeHtml(author ?? "[deleted]")} · ${score ?? 0} points · ${formatTimestamp(created_utc)}</p>
  <div class="body">${body_html ?? ""}</div>
  ${nested}
</li>`;
    })
    .filter(Boolean);
  return items.length ? `<ul>${items.join("\n")}</ul>` : "";
};

const STYLES = `
  body { font: 15px/1.55 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1b; background: #fff; }
  h1 { font-size: 1.5rem; line-height: 1.3; margin: .25rem 0 .75rem; }
  a { color: #0b57d0; }
  .meta { color: #6b6b6b; font-size: .8rem; margin: 0; }
  figure { margin: 1rem 0; }
  figure img { max-width: 100%; height: auto; display: block; }
  figcaption, .note, .more { color: #6b6b6b; font-size: .85rem; }
  .comments ul { list-style: none; padding-left: 1rem; margin: 0; border-left: 2px solid #e5e5e5; }
  .comments > ul { border-left: 0; padding-left: 0; }
  .comments li { margin: .75rem 0; break-inside: avoid; }
  .body p { margin: .35rem 0; }
  blockquote { border-left: 3px solid #ccc; margin: .5rem 0; padding-left: .75rem; color: #555; }
  pre { white-space: pre-wrap; background: #f6f6f6; padding: .5rem; }
  @media print { body { margin: 0; max-width: none; } a { color: inherit; } }
`;

export const buildPostArchiveHtml = (thread: unknown[]): string | null => {
  const listing = thread as {
    data?: { children?: { data?: RedditPost }[] | RedditComment[] };
  }[];
  const post = (listing[0]?.data?.children?.[0] as { data?: RedditPost })
    ?.data;
  if (!post) return null;

  const comments = (listing[1]?.data?.children ?? []) as RedditComment[];
  const title = escapeHtml(post.title ?? "Untitled post");
  const permalink = post.permalink
    ? `https://www.reddit.com${post.permalink}`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
<article>
  <p class="meta">r/${escapeHtml(post.subreddit ?? "unknown")} · u/${escapeHtml(post.author ?? "[deleted]")} · ${formatTimestamp(post.created_utc)} · ${post.score ?? 0} points</p>
  <h1>${title}</h1>
  ${permalink ? `<p class="meta"><a href="${escapeHtml(permalink)}">${escapeHtml(permalink)}</a></p>` : ""}
  ${post.selftext_html ?? ""}
  ${renderImages(post)}
</article>
<section class="comments">
  <h2>Comments (${post.num_comments ?? 0})</h2>
  ${renderComments(comments) || `<p class="note">No comments.</p>`}
</section>
<p class="meta">Saved ${format(new Date(), "yyyy-MM-dd HH:mm")} with RedditGrab.</p>
</body>
</html>`;
};

export type SavePostArchiveOptions = {
  postId: string;
  folderDestination: string;
  subredditName: string;
  filenamePattern: string;
  postTitle?: string;
  postAuthor?: string;
};

/** Fetch a post's thread and save it as an HTML file next to its media. */
export const downloadPostArchive = async (options: SavePostArchiveOptions) => {
  const thread = await fetchPostThread(options.postId);
  const html = thread ? buildPostArchiveHtml(thread) : null;
  if (!html) {
    throw new Error(`Could not load post ${options.postId} for archiving`);
  }

  const filename = generateFilename(options.filenamePattern, {
    subreddit: options.subredditName,
    timestamp: getCurrentTimestamp(),
    filename: options.postId.replace(/^t3_/, ""),
    extension: "html",
    title: options.postTitle,
    user: options.postAuthor,
  });
  const outputPath = sanitizeDownloadPath(
    `${options.folderDestination}/${filename}`,
  );

  const url = createTextFileUrl(html, "text/html;charset=utf-8");
  logger.log("Saving post archive:", outputPath);
  await downloadAndRelease(url, outputPath);
};
