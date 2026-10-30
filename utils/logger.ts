import { debugLogging } from "./storage";

const isDevelopment = import.meta.env.DEV;

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

export const logger = {
  log: (...args: unknown[]) => {
    if (isDebugEnabled()) console.log(PREFIX, ...args);
  },

  warn: (...args: unknown[]) => {
    if (isDebugEnabled()) console.warn(PREFIX, ...args);
  },

  /**
   * Errors are ALWAYS logged, debug mode or not. A swallowed error is how a
   * failed download turns into a silently missing file.
   */
  error: (...args: unknown[]) => {
    console.error(PREFIX, ...args);
  },

  /** Logged regardless of debug mode — run summaries and other must-see lines. */
  always: (...args: unknown[]) => {
    console.log(PREFIX, ...args);
  },
};
