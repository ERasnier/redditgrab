import { debugLogging } from "./storage";

// Kept as a literal `import.meta.env.DEV` so Vite still substitutes it at
// build time; the guard is for every other context (unit tests, plain node),
// where `import.meta.env` doesn't exist and the bare read throws.
const isDevelopment = (() => {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
})();

/**
 * Runtime debug switch.
 *
 * The logger used to be compiled out of production builds entirely
 * (`import.meta.env.DEV`), so an installed extension produced no diagnostics at
 * all — precisely the situation where you need them. Logging is on whenever
 * either the build is a dev build or the user has turned on the "Debug logging"
 * setting, so a signed or self-hosted build can be made to talk.
 */
let runtimeDebug = false;

/** Resolves once the stored setting has been read, so early logs aren't lost. */
export const debugReady: Promise<void> = (async () => {
  try {
    runtimeDebug = await debugLogging.getValue();
    debugLogging.watch((value) => {
      runtimeDebug = value === true;
    });
  } catch {
    // Storage isn't reachable from this context; fall back to the build flag.
  }
})();

export const isDebugEnabled = () => isDevelopment || runtimeDebug;

const PREFIX = "[RedditGrab]";

/** Longest a single logged value may be once turned into text. */
const MAX_ARG_LENGTH = 2000;

const clip = (text: string) =>
  text.length > MAX_ARG_LENGTH
    ? `${text.slice(0, MAX_ARG_LENGTH)}… (${text.length - MAX_ARG_LENGTH} more chars)`
    : text;

const describeElement = (el: Element) => {
  const id = el.id ? `#${el.id}` : "";
  const thing =
    el.getAttribute("id") || el.getAttribute("data-fullname") || "";
  return `<${el.tagName.toLowerCase()}${id}${thing && !id ? ` ${thing}` : ""}>`;
};

/**
 * Turn a log argument into plain text.
 *
 * Firefox keeps every console message for the life of the page it was logged
 * from, along with the live objects passed to it, so devtools can show them if
 * opened later. The background page lives all session and a Reddit tab can sit
 * through a run of many hours, so every DOM element, download request and scan
 * response handed to console.log stayed reachable until the tab closed. Logging
 * text keeps the message without keeping the object.
 */
const toText = (value: unknown): string => {
  if (typeof value === "string") return clip(value);
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  if (value instanceof Error) {
    return clip(value.stack ? `${value.message}\n${value.stack}` : value.message);
  }
  if (typeof Element !== "undefined" && value instanceof Element) {
    return describeElement(value);
  }
  try {
    return clip(
      JSON.stringify(value, (_key, inner) =>
        typeof Element !== "undefined" && inner instanceof Element
          ? describeElement(inner)
          : inner,
      ),
    );
  } catch {
    return Object.prototype.toString.call(value);
  }
};

const emit = (
  write: (...args: unknown[]) => void,
  args: unknown[],
) => write(PREFIX, ...args.map(toText));

export const logger = {
  log: (...args: unknown[]) => {
    if (isDebugEnabled()) emit(console.log, args);
  },

  warn: (...args: unknown[]) => {
    if (isDebugEnabled()) emit(console.warn, args);
  },

  /**
   * Errors are ALWAYS logged, debug mode or not. A swallowed error is how a
   * failed download turns into a silently missing file.
   */
  error: (...args: unknown[]) => {
    emit(console.error, args);
  },

  /** Logged regardless of debug mode — run summaries and other must-see lines. */
  always: (...args: unknown[]) => {
    emit(console.log, args);
  },
};
