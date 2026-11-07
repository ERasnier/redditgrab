/**
 * Removing finished posts from the Reddit page during a mass download.
 *
 * Reddit's feed never unloads anything: every post scrolled past stays in the
 * document with its video player, its images and the download button mounted on
 * it. Over a long run that was thousands of posts, and the tab grew until
 * Firefox — and then the rest of the machine — slowed to a crawl. Once a post's
 * outcome is settled and it is well out of sight above the screen, nothing needs
 * it any more, so it is taken out.
 *
 * Media is stopped and detached before removal rather than left to the garbage
 * collector. If any of Reddit's own scripts still hold a reference to the
 * removed element, the element survives — but its decoded video and image data
 * do not.
 */

/** Firefox content scripts see closed shadow roots through this. */
type MaybeShadowHost = Element & { openOrClosedShadowRoot?: ShadowRoot | null };

const shadowOf = (el: Element): ShadowRoot | null => {
  const host = el as MaybeShadowHost;
  try {
    return host.openOrClosedShadowRoot ?? host.shadowRoot ?? null;
  } catch {
    return el.shadowRoot ?? null;
  }
};

/**
 * Every element under `root`, descending into shadow roots. Reddit's video
 * player keeps its <video> inside one, where querySelectorAll can't see it.
 */
export const collectDeep = (root: Element, selector: string): Element[] => {
  const found: Element[] = [];
  const visit = (scope: Element | ShadowRoot) => {
    for (const el of Array.from(scope.querySelectorAll("*"))) {
      if (el.matches(selector)) found.push(el);
      const shadow = shadowOf(el);
      if (shadow) visit(shadow);
    }
  };
  if (root.matches(selector)) found.push(root);
  const rootShadow = shadowOf(root);
  if (rootShadow) visit(rootShadow);
  visit(root);
  return found;
};

/** Stop and detach every video and image under `root`. Returns how many. */
export const releaseMedia = (root: Element): number => {
  let released = 0;
  for (const el of collectDeep(root, "video, audio")) {
    const media = el as HTMLMediaElement;
    try {
      media.pause();
      media.removeAttribute("src");
      for (const source of Array.from(media.querySelectorAll("source"))) {
        source.removeAttribute("src");
      }
      // load() with no source drops the decoder and any buffered data.
      media.load();
      released += 1;
    } catch {}
  }
  for (const el of collectDeep(root, "img")) {
    try {
      el.removeAttribute("srcset");
      el.removeAttribute("src");
      released += 1;
    } catch {}
  }
  return released;
};

export type PruneOptions = {
  /**
   * How far above the top of the screen a post must have ended before it may
   * go, in screen heights. Keeps posts the user can scroll back to a little,
   * and keeps well clear of anything Reddit is still laying out.
   */
  marginScreens?: number;
  /** Called first, e.g. to unmount the download button on the post. */
  beforeRemove?: (post: Element) => void;
};

/** The element to take out for a post: its <article> wrapper when there is one. */
const removalTarget = (post: Element): Element =>
  post.parentElement?.tagName === "ARTICLE" ? post.parentElement : post;

/**
 * Remove the given posts if they are far enough above the screen.
 * Returns how many were removed.
 *
 * Removing content above the viewport would normally make the page jump, but
 * Firefox's scroll anchoring holds the visible content in place, which is also
 * what keeps Reddit's load-more trigger where it was.
 */
export const pruneFinishedPosts = (
  posts: Iterable<Element>,
  { marginScreens = 2, beforeRemove }: PruneOptions = {},
): number => {
  const limit = -window.innerHeight * marginScreens;
  let removed = 0;
  for (const post of posts) {
    if (!post.isConnected) continue;
    const rect = post.getBoundingClientRect();
    // Unrendered or hidden posts have an empty rect; leave them alone.
    if (rect.height === 0 || rect.bottom > limit) continue;

    removePost(post, beforeRemove);
    removed += 1;
  }
  return removed;
};

/**
 * Take one post off the page now, wherever it is: stop its media, run
 * `beforeRemove` (to unmount its download button), and remove it.
 *
 * Used the moment a post's download finishes, so its video and images are
 * released per post rather than whenever a later scan gets round to it.
 */
export const removePost = (
  post: Element,
  beforeRemove?: (post: Element) => void,
) => {
  if (!post.isConnected) return;
  try {
    beforeRemove?.(post);
  } catch {}
  releaseMedia(post);

  const target = removalTarget(post);
  // Reddit separates posts with <hr>; drop the one that belonged to this post
  // so the feed doesn't fill with empty dividers.
  const next = target.nextElementSibling;
  if (next?.tagName === "HR") next.remove();
  target.remove();
};
