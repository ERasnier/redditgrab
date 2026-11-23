import type { sendMessage as bridgeSendMessage } from "webext-bridge/popup";

/**
 * Messages between the sidebar, the background page and the content script,
 * over Firefox's own runtime.sendMessage / tabs.sendMessage.
 *
 * These used to go through webext-bridge, which carries messages over ports it
 * routes itself. It lost them. Run logs from 23 Nov show it both ways:
 *
 * - Sidebar to page: the page's content script answered Firefox's own
 *   messaging at once, yet never received the bridge's PING, page after page.
 * - Background to sidebar: posts the background finished downloading within
 *   seconds (the history database has the times) never got their reply to the
 *   sidebar, which waited the full 20 minutes, marked them failed, and so
 *   would have downloaded them again.
 *
 * It also parked messages to an endpoint that wasn't connected, for good,
 * which leaked. Firefox's messaging needs no connection set up, reaches the
 * current document, and fails at once when nothing is listening; every call
 * here also has a time limit.
 *
 * The functions keep webext-bridge's shapes — sendMessage(name, data,
 * destination) and onMessage(name, ({ data }) => …) — so call sites read the
 * same.
 */

/** Sent through browser.tabs.sendMessage; the content script answers true. */
export const ALIVE_MESSAGE = "redditgrab:alive";
/** A call to one of the content script's handlers: { type, name, data }. */
export const CALL_MESSAGE = "redditgrab:call";
/** A call to one of the background page's handlers: { type, name, data }. */
export const BACKGROUND_MESSAGE = "redditgrab:background";

export class TabUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TabUnreachableError";
  }
}

/** How long each message may take before it counts as unanswered. */
const TIMEOUTS_MS: Record<string, number> = {
  // Page
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
  // Background. The sidebar puts its own, shorter limit on a run's downloads
  // so it can say which post; this one covers the download buttons.
  DOWNLOAD_REQUEST: 25 * 60_000,
  GET_MEMORY_STATS: 5_000,
  HISTORY_STATUS: 10_000,
  HISTORY_WRITE: 5 * 60_000,
  HISTORY_CLEAR: 5 * 60_000,
};
const DEFAULT_TIMEOUT_MS = 60_000;

const NO_RECEIVER =
  /Receiving end does not exist|Could not establish connection|No tab with id|Invalid tab/i;

const withLimit = async <T>(name: string, promise: Promise<T>): Promise<T> => {
  const limit = TIMEOUTS_MS[name] ?? DEFAULT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new TabUnreachableError(
                `no answer to ${name} within ${Math.round(limit / 1000)}s`,
              ),
            ),
          limit,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/** True if the tab has a live RedditGrab content script. Never hangs. */
export const isContentScriptAlive = async (tabId: number) => {
  try {
    return (
      (await browser.tabs.sendMessage(tabId, { type: ALIVE_MESSAGE }, { frameId: 0 })) === true
    );
  } catch {
    return false;
  }
};

const tabIdOf = (destination: unknown) => {
  const match = typeof destination === "string" && destination.match(/^content-script@(\d+)$/);
  return match ? Number(match[1]) : null;
};

/**
 * Send to "background" or "content-script@<tabId>". Fails at once when nothing
 * is listening, and after a time limit that suits the message.
 */
export const sendMessage = (async (name: string, data: unknown, destination: unknown) => {
  const tabId = tabIdOf(destination);
  if (tabId !== null) {
    return withLimit(
      name,
      browser.tabs
        .sendMessage(tabId, { type: CALL_MESSAGE, name, data }, { frameId: 0 })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (NO_RECEIVER.test(message)) {
            throw new TabUnreachableError(
              `the page isn't answering (${name}): it has no RedditGrab content script — it may still be loading, or have been unloaded, reloaded or closed`,
            );
          }
          throw error;
        }),
    );
  }
  if (destination === "background") {
    return withLimit(
      name,
      browser.runtime.sendMessage({ type: BACKGROUND_MESSAGE, name, data }).catch(
        (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          if (NO_RECEIVER.test(message)) {
            throw new TabUnreachableError(
              `the background page isn't answering (${name}); reloading the extension restarts it`,
            );
          }
          throw error;
        },
      ),
    );
  }
  throw new Error(`unknown message destination ${String(destination)}`);
}) as typeof bridgeSendMessage;

/** Kept for the call sites that name it; the same function. */
export const sendToTab = sendMessage;

type Handler = (message: { data: any }) => unknown;
const handlers = new Map<string, Handler>();

/** Register a handler, as with webext-bridge's onMessage. */
export const onMessage = (name: string, handler: Handler) => {
  handlers.set(name, handler);
};

/** Run a registered handler for an incoming call, or say it isn't there. */
export const dispatch = (name: string, data: unknown) => {
  const handler = handlers.get(name);
  if (!handler) return Promise.reject(new Error(`not ready for ${name} yet`));
  return Promise.resolve().then(() => handler({ data }));
};

/**
 * In the background page: answer the sidebar's and the download buttons'
 * calls. Anything not ours is left for other listeners.
 */
export const listenForBackgroundCalls = () => {
  const listener = (message: unknown) => {
    const call = message as { type?: string; name?: string; data?: unknown } | null;
    if (call?.type !== BACKGROUND_MESSAGE || typeof call.name !== "string") return undefined;
    return dispatch(call.name, call.data);
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
};
