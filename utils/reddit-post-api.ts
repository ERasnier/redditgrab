import { fetchWithTimeout } from "./fetch-timeout";
import type { MediaContentType } from "@/types";
import { getHighestQualityHLS } from "./media-download";
import { logger } from "./logger";
import { format, fromUnixTime } from "date-fns";
import { requestDelaySeconds } from "./storage";

/**
 * Search results expose only a thumbnail for videos, redgifs, and single images
 * (galleries are the exception, handled from the DOM carousel). To download full
 * media for those types we fetch the post's own data and read the media URLs.
 *
 * The bare `comments/<id>.json` path redirects to HTML; the trailing-slash form
 * with `raw_json=1` returns clean JSON with un-escaped URLs.
 */

type PostApiMedia = {
  type: MediaContentType;
  urls: string[];
  subredditName: string;
  postTitle: string;
  postAuthor: string;
  postDate: string;
};

/** Reddit's post JSON is loosely typed; we only read a handful of fields. */
type RedditPostData = {
  subreddit?: string;
  title?: string;
  author?: string;
  created_utc?: number;
  domain?: string;
  post_hint?: string;
  is_video?: boolean;
  is_gallery?: boolean;
  url?: string;
  media?: RedditMedia;
  secure_media?: RedditMedia;
  media_metadata?: Record<string, { s?: { u?: string; gif?: string } }>;
  gallery_data?: { items?: { media_id: string }[] };
  name?: string;
  is_self?: boolean;
  removed_by_category?: string | null;
  /** A crosspost carries its media on the original post. */
  crosspost_parent_list?: RedditPostData[];
};

type RedditMedia = {
  reddit_video?: { hls_url?: string };
  oembed?: { provider_name?: string; html?: string };
};

const extractRedgifsId = (
  oembedHtml?: string,
  url?: string,
): string | null => {
  const fromHtml = oembedHtml?.match(/redgifs\.com\/ifr\/([^"?&/]+)/);
  if (fromHtml) return fromHtml[1];
  const fromUrl = url?.match(/redgifs\.com\/(?:watch|ifr)\/([^/?#]+)/i);
  if (fromUrl) return fromUrl[1];
  return null;
};

const extractMediaUrls = async (
  post: RedditPostData,
): Promise<{ type: MediaContentType; urls: string[] } | null> => {
  const media = post.media ?? post.secure_media;
  const oembedHtml = media?.oembed?.html;
  const provider = media?.oembed?.provider_name;

  // RedGIFs: build the HD m3u8 from the embed id (matches the DOM path output).
  if (post.domain === "redgifs.com" || provider === "RedGIFs") {
    const id = extractRedgifsId(oembedHtml, post.url);
    if (id) {
      return {
        type: "video",
        urls: [`https://api.redgifs.com/v2/gifs/${id}/hd.m3u8`],
      };
    }
    logger.warn("RedGIFs post without resolvable id, skipping");
    return null;
  }

  // Reddit-hosted video: resolve the master HLS to the highest-quality
  // video+audio media playlists, exactly like the on-page video path does.
  const redditVideo = media?.reddit_video;
  if (post.is_video && redditVideo?.hls_url) {
    const processed = await getHighestQualityHLS(redditVideo.hls_url);
    return { type: "video", urls: [processed] };
  }

  // Single image: `url` is the full-resolution i.redd.it original.
  if (
    (post.post_hint === "image" || post.domain === "i.redd.it") &&
    typeof post.url === "string" &&
    post.url
  ) {
    return { type: "single-image", urls: [post.url] };
  }

  // Gallery fallback (the DOM carousel normally covers this).
  if (post.is_gallery && post.media_metadata && post.gallery_data?.items) {
    const urls = post.gallery_data.items
      .map((item) => {
        const meta = post.media_metadata?.[item.media_id]?.s;
        return meta?.u || meta?.gif;
      })
      .filter((u): u is string => Boolean(u))
      .map((u) => u.replace(/&amp;/g, "&"));
    if (urls.length > 0) return { type: "multiple-images", urls };
  }

  // A crosspost: the media lives on the post it was crossposted from.
  const parent = post.crosspost_parent_list?.[0];
  if (parent && parent !== post) return extractMediaUrls(parent);

  return null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Earliest time the next post lookup may start. Scans resolve many posts at
// once; spacing the requests out keeps Reddit from rate limiting the page.
let nextRequestAt = 0;

const waitForRequestSlot = async () => {
  const delayMs = Math.max(0, (await requestDelaySeconds.getValue()) * 1000);
  const now = Date.now();
  const startAt = Math.max(now, nextRequestAt);
  nextRequestAt = startAt + delayMs;
  if (startAt > now) await sleep(startAt - now);
};

const MAX_RETRY_AFTER_MS = 30_000;

const fetchPostJson = async (id: string, extraQuery = "") => {
  const url = `https://www.reddit.com/comments/${id}/.json?raw_json=1${extraQuery}`;
  await waitForRequestSlot();
  const res = await fetchWithTimeout(url, { credentials: "include" });
  if (res.status !== 429) return res;

  // Rate limited: wait as long as Reddit asks (capped), then retry once.
  const retryAfterSeconds = Number(res.headers.get("retry-after"));
  const waitMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
      : 5000;
  logger.warn(`Rate limited fetching ${id}, retrying in ${waitMs}ms`);
  nextRequestAt = Math.max(nextRequestAt, Date.now() + waitMs);
  await waitForRequestSlot();
  return fetchWithTimeout(url, { credentials: "include" });
};

/**
 * Fetch full media for a post by its thing id. Returns null for unsupported
 * media (external hosts, text posts) or on any fetch/parse failure.
 */
export const fetchPostMedia = async (
  thingId: string,
): Promise<PostApiMedia | null> => {
  const id = thingId.replace(/^t3_/, "");

  let post: RedditPostData | undefined;
  try {
    const res = await fetchPostJson(id);
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("json")) {
      logger.warn(
        `Post JSON unavailable for ${id} (status ${res.status}, ${contentType})`,
      );
      return null;
    }
    const json = await res.json();
    post = json?.[0]?.data?.children?.[0]?.data;
  } catch (error) {
    logger.warn(`Failed to fetch post JSON for ${id}`, error);
    return null;
  }

  if (!post) return null;

  let media: { type: MediaContentType; urls: string[] } | null;
  try {
    media = await extractMediaUrls(post);
  } catch (error) {
    logger.warn(`Failed to extract media for ${id}`, error);
    return null;
  }
  if (!media || media.urls.length === 0) return null;

  return {
    ...media,
    subredditName: post.subreddit || "unknown",
    postTitle: post.title || "",
    postAuthor: post.author || "unknown-user",
    postDate: post.created_utc
      ? format(fromUnixTime(post.created_utc), "yyyy-MM-dd")
      : "",
  };
};

/**
 * Fetch a post's full listing (post + comment tree) for archiving. Returns the
 * raw `[post listing, comments listing]` JSON, or null on failure.
 */
export const fetchPostThread = async (
  thingId: string,
): Promise<unknown[] | null> => {
  const id = thingId.replace(/^t3_/, "");
  try {
    const res = await fetchPostJson(id, "&limit=500");
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok || !contentType.includes("json")) {
      logger.warn(`Post thread unavailable for ${id} (status ${res.status})`);
      return null;
    }
    const json = await res.json();
    return Array.isArray(json) ? json : null;
  } catch (error) {
    logger.warn(`Failed to fetch post thread for ${id}`, error);
    return null;
  }
};

export type BatchLookup =
  | { status: "ok"; media: PostApiMedia }
  | { status: "no-media"; reason: string };

/** Posts per `/api/info` request; Reddit's own limit. */
export const INFO_BATCH_SIZE = 100;

const describeNoMedia = (post: RedditPostData) => {
  if (post.removed_by_category) return `removed (${post.removed_by_category})`;
  if (post.is_self) return "text post, no media";
  if (post.domain) return `nothing downloadable from ${post.domain}`;
  return "no downloadable media";
};

/**
 * Look up to 100 posts at once through `/api/info`, for a large job: one
 * request instead of a hundred. Posts Reddit doesn't return (deleted, banned
 * subreddits, private) come back as "no-media" with a reason. Throws if the
 * request itself fails, so the caller can retry the batch rather than mark a
 * hundred posts as having nothing.
 */
export const fetchPostsMedia = async (
  thingIds: string[],
): Promise<Map<string, BatchLookup>> => {
  const ids = thingIds.slice(0, INFO_BATCH_SIZE).map((id) =>
    id.startsWith("t3_") ? id : `t3_${id}`,
  );
  const url = `https://www.reddit.com/api/info.json?raw_json=1&id=${ids.join(",")}`;
  await waitForRequestSlot();
  let res = await fetchWithTimeout(url, { credentials: "include" });
  if (res.status === 429) {
    const retryAfterSeconds = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
        : 5000;
    logger.warn(`Rate limited looking up ${ids.length} posts, retrying in ${waitMs}ms`);
    nextRequestAt = Math.max(nextRequestAt, Date.now() + waitMs);
    await waitForRequestSlot();
    res = await fetchWithTimeout(url, { credentials: "include" });
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("json")) {
    throw new Error(`Reddit's post lookup answered ${res.status} (${contentType || "no content type"})`);
  }
  const json = await res.json();
  const posts: RedditPostData[] = (json?.data?.children ?? [])
    .map((child: { data?: RedditPostData }) => child?.data)
    .filter(Boolean);

  const results = new Map<string, BatchLookup>();
  for (const post of posts) {
    const id = post.name;
    if (!id) continue;
    let media: { type: MediaContentType; urls: string[] } | null = null;
    try {
      media = await extractMediaUrls(post);
    } catch (error) {
      results.set(id, {
        status: "no-media",
        reason: `couldn't read the media: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (!media || media.urls.length === 0) {
      results.set(id, { status: "no-media", reason: describeNoMedia(post) });
      continue;
    }
    results.set(id, {
      status: "ok",
      media: {
        ...media,
        subredditName: post.subreddit || "unknown",
        postTitle: post.title || "",
        postAuthor: post.author || "unknown-user",
        postDate: post.created_utc
          ? format(fromUnixTime(post.created_utc), "yyyy-MM-dd")
          : "",
      },
    });
  }
  for (const id of ids) {
    if (!results.has(id)) {
      results.set(id, {
        status: "no-media",
        reason: "Reddit didn't return the post (deleted, private or banned)",
      });
    }
  }
  return results;
};
