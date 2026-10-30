import "~/assets/tailwind.css";
import ReactDOM from "react-dom/client";
import type { MediaContentType } from "~/types";
import DownloadButton from "@/components/download-button";
import OldRedditDownloadButton from "@/components/old-reddit-download-button";
import { onMessage } from "webext-bridge/content-script";
import { Selectors } from "@/utils/constants";
import {
  processedPostIds,
  useDateRange,
  dateRangeStart,
  dateRangeEnd,
  showDownloadedMarkers,
  forceDownloadProcessed,
  savePostArchive,
} from "@/utils/storage";
import { compact } from "es-toolkit";
import { logger, isDebugEnabled } from "@/utils/logger";
import { parseISO, isValid } from "date-fns";
import { markPostAsVisited } from "@/utils/mark-visited";
import { getPostIdentifier, setPostIdentifier } from "@/utils/post-identifier";
import {
  getPostTitle,
  getPostAuthor,
  getPostDate,
  getPostDatetime,
} from "@/utils/post-utils";
import {
  isSearchResultsPage,
  getSearchResultRoots,
  getSearchThingId,
  findSearchRowByThingId,
  extractSearchResultMedia,
  getSearchSubredditName,
  getSearchPostTitle,
  type SearchResultMedia,
} from "@/utils/search-scraping";
import {
  isOldReddit,
  getOldRedditPosts,
  getOldRedditThingId,
  isOldRedditSelfPost,
  extractOldRedditPostMedia,
} from "@/utils/old-reddit";
import {
  DiagnosticsCollector,
  SKIP_REASON_TEXT,
  isFailure,
  permalinkForPostId,
  type PostDiagnostic,
  type SkipReason,
} from "@/utils/diagnostics";

/**
 * One-line description of a DOM element for diagnostics — enough to tell a text
 * post from a crosspost from a layout Reddit has renamed under us, without
 * dumping the element itself into the log.
 */
const describeElement = (el: Element): string => {
  const parts = [el.tagName.toLowerCase()];
  for (const attr of ["post-type", "domain", "data-domain", "data-testid"]) {
    const value = el.getAttribute(attr);
    if (value) parts.push(`${attr}=${value}`);
  }
  const childTags = Array.from(el.children)
    .slice(0, 6)
    .map((child) => child.tagName.toLowerCase());
  if (childTags.length) parts.push(`children=[${childTags.join(",")}]`);
  return parts.join(" ");
};

/**
 * Record a skip and echo it to the console.
 *
 * `enrich` supplies title/subreddit/permalink and is only invoked when the
 * record will actually be stored — those are DOM queries, and running them for
 * every already-downloaded post on every scan cycle is exactly the per-tick
 * waste this pass removes.
 */
const recordSkip = (
  collector: DiagnosticsCollector,
  base: Pick<PostDiagnostic, "postId" | "reason"> &
    Partial<Pick<PostDiagnostic, "detail" | "stage" | "source">>,
  enrich?: () => Partial<
    Pick<PostDiagnostic, "title" | "subreddit" | "permalink">
  >,
) => {
  const extra = collector.willStore(base.reason) ? (enrich?.() ?? {}) : {};
  collector.add({ ...base, ...extra });

  const text = SKIP_REASON_TEXT[base.reason] ?? base.reason;
  const line = `${isFailure(base.reason) ? "FAILED" : "skipped"} ${base.postId} — ${base.reason}: ${text}`;
  if (isFailure(base.reason)) {
    logger.error(line, base.detail ?? "");
  } else {
    logger.log(line, base.detail ?? "");
  }
};

/** Always-visible summary of what a scan pass did and did not pick up. */
const logScanSummary = (
  label: string,
  examined: number,
  resolved: number,
  collector: DiagnosticsCollector,
) => {
  const parts = Object.entries(collector.tally())
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${reason}=${count}`);
  logger.always(
    `${label}: examined ${examined}, queued ${resolved}, skipped ${collector.totalSkipped}` +
      (parts.length ? ` (${parts.join(", ")})` : ""),
  );
};

const scrollToLoadMore = (scrollUp: boolean) => {
  if (scrollUp) {
    window.scrollTo({
      top: 0,
      behavior: "smooth",
    });
    logger.log("Scrolled to top to load newer posts");
  } else {
    window.scrollTo({
      top: document.body.scrollHeight,
      behavior: "smooth",
    });
    logger.log("Scrolled to bottom to load more posts");
  }
};

/**
 * How many post elements the current layout has on the page. Used to tell
 * "Reddit loaded more" from "there is nothing left", which is what lets a
 * mass download finish instead of scrolling at the bottom forever.
 */
const countPostRoots = (): number => {
  if (isOldReddit()) return getOldRedditPosts().length;
  if (isSearchResultsPage()) return getSearchResultRoots().length;
  return document.querySelectorAll("shreddit-post").length;
};

/** Longest we wait for Reddit to append more posts after scrolling. */
const LOAD_MORE_TIMEOUT_MS = 6000;
const LOAD_MORE_POLL_MS = 400;

/**
 * Scroll, then wait for the page to actually grow.
 *
 * The old version scrolled and slept a flat 2s, reporting only `success: true`
 * — so the caller could never distinguish "more posts arrived" from "we are at
 * the end of the listing", and the scroll-down loop had no terminal state. It
 * now polls for new posts and reports what happened, returning as soon as
 * something loads rather than always paying the full wait.
 */
const scrollAndWaitForMore = async (scrollUp: boolean) => {
  const postsBefore = countPostRoots();
  const heightBefore = document.body.scrollHeight;

  scrollToLoadMore(scrollUp);

  const deadline = Date.now() + LOAD_MORE_TIMEOUT_MS;
  let postsAfter = postsBefore;
  let heightAfter = heightBefore;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOAD_MORE_POLL_MS));
    postsAfter = countPostRoots();
    heightAfter = document.body.scrollHeight;
    if (postsAfter > postsBefore) break;
  }

  // Within a post of the bottom, allowing for sub-pixel zoom rounding.
  const atBottom =
    window.innerHeight + window.scrollY >= document.body.scrollHeight - 2;

  const result = {
    success: true,
    grew: postsAfter > postsBefore || heightAfter > heightBefore,
    postsBefore,
    postsAfter,
    heightBefore,
    heightAfter,
    atBottom,
  };
  logger.log("Scroll result:", result);
  return result;
};

const isPostInDateRange = (
  post: Element,
  startTimestamp?: string,
  endTimestamp?: string,
): boolean => {
  if (!startTimestamp && !endTimestamp) return true;

  try {
    // Get the post datetime using shared function
    const datetime = getPostDatetime(post);
    if (!datetime) {
      logger.log("No datetime found for post, including in range");
      return true; // If we can't determine date, include it
    }

    // Parse the post date using date-fns
    const postDate = parseISO(datetime);
    if (!isValid(postDate)) {
      logger.log(`Invalid post date format: ${datetime}, including in range`);
      return true;
    }

    const postTimestamp = postDate.getTime();

    // Parse start and end timestamps if provided
    const start = startTimestamp ? parseInt(startTimestamp) : null;
    const end = endTimestamp ? parseInt(endTimestamp) : null;

    // Validate parsed timestamps
    if (start && isNaN(start)) {
      logger.log(
        `Invalid start timestamp: ${startTimestamp}, including in range`,
      );
      return true;
    }

    if (end && isNaN(end)) {
      logger.log(`Invalid end timestamp: ${endTimestamp}, including in range`);
      return true;
    }

    // Check if post is before start timestamp
    if (start && postTimestamp < start) {
      return false;
    }

    // Check if post is after end timestamp
    if (end && postTimestamp > end) {
      return false;
    }
    return true;
  } catch (error) {
    logger.error("Error checking post date range:", error);
    return true; // If there's an error, include the post
  }
};

// ── Search-result download highlight ─────────────────────────────────────────
// Overlay border that scrolls with the row (approach from civitai-dl). Styled
// via the CSSOM + Web Animations API rather than an injected <style>, because
// Reddit's CSP blocks injected stylesheets (which left the overlay invisible).
// Each highlight persists until the next one starts; a long timeout cleans up
// the final one.
const RG_HIGHLIGHT_TIMEOUT_MS = 20000;

const clearHighlights = () => {
  document
    .querySelectorAll("[data-rg-dl-highlight]")
    .forEach((el) => el.remove());
};

/** Prefer a clipped, rounded ancestor so the border hugs the visible tile. */
const getHighlightTarget = (card: HTMLElement): HTMLElement => {
  let el: HTMLElement | null = card;
  while (el && el !== document.body) {
    const { overflow, overflowX, overflowY, borderRadius } =
      getComputedStyle(el);
    const clipped = [overflow, overflowX, overflowY].some(
      (value) => value === "hidden" || value === "clip",
    );
    if (clipped && borderRadius !== "0px") return el;
    el = el.parentElement;
  }
  return card;
};

/**
 * Resolve an element that forms a real positioning box. Reddit's search rows are
 * `search-telemetry-tracker` custom elements with `display:inline` (or
 * `contents`), where `position:relative` has no useful box, so an absolute child
 * (`right:0`) lands on the wrong side. Fall through to the first block-level child.
 */
const resolveBoxElement = (el: HTMLElement): HTMLElement => {
  const display = getComputedStyle(el).display;
  if (display === "inline" || display === "contents") {
    const child = el.firstElementChild as HTMLElement | null;
    if (child) return child;
  }
  return el;
};

/** Overlay inside the card so it scrolls with the page (no per-frame sync). */
const highlightCard = (card: HTMLElement) => {
  clearHighlights();

  const target = resolveBoxElement(getHighlightTarget(card));
  if (getComputedStyle(target).position === "static") {
    target.style.position = "relative";
  }

  const overlay = document.createElement("div");
  overlay.dataset.rgDlHighlight = "";
  // Explicit offsets (not the `inset` shorthand) so the overlay reliably fills
  // the row in Firefox, where `inset:0` via cssText didn't apply (rendered as a
  // small box in the corner).
  overlay.style.cssText = [
    "position:absolute",
    "top:0",
    "left:0",
    "right:0",
    "bottom:0",
    "pointer-events:none",
    "z-index:9998",
    "box-sizing:border-box",
    "border:3px solid #3b82f6",
    "border-radius:8px",
  ].join(";");
  target.appendChild(overlay);

  const animation = overlay.animate(
    [
      {
        boxShadow:
          "0 0 0 2px rgba(59,130,246,0.45), 0 0 22px rgba(59,130,246,0.45)",
        borderColor: "#3b82f6",
      },
      {
        boxShadow:
          "0 0 0 3px rgba(96,165,250,0.55), 0 0 34px rgba(96,165,250,0.70)",
        borderColor: "#60a5fa",
      },
      {
        boxShadow:
          "0 0 0 2px rgba(59,130,246,0.45), 0 0 22px rgba(59,130,246,0.45)",
        borderColor: "#3b82f6",
      },
    ],
    { duration: 1400, iterations: Infinity, easing: "ease-in-out" },
  );

  window.setTimeout(() => {
    animation.cancel();
    overlay.remove();
  }, RG_HIGHLIGHT_TIMEOUT_MS);
};

// ── "Downloaded" corner marker (green triangle + check), shown on posts/rows
//    whose id is in processedPostIds. Styled via CSSOM (CSP-safe). ─────────────
const RG_DOWNLOADED_ATTR = "data-rg-downloaded";

const addDownloadedBadge = (el: HTMLElement) => {
  if (el.querySelector(`:scope > [${RG_DOWNLOADED_ATTR}]`)) return;
  if (getComputedStyle(el).position === "static") {
    el.style.position = "relative";
  }
  const wrap = document.createElement("div");
  wrap.setAttribute(RG_DOWNLOADED_ATTR, "");
  wrap.title = "Downloaded with RedditGrab";
  wrap.style.cssText = [
    "position:absolute",
    "top:0",
    "right:0",
    "width:24px",
    "height:24px",
    "z-index:9997",
    "pointer-events:none",
  ].join(";");

  const triangle = document.createElement("div");
  triangle.style.cssText = [
    "position:absolute",
    "top:0",
    "right:0",
    "width:0",
    "height:0",
    "border-style:solid",
    "border-width:0 24px 24px 0",
    "border-color:transparent #16a34a transparent transparent",
    "filter:drop-shadow(0 1px 1px rgba(0,0,0,0.35))",
  ].join(";");

  const check = document.createElement("span");
  check.textContent = "✓";
  check.style.cssText = [
    "position:absolute",
    "top:1px",
    "right:2px",
    "color:#fff",
    "font-size:12px",
    "font-weight:700",
    "line-height:14px",
  ].join(";");

  wrap.appendChild(triangle);
  wrap.appendChild(check);
  el.appendChild(wrap);
};

const removeDownloadedBadge = (el: HTMLElement) => {
  el.querySelector(`:scope > [${RG_DOWNLOADED_ATTR}]`)?.remove();
};

/**
 * Cached view of the processed-post ids.
 *
 * `refreshDownloadedMarkers` runs off a 150ms-debounced scroll handler, and it
 * used to deserialise the entire id array out of storage and build a fresh Set
 * on every tick. With tens of thousands of stored ids that is megabytes of
 * allocation per second during an auto-scroll. The Set is built once and
 * invalidated by the storage watcher below.
 */
let processedIdCache: Set<string> | null = null;

const getProcessedIdSet = async (): Promise<Set<string>> => {
  processedIdCache ??= new Set(await processedPostIds.getValue());
  return processedIdCache;
};

const invalidateProcessedIdCache = () => {
  processedIdCache = null;
};

/** Add/remove the downloaded marker on every visible post/row to match storage. */
const refreshDownloadedMarkers = async () => {
  // Off by default; when disabled, strip any badges and bail.
  if (!(await showDownloadedMarkers.getValue())) {
    document
      .querySelectorAll(`[${RG_DOWNLOADED_ATTR}]`)
      .forEach((b) => b.remove());
    return;
  }

  const ids = await getProcessedIdSet();
  const onOldReddit = isOldReddit();
  const onSearch = !onOldReddit && isSearchResultsPage();
  const targets = onOldReddit
    ? getOldRedditPosts()
    : onSearch
      ? getSearchResultRoots()
      : Array.from(document.querySelectorAll("shreddit-post"));

  for (const el of targets) {
    const target = el as HTMLElement;
    const id = onOldReddit
      ? getOldRedditThingId(target)
      : onSearch
        ? getSearchThingId(target)
        : getPostIdentifier(target);
    const box = resolveBoxElement(target);
    const hasBadge = !!box.querySelector(`:scope > [${RG_DOWNLOADED_ATTR}]`);
    if (id && ids.has(id)) {
      if (!hasBadge) addDownloadedBadge(box);
    } else if (hasBadge) {
      removeDownloadedBadge(box);
    }
  }
};

// Thing-ids that resolved to no downloadable media (external hosts, text posts,
// failed fetches). Session-only, cleared on page reload. Prevents the mass
// downloader from re-fetching the same dead posts every scan cycle (which would
// pile up requests and invite rate limiting). Kept separate from
// processedPostIds so these never get a "downloaded" marker.
const unsupportedThingIds = new Set<string>();

/**
 * Pages whose posts carry no usable media in the DOM (search results, old
 * Reddit): each post is identified by its thing id and resolved via the post
 * JSON.
 */
type ApiResolvedPostSource = {
  label: string;
  roots: Element[];
  getThingId: (root: Element) => string | null;
  extractMedia: (root: Element) => Promise<SearchResultMedia | null>;
  /** Title/subreddit for diagnostics; only called when a record is stored. */
  describe?: (root: Element) => { title?: string; subreddit?: string };
};

const scanApiResolvedPosts = async (
  { label, roots, getThingId, extractMedia, describe }: ApiResolvedPostSource,
  skipPostIds: string[] = [],
) => {
  const diagnostics = new DiagnosticsCollector(isDebugEnabled());
  logger.log(`${label} scan: ${roots.length} result roots found`);

  // When force download is on, ignore the history so already-downloaded posts
  // get re-grabbed.
  const forceDownload = await forceDownloadProcessed.getValue();
  const processedIds = await processedPostIds.getValue();
  const processedSet = new Set(forceDownload ? [] : processedIds);
  // Posts that already failed this run, so one failing post can't loop forever.
  const skipSet = new Set(skipPostIds);

  const useDateRangeFilter = await useDateRange.getValue();
  const startDate = useDateRangeFilter
    ? await dateRangeStart.getValue()
    : undefined;
  const endDate = useDateRangeFilter
    ? await dateRangeEnd.getValue()
    : undefined;

  let mediaCount = 0;

  const mediaUrls = compact(
    await Promise.all(
      roots.map(async (root) => {
        // Cheap, fetch-free checks first so we never re-fetch JSON/HLS for posts
        // already downloaded or filtered out (re-fetching invites rate limiting).
        const thingId = getThingId(root);
        if (!thingId) {
          recordSkip(diagnostics, {
            postId: `(unidentified ${label} result)`,
            reason: "no-post-id",
            detail: describeElement(root),
            source: label,
          });
          return null;
        }

        const note = (reason: SkipReason, detail?: string): null => {
          recordSkip(
            diagnostics,
            { postId: thingId, reason, detail, source: label },
            () => ({
              ...describe?.(root),
              permalink: permalinkForPostId(thingId),
            }),
          );
          return null;
        };

        if (processedSet.has(thingId)) return note("already-processed");
        if (skipSet.has(thingId)) return note("failed-earlier-this-run");
        if (unsupportedThingIds.has(thingId)) return note("unsupported-cached");

        if (!isPostInDateRange(root, startDate, endDate)) {
          return note("outside-date-range", getPostDatetime(root) || undefined);
        }

        let media: SearchResultMedia | null;
        try {
          media = await extractMedia(root);
        } catch (error) {
          unsupportedThingIds.add(thingId);
          return note(
            "extract-threw",
            error instanceof Error ? error.message : String(error),
          );
        }

        if (!media) {
          // No downloadable media this session: don't re-fetch it next cycle.
          unsupportedThingIds.add(thingId);
          return note(
            "post-json-no-media",
            "the post JSON yielded no downloadable media (external host, text post with archiving off, or a fetch that failed)",
          );
        }

        // Text posts legitimately carry no URLs — the archive is the payload.
        if (media.type !== "text" && media.urls.length === 0) {
          unsupportedThingIds.add(thingId);
          return note("no-media-urls", `type=${media.type}`);
        }

        // Tag the root so HIGHLIGHT_CURRENT_POST / MARK_POST_VISITED can find it.
        root.setAttribute("data-wxt-media-id", media.mediaPostId);

        mediaCount++;

        return {
          urls: media.urls,
          type: media.type,
          subredditName: media.subredditName,
          mediaPostId: media.mediaPostId,
          postTitle: media.postTitle,
          postAuthor: media.postAuthor ?? getPostAuthor(root),
          postDate: media.postDate ?? getPostDate(root),
        };
      }),
    ),
  );

  logScanSummary(`${label} scan`, roots.length, mediaCount, diagnostics);

  return {
    success: true,
    data: {
      totalPosts: mediaCount,
      mediaUrls,
      skipped: diagnostics.all,
      examined: roots.length,
    },
  };
};

const findVideoPlayer = (element: Element) => {
  let el: Element | null = null;
  for (const selector of Selectors.VIDEO_PLAYER) {
    el = element.querySelector(selector);
    if (el) break;
  }
  return el;
};

export default defineContentScript({
  matches: ["*://*.reddit.com/*"],
  cssInjectionMode: "ui",
  async main(ctx) {
    /**
     * Posts we've already mounted a download button onto.
     *
     * This was a strong `Set`, and Reddit's feed removes post elements as they
     * scroll out of view — so every post ever scrolled past stayed resident
     * along with its shadow root and its mounted React root. Scrolling a few
     * thousand posts retained a few thousand detached DOM subtrees. A WeakSet
     * answers the same has/add questions while letting the element, and
     * everything hanging off it, be collected once Reddit drops it.
     */
    const mountedUIs = new WeakSet<Element>();

    const getMediaContainer = (
      element: Element,
    ): {
      type: MediaContentType;
      element: Element;
    } | null => {
      const hasVideo = findVideoPlayer(element);

      const hasSingleImage = element.querySelector(Selectors.SINGLE_IMAGE);
      const hasMultipleImages = element.querySelector(
        Selectors.GALLERY_CAROUSEL,
      );
      const hasRedGifs = element.querySelector(Selectors.REDGIFS_EMBED);

      if (hasVideo)
        return {
          type: "video",
          element: hasVideo,
        };
      if (hasSingleImage)
        return {
          type: "single-image",
          element: hasSingleImage,
        };
      if (hasMultipleImages) {
        return {
          type: "multiple-images",
          element: hasMultipleImages,
        };
      }
      if (hasRedGifs) {
        return {
          type: "video",
          element: hasRedGifs,
        };
      }

      return null;
    };

    const attachOldRedditButtons = async () => {
      const posts = getOldRedditPosts();

      await Promise.all(
        posts.map(async (post) => {
          if (mountedUIs.has(post) || isOldRedditSelfPost(post)) return;
          const actions = post.querySelector(".flat-list.buttons");
          if (!actions) return;

          const ui = await createShadowRootUi(ctx, {
            name: "media-downloader-button",
            position: "inline",
            anchor: actions,
            append: "last",
            onMount: (container) => {
              const app = document.createElement("li");
              container.className = "inline-block align-middle";
              container.append(app);
              const root = ReactDOM.createRoot(app);
              root.render(<OldRedditDownloadButton post={post} />);
              return root;
            },
            onRemove: (root) => {
              root?.unmount();
            },
          });

          ui.mount();
          mountedUIs.add(post);
        }),
      );
    };

    const attachButtons = async () => {
      if (isOldReddit()) {
        await attachOldRedditButtons();
        return;
      }

      const elements = document.querySelectorAll("shreddit-post");

      await Promise.all(
        Array.from(elements).map(async (element) => {
          if (mountedUIs.has(element)) return;

          const mediaContainer = getMediaContainer(element);

          if (!mediaContainer) return;

          const ui = await createShadowRootUi(ctx, {
            name: "media-downloader-button",
            position: "inline",
            anchor: element,
            append: "last",
            onMount: (container) => {
              const style = document.createElement('style');
              style.textContent = `
                button { margin-top: 0 !important; }
                div { line-height: normal !important; }
                body { height: auto !important; }
              `;
              container.append(style);

              const app = document.createElement("div");
              container.className = cn(
                "ml-auto w-fit bg-transparent float-right",
              );
              container.append(app);
              const root = ReactDOM.createRoot(app);
              root.render(
                <DownloadButton
                  mediaContainer={mediaContainer.element}
                  mediaContentType={mediaContainer.type}
                />,
              );
              return root;
            },
            onRemove: (root) => {
              root?.unmount();
            },
          });

          ui.mount();
          mountedUIs.add(element);
        }),
      );

      logger.log(`Attached buttons to ${elements.length} elements`);
    };

    await attachButtons();
    await refreshDownloadedMarkers();

    // Re-apply downloaded markers live as downloads complete (mass or single)
    // and when the show/hide setting is toggled.
    processedPostIds.watch(() => {
      invalidateProcessedIdCache();
      refreshDownloadedMarkers();
    });
    showDownloadedMarkers.watch(() => {
      refreshDownloadedMarkers();
    });

    let scrollTimeout: ReturnType<typeof setTimeout> | undefined;
    const handleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(async () => {
        logger.log("Scroll detected, reattaching buttons...");
        await attachButtons();
        await refreshDownloadedMarkers();
      }, 150);
    };

    window.addEventListener("scroll", handleScroll, { passive: true });

    // Reddit is a SPA; the content script context is invalidated on navigation.
    // Drop the listener, the pending timer and the caches with it, rather than
    // leaving them attached to a dead context.
    ctx.onInvalidated(() => {
      window.removeEventListener("scroll", handleScroll);
      clearTimeout(scrollTimeout);
      invalidateProcessedIdCache();
      unsupportedThingIds.clear();
    });

    onMessage("GET_CURRENT_POST_ID", async () => {
      const posts = Array.from(document.querySelectorAll("shreddit-post"));
      const viewportCenterY = window.innerHeight / 2;

      for (const post of posts) {
        setPostIdentifier(post);
      }

      // Find the post that contains the vertical center of the viewport
      for (const post of posts) {
        const rect = post.getBoundingClientRect();
        if (rect.top <= viewportCenterY && rect.bottom >= viewportCenterY) {
          return { success: true, postId: getPostIdentifier(post) };
        }
      }

      // Fallback: first post that intersects viewport (smallest top >= 0)
      let best: { post: Element; top: number } | null = null;
      for (const post of posts) {
        const rect = post.getBoundingClientRect();
        if (rect.bottom >= 0 && rect.top <= window.innerHeight) {
          if (!best || rect.top < best.top) best = { post, top: rect.top };
        }
      }
      if (best) {
        return { success: true, postId: getPostIdentifier(best.post) };
      }

      return { success: false };
    });

    onMessage("MARK_POST_VISITED", async ({ data }) => {
      const { mediaPostId } = data;
      const post = document.querySelector(
        `[data-wxt-media-id="${mediaPostId}"]`,
      );
      if (post) {
        markPostAsVisited(post);
        return { success: true };
      }
      return { success: false };
    });

    onMessage("SCAN_PAGE_MEDIA", async ({ data }) => {
      const { scrollUp = false, anchorPostId, skipPostIds = [] } = data ?? {};

      if (isOldReddit()) {
        return scanApiResolvedPosts(
          {
            label: "Old Reddit",
            roots: getOldRedditPosts(),
            getThingId: getOldRedditThingId,
            extractMedia: async (root) =>
              extractOldRedditPostMedia(root, {
                includeTextPosts: await savePostArchive.getValue(),
              }),
            describe: (root) => ({
              title: root.querySelector("a.title")?.textContent?.trim(),
              subreddit: root.getAttribute("data-subreddit") ?? undefined,
            }),
          },
          skipPostIds,
        );
      }

      if (isSearchResultsPage()) {
        return scanApiResolvedPosts(
          {
            label: "Search",
            roots: getSearchResultRoots(),
            getThingId: getSearchThingId,
            extractMedia: extractSearchResultMedia,
            describe: (root) => ({
              title: getSearchPostTitle(root) || undefined,
              subreddit: getSearchSubredditName(root),
            }),
          },
          skipPostIds,
        );
      }

      let postsArray = Array.from(document.querySelectorAll("shreddit-post"));

      // When scroll up with anchor: only consider the anchor post and posts above it (lower index = above)
      if (scrollUp && anchorPostId) {
        let anchorIndex = -1;
        for (let i = 0; i < postsArray.length; i++) {
          setPostIdentifier(postsArray[i]);
          if (getPostIdentifier(postsArray[i]) === anchorPostId) {
            anchorIndex = i;
            break;
          }
        }
        if (anchorIndex >= 0) {
          postsArray = postsArray.slice(0, anchorIndex + 1).toReversed();
          logger.log(
            `Scroll up: limiting to current and above, downloading bottom-to-top (anchor index ${anchorIndex}, ${postsArray.length} posts)`,
          );
        } else {
          logger.warn(
            `Scroll up: anchor post ${anchorPostId} not found, scanning all posts`,
          );
        }
      }

      let mediaCount = 0;
      const diagnostics = new DiagnosticsCollector(isDebugEnabled());

      // Get already processed post IDs from storage. When force download is on,
      // ignore the history so already-downloaded posts get re-grabbed.
      const forceDownload = await forceDownloadProcessed.getValue();
      const processedIds = await processedPostIds.getValue();
      const processedSet = new Set(forceDownload ? [] : processedIds);
      // Posts that already failed this run, so one failing post can't loop forever.
      const skipSet = new Set(skipPostIds);

      const archiveTextPosts = await savePostArchive.getValue();

      // Get date range settings
      const useDateRangeFilter = await useDateRange.getValue();
      const startDate = useDateRangeFilter
        ? await dateRangeStart.getValue()
        : undefined;
      const endDate = useDateRangeFilter
        ? await dateRangeEnd.getValue()
        : undefined;

      const mediaUrls = compact(
        await Promise.all(
          postsArray.map(async (post) => {
            const uniqueId = setPostIdentifier(post);

            const note = (reason: SkipReason, detail?: string): null => {
              recordSkip(
                diagnostics,
                { postId: uniqueId, reason, detail, source: "Feed" },
                () => ({
                  title: getPostTitle(post) || undefined,
                  subreddit: getSubredditNameFromContainer(post),
                  permalink: permalinkForPostId(uniqueId),
                }),
              );
              return null;
            };

            const mediaContainer = getMediaContainer(post);

            // Posts without media are only collected when their text is being
            // archived. The most common silent drop: text posts, crossposts,
            // link posts, polls, and anything whose media element Reddit
            // renamed under us.
            if (!mediaContainer && !archiveTextPosts) {
              return note("no-media-container", describeElement(post));
            }

            // Skip if we've already processed this post
            if (processedSet.has(uniqueId)) return note("already-processed");
            if (skipSet.has(uniqueId)) return note("failed-earlier-this-run");

            // Check if post is within date range
            if (!isPostInDateRange(post, startDate, endDate)) {
              return note(
                "outside-date-range",
                getPostDatetime(post) || undefined,
              );
            }

            const subredditName = getSubredditNameFromContainer(
              mediaContainer?.element.closest("shreddit-post") || post,
            );

            let urls: string[] = [];
            if (mediaContainer) {
              try {
                urls = await getDownloadUrlsFromContainer(
                  mediaContainer.element,
                  mediaContainer.type,
                );
              } catch (error) {
                return note(
                  "extract-threw",
                  error instanceof Error ? error.message : String(error),
                );
              }

              // A media element yielding no URLs used to be forwarded anyway
              // (mediaCount was incremented before the URLs were resolved), and
              // the empty list came back from the background as a success.
              if (urls.length === 0) {
                return note("no-media-urls", `type=${mediaContainer.type}`);
              }
            }

            mediaCount++;

            return {
              urls,
              type: mediaContainer?.type ?? ("text" as const),
              subredditName,
              mediaPostId: uniqueId,
              postTitle: getPostTitle(post),
              postAuthor: getPostAuthor(post),
              postDate: getPostDate(post),
            };
          }),
        ),
      );

      logScanSummary("Feed scan", postsArray.length, mediaCount, diagnostics);

      return {
        success: true,
        data: {
          totalPosts: mediaCount,
          mediaUrls,
          skipped: diagnostics.all,
          examined: postsArray.length,
        },
      };
    });

    onMessage("HIGHLIGHT_CURRENT_POST", async ({ data }) => {
      const { mediaPostId, subredditName, mediaType } = data;

      // Search result rows: the feed-style text indicator renders as broken
      // vertical text. Use a pulsing overlay border + smooth center-scroll to the
      // current row (scrollIntoView is correct for window-scrolled pages).
      if (isSearchResultsPage()) {
        const row = findSearchRowByThingId(mediaPostId);
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
          highlightCard(row);
        }
        return { success: true };
      }

      const currentPost = document.querySelector(
        `[data-wxt-media-id="${mediaPostId}"]`,
      ) as HTMLElement;

      if (currentPost) {
        currentPost.scrollIntoView({
          behavior: "smooth",
          block: "center",
        });

        // Add highlight styling
        const originalStyle = currentPost.style.cssText;
        currentPost.style.cssText += `
          border: 3px solid #3b82f6 !important;
          background-color: rgba(59, 130, 246, 0.1) !important;
          transition: all 0.3s ease !important;
        `;

        // Show a temporary indicator
        const indicator = document.createElement("div");
        indicator.style.cssText = `
          position: absolute;
          top: 10px;
          right: 10px;
          background: #3b82f6;
          color: white;
          padding: 8px 12px;
          border-radius: 6px;
          font-size: 12px;
          font-weight: bold;
          z-index: 9999;
          box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        `;
        indicator.textContent = `Downloading ${mediaType}...`;

        // Position the indicator relative to the post
        currentPost.style.position = "relative";
        currentPost.appendChild(indicator);

        // Remove highlighting and indicator after 2 seconds
        setTimeout(() => {
          currentPost.style.cssText = originalStyle;
          if (indicator.parentNode) {
            indicator.parentNode.removeChild(indicator);
          }
        }, 2000);
      }

      return { success: true };
    });

    // Handle scroll to load more posts
    onMessage("SCROLL_TO_LOAD_MORE", async ({ data }) => {
      const { scrollUp = false } = data ?? {};
      return await scrollAndWaitForMore(scrollUp);
    });

    // Lets the sidebar confirm the content script is live on a freshly
    // navigated page before it starts scanning.
    onMessage("PING", async () => ({
      success: true,
      url: window.location.href,
      posts: countPostRoots(),
      layout: isOldReddit()
        ? ("old-reddit" as const)
        : isSearchResultsPage()
          ? ("search" as const)
          : ("feed" as const),
    }));
  },
});
