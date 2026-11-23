import { sendMessage } from "webext-bridge/popup";

/**
 * Messages from the sidebar to the content script on a Reddit tab, with a way
 * out when nothing answers.
 *
 * webext-bridge, which carries these messages, never fails a message whose
 * receiver isn't there: it parks it — on the sending side, and as a callback
 * in the background page — until that tab's content script connects, which
 * may be never. Two things followed:
 *
 * - The memory panel asked the Reddit tab for its stats every 3 seconds. On a
 *   Reddit tab without the content script (open since before the extension
 *   was reloaded, say) each request was parked and none was ever released:
 *   a leak in both the sidebar and the background, 1,200 an hour.
 * - A run whose tab lost its content script — Firefox unloading the tab to
 *   save memory, Reddit reloading itself — waited on its next message for
 *   ever: no error, no retry, nothing in the log.
 *
 * So every message first checks, through Firefox's own messaging (which fails
 * at once when there's no receiver), that the content script is there, and
 * then gives up after a time limit that suits the message.
 */

/** Sent through browser.tabs.sendMessage; the content script answers true. */
export const ALIVE_MESSAGE = "redditgrab:alive";

export class TabUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabUnreachableError";
  }
}

/** How long each message may take before it counts as unanswered. */
const TIMEOUTS_MS: Record<string, number> = {
  PING: 5_000,
  GET_PAGE_STATS: 5_000,
  RELEASE_POST: 15_000,
  MARK_POST_VISITED: 15_000,
  HIGHLIGHT_CURRENT_POST: 20_000,
  GET_CURRENT_POST_ID: 20_000,
  SCROLL_TO_LOAD_MORE: 60_000,
  // A scan resolves media for every new post on the page, which can mean
  // many API lookups.
  SCAN_PAGE_MEDIA: 180_000,
};
const DEFAULT_TIMEOUT_MS = 60_000;

/** True if the tab has a live RedditGrab content script. Never hangs. */
export const isContentScriptAlive = async (tabId: number) => {
  try {
    return (await browser.tabs.sendMessage(tabId, { type: ALIVE_MESSAGE })) === true;
  } catch {
    // "Receiving end does not exist", a closed tab, a discarded tab.
    return false;
  }
};

const tabIdOf = (destination: unknown) => {
  const match = typeof destination === "string" && destination.match(/^content-script@(\d+)$/);
  return match ? Number(match[1]) : null;
};

/**
 * sendMessage for content-script destinations: same arguments, but it fails
 * straight away when the tab has no content script, and fails after a time
 * limit instead of waiting for ever.
 */
export const sendToTab = (async (messageID: string, data: unknown, destination: unknown) => {
  const tabId = tabIdOf(destination);
  if (tabId === null) {
    return (sendMessage as (...args: unknown[]) => Promise<unknown>)(messageID, data, destination);
  }
  if (!(await isContentScriptAlive(tabId))) {
    throw new TabUnreachableError(
      `the page isn't answering (${messageID}): it has no RedditGrab content script — it may have been unloaded, reloaded, closed, or opened before the extension was reloaded`,
    );
  }
  const limit = TIMEOUTS_MS[messageID] ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (sendMessage as (...args: unknown[]) => Promise<unknown>)(messageID, data, destination),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TabUnreachableError(
                `the page didn't answer ${messageID} within ${Math.round(limit / 1000)}s`,
              ),
            ),
          limit,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}) as typeof sendMessage;
