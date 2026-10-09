import { format, isValid } from "date-fns";
import { fetchPostMedia } from "./reddit-post-api";
import { logger } from "./logger";
import type { SearchResultMedia } from "./search-scraping";

/**
 * old.reddit.com (and www.reddit.com with the old design preference) renders
 * posts as `div.thing` rows instead of `shreddit-post` elements. Each row
 * carries its id, subreddit, author and timestamp as data attributes but no
 * playable media, so full media resolves via the post JSON (reddit-post-api),
 * the same path search results use.
 */

const OLD_REDDIT_POST_SELECTOR = "div.thing.link[data-fullname]";

/** True when the page uses the old Reddit layout. */
export const isOldReddit = (): boolean =>
  document.querySelector("shreddit-post, shreddit-app") === null &&
  document.querySelector(OLD_REDDIT_POST_SELECTOR) !== null;

/** Post rows on the page, excluding ads. */
export const getOldRedditPosts = (): HTMLElement[] =>
  Array.from(
    document.querySelectorAll<HTMLElement>(OLD_REDDIT_POST_SELECTOR),
  ).filter((post) => !post.classList.contains("promoted"));

/** Reddit thing id (e.g. "t3_1tww4q0") for a post row. */
export const getOldRedditThingId = (post: Element): string | null =>
  post.getAttribute("data-fullname");

/** Text posts link to "self.<subreddit>" and never have media to download. */
export const isOldRedditSelfPost = (post: Element): boolean =>
  (post.getAttribute("data-domain") ?? "").startsWith("self.");

const getOldRedditPostDate = (post: Element): string | undefined => {
  const timestamp = Number(post.getAttribute("data-timestamp"));
  if (!timestamp) return undefined;
  const date = new Date(timestamp);
  return isValid(date) ? format(date, "yyyy-MM-dd") : undefined;
};

const getOldRedditTextPost = (
  post: Element,
  thingId: string,
): SearchResultMedia => ({
  type: "text",
  urls: [],
  mediaPostId: thingId,
  subredditName: post.getAttribute("data-subreddit") || "unknown",
  postTitle: post.querySelector("a.title")?.textContent?.trim() || "",
  postAuthor: post.getAttribute("data-author") || undefined,
  postDate: getOldRedditPostDate(post),
});

/**
 * Resolve a post row to downloadable media, or null when it has none. With
 * `includeTextPosts`, posts without media come back as "text" items so their
 * archive can still be saved.
 */
export const extractOldRedditPostMedia = async (
  post: Element,
  { includeTextPosts = false }: { includeTextPosts?: boolean } = {},
): Promise<SearchResultMedia | null> => {
  const thingId = getOldRedditThingId(post);
  if (!thingId) return null;
  if (isOldRedditSelfPost(post)) {
    return includeTextPosts ? getOldRedditTextPost(post, thingId) : null;
  }

  try {
    const media = await fetchPostMedia(thingId);
    if (!media) {
      return includeTextPosts ? getOldRedditTextPost(post, thingId) : null;
    }

    return {
      type: media.type,
      urls: media.urls,
      mediaPostId: thingId,
      subredditName:
        media.subredditName || post.getAttribute("data-subreddit") || "unknown",
      postTitle:
        media.postTitle ||
        post.querySelector("a.title")?.textContent?.trim() ||
        "",
      postAuthor:
        media.postAuthor || post.getAttribute("data-author") || undefined,
      postDate: media.postDate || getOldRedditPostDate(post),
    };
  } catch (error) {
    logger.warn(`Failed to extract media for ${thingId}, skipping`, error);
    return null;
  }
};
