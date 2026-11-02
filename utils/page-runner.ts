/**
 * The loop that works a single page until it has nothing left.
 *
 * This lives outside the sidebar component so it can be tested directly: it is
 * the part of a mass download most likely to go subtly wrong (scrolling at the
 * bottom of a finished listing forever, or giving up while Reddit is still
 * loading), and those failures are invisible until someone watches a long run.
 *
 * Everything it touches is injected, so a test drives it with scripted scan and
 * scroll results instead of a browser.
 */

export type PageRunOutcome = "exhausted" | "stopped";

export type PageRunnerDeps = {
  /** Scan the page and download what was found. Returns posts queued. */
  processBatch: () => Promise<{ queued: number }>;
  /** Scroll for more content. `grew` is whether anything actually loaded. */
  scrollForMore: () => Promise<{ grew: boolean }>;
  /** False once the user has asked to stop. */
  shouldContinue: () => boolean;
  sleep: (ms: number) => Promise<unknown>;
  log?: (message: string) => void;
  /**
   * Scroll-up mode works backwards from the current post, so the first scan
   * that finds nothing means the top has been reached — there is nothing
   * further to load.
   */
  scrollUp?: boolean;
  /**
   * How many consecutive scrolls may load nothing before the page is treated as
   * finished. Reddit's infinite scroll is intermittent, so one quiet scroll
   * near the end of a listing is normal and not proof of anything.
   */
  emptyScrollsBeforeDone?: number;
  /** Pause after a batch that found posts, letting more render. */
  foundDelayMs?: number;
  /** Pause after a scroll, letting the fetch settle. */
  scrollDelayMs?: number;
  /**
   * Stay on the page once the listing is exhausted, re-checking periodically
   * for posts that appear later, until the user stops the run.
   *
   * This is the long-running watch a single-page download is often used for:
   * leave it on a subreddit and it picks up new posts as they arrive. A queue
   * cannot do this — it has to move on — so it always leaves this off.
   */
  keepWatching?: boolean;
  /** How long to wait between checks while watching an exhausted page. */
  watchIntervalMs?: number;
};

export const runPageUntilExhausted = async ({
  processBatch,
  scrollForMore,
  shouldContinue,
  sleep,
  log = () => {},
  scrollUp = false,
  emptyScrollsBeforeDone = 3,
  foundDelayMs = 2000,
  scrollDelayMs = 1500,
  keepWatching = false,
  watchIntervalMs = 60_000,
}: PageRunnerDeps): Promise<PageRunOutcome> => {
  let emptyScrolls = 0;

  /**
   * The listing has nothing further. Either that ends the page, or — when
   * watching — we idle and start looking again.
   */
  const exhausted = async (note: string): Promise<PageRunOutcome | null> => {
    log(note);
    if (!keepWatching) return "exhausted";
    log(
      `Watching for new posts; checking again in ${Math.round(watchIntervalMs / 1000)}s.`,
    );
    await sleep(watchIntervalMs);
    emptyScrolls = 0;
    return shouldContinue() ? null : "stopped";
  };

  while (shouldContinue()) {
    const { queued } = await processBatch();
    if (!shouldContinue()) return "stopped";

    if (queued > 0) {
      // Found posts; look again shortly in case more have rendered.
      emptyScrolls = 0;
      await sleep(foundDelayMs);
      continue;
    }

    if (scrollUp) {
      const done = await exhausted("Reached the top of the page.");
      if (done) return done;
      continue;
    }

    log("No new posts found, scrolling to load more...");
    let grew = false;
    try {
      const scroll = await scrollForMore();
      grew = scroll?.grew === true;
    } catch (error) {
      // A failed scroll is not evidence the page is finished, but it must still
      // count towards the limit or a broken content script loops forever.
      log(`Scroll request failed: ${String(error)}`);
    }

    if (grew) {
      emptyScrolls = 0;
    } else {
      emptyScrolls += 1;
      if (emptyScrolls >= emptyScrollsBeforeDone) {
        const done = await exhausted(
          `No further posts after ${emptyScrolls} scroll attempts; page is done.`,
        );
        if (done) return done;
        continue;
      }
    }

    if (!shouldContinue()) return "stopped";
    await sleep(scrollDelayMs);
  }

  return "stopped";
};
