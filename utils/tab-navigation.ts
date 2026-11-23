import { logger } from "./logger";
import { logRunNote } from "./run-log";
import { sendToTab } from "./tab-messaging";
import { isSameRedditPage } from "./url-queue";

/**
 * Opening and reloading pages for a run, and waiting until the new page can be
 * scanned.
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Longest to wait for a page the run opened, or reloaded, to answer. Counts
 * from the navigation, so it covers loading and the content script starting.
 */
const PAGE_READY_TIMEOUT_MS = 90_000;

/** The PING answer of whatever page is in the tab now, or null. */
const pingTab = async (tabId: number) => {
  try {
    const pong = await sendToTab("PING", undefined, `content-script@${tabId}`);
    return pong?.success ? pong : null;
  } catch {
    return null;
  }
};

/**
 * Wait until the page in the tab can be scanned: its own content script
 * answers, it is a different page load from `notInstance`, and (when given) it
 * is on `targetUrl`.
 *
 * This used to wait for the tab to report status "complete" first, which only
 * comes once every image and video on the page has loaded. Reddit feeds can go
 * on loading media for a long time, and on 21 Nov every page after the first
 * failed with "did not finish loading within 45s". Asking the page itself
 * means waiting only for what the scan needs. The page-load id also rules out
 * the old page answering for the new one.
 */
export const waitForPage = async (
  tabId: number,
  { targetUrl, notInstance }: { targetUrl?: string; notInstance?: string },
) => {
  const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
  let lastSeen = "nothing answered";
  while (Date.now() < deadline) {
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab) throw new Error("the tab was closed");
    const pong = await pingTab(tabId);
    if (pong) {
      lastSeen = `the page answered from ${pong.url}`;
      const fresh = !notInstance || pong.instance !== notInstance;
      const there = !targetUrl || isSameRedditPage(pong.url, targetUrl);
      if (fresh && there) return pong;
      if (fresh && !there && tab.status === "complete") {
        // Reddit sent us somewhere else (a renamed, banned or private
        // subreddit, a login wall). Scan what's there and say so.
        logger.warn(`Expected ${targetUrl} but landed on ${pong.url}`);
        void logRunNote(`Asked for ${targetUrl} but Reddit showed ${pong.url}`);
        return pong;
      }
    } else if (tab.discarded) {
      lastSeen = "the tab is unloaded (Firefox discarded it to save memory)";
    } else {
      lastSeen = `the tab is ${tab.status ?? "loading"} with no RedditGrab content script answering yet`;
    }
    await sleep(500);
  }
  throw new Error(
    `the page wasn't ready within ${PAGE_READY_TIMEOUT_MS / 1000}s: ${lastSeen}`,
  );
};

/**
 * Point the tab at a queued URL and wait until it is ready to be scanned.
 * Skips the navigation when the tab is already on that page, so starting a
 * queue whose first entry is the current page doesn't pointlessly reload it.
 */
export const navigateTab = async (tabId: number, url: string) => {
  let current: Browser.tabs.Tab | undefined;
  try {
    current = await browser.tabs.get(tabId);
  } catch {
    throw new Error("the tab was closed");
  }

  if (current?.url && isSameRedditPage(current.url, url)) {
    logger.log(`Already on ${url}, not reloading`);
    await waitForPage(tabId, { targetUrl: url });
    return;
  }

  const before = await pingTab(tabId);
  await browser.tabs.update(tabId, { url });
  const pong = await waitForPage(tabId, {
    targetUrl: url,
    notInstance: before?.instance,
  });
  logger.log(
    `Opened ${pong.url} (${pong.layout} layout, ${pong.posts} posts on screen)`,
  );
};

/** Reload the tab in place and wait until the fresh page can be scanned. */
export const reloadTab = async (tabId: number) => {
  const before = await pingTab(tabId);
  await browser.tabs.reload(tabId);
  const pong = await waitForPage(tabId, { notInstance: before?.instance ?? "none" });
  logger.log(`Reloaded ${pong.url} (${pong.posts} posts on screen)`);
};

