/**
 * Parsing for the mass-download URL queue.
 *
 * The user pastes a list of places to download from, one per line. People write
 * those in every shape — a full URL copied from the address bar, `r/pics`,
 * `/r/pics/top/?t=all`, `u/someone`, or just a bare subreddit name — so each
 * line is normalised to a URL the extension can navigate to, and anything that
 * can't be is reported back with its line number rather than silently dropped.
 */

/** Reddit hosts we accept. The host is preserved, not rewritten: old.reddit.com
 * and www.reddit.com render differently and the scanner has a separate path for
 * each, so a user who queues an old.reddit URL gets the old layout. */
const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "new.reddit.com",
  "np.reddit.com",
  "sh.reddit.com",
  "i.reddit.com",
  "m.reddit.com",
]);

/** Subreddit and username rules, per Reddit: 3–21 chars, alphanumerics plus _ and -. */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,20}$/;

export type QueueEntry = {
  /** The navigable URL. */
  url: string;
  /** Short label for the UI, e.g. "r/pics" or "r/pics · top". */
  label: string;
};

export type ParsedQueue = {
  entries: QueueEntry[];
  /** Lines that could not be understood, with 1-based line numbers. */
  errors: { line: number; text: string; reason: string }[];
  /** Count of duplicates that were collapsed. */
  duplicates: number;
};

const stripWrappers = (raw: string): string => {
  let text = raw.trim();
  // Tolerate list formatting people paste in: bullets, numbering, trailing
  // commas, surrounding quotes or angle brackets.
  text = text.replace(/^[-*•]\s+/, "");
  text = text.replace(/^\d+[.)]\s+/, "");
  text = text.replace(/[,;]+$/, "");
  text = text.replace(/^["'<]+/, "").replace(/["'>]+$/, "");
  return text.trim();
};

/** Human-readable label for a normalised Reddit URL. */
export const labelForUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const host = parsed.hostname === "old.reddit.com" ? " (old)" : "";

    // Post permalinks first, since a full one is also an /r/<sub>/… path.
    // These turn up when a diagnostics report's retry list is pasted back in.
    if (segments[0] === "comments" && segments[1]) {
      return `post ${segments[1]}${host}`;
    }
    if (segments[0] === "r" && segments[2] === "comments" && segments[3]) {
      return `post ${segments[3]} in r/${segments[1]}${host}`;
    }
    if (segments[0] === "r" && segments[1]) {
      const sort = segments[2] ? ` · ${segments[2]}` : "";
      return `r/${segments[1]}${sort}${host}`;
    }
    if ((segments[0] === "user" || segments[0] === "u") && segments[1]) {
      return `u/${segments[1]}${host}`;
    }
    if (segments[0] === "search" || parsed.searchParams.has("q")) {
      const query = parsed.searchParams.get("q");
      return query ? `search: ${query}${host}` : `search${host}`;
    }
    if (segments.length === 0) return `front page${host}`;
    return `${parsed.pathname}${host}`;
  } catch {
    return url;
  }
};

/**
 * Turn one line into a navigable Reddit URL, or null with a reason.
 *
 * Accepts: full http(s) Reddit URLs (path and query preserved), `r/name`,
 * `/r/name/top/?t=all`, `u/name`, `user/name`, and a bare subreddit name.
 */
export const normalizeRedditUrl = (
  raw: string,
): { url: string } | { error: string } => {
  const text = stripWrappers(raw);
  if (!text) return { error: "empty" };

  // Full URL, or something URL-shaped with the scheme left off.
  const hasScheme = /^https?:\/\//i.test(text);
  const looksLikeHost = /^(?:[a-z0-9-]+\.)*reddit\.com(?:[/?#]|$)/i.test(text);

  if (hasScheme || looksLikeHost) {
    let parsed: URL;
    try {
      parsed = new URL(hasScheme ? text : `https://${text}`);
    } catch {
      return { error: "not a valid URL" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { error: `unsupported scheme "${parsed.protocol}"` };
    }
    if (!REDDIT_HOSTS.has(parsed.hostname.toLowerCase())) {
      return { error: `not a Reddit URL (${parsed.hostname})` };
    }
    // Always https; reddit.com without www redirects anyway, so normalise it
    // to avoid a needless hop mid-run.
    parsed.protocol = "https:";
    if (parsed.hostname.toLowerCase() === "reddit.com") {
      parsed.hostname = "www.reddit.com";
    }
    parsed.hash = "";
    return { url: parsed.toString() };
  }

  // Bare shorthand: r/name, /r/name/top, u/name, user/name, or just a name.
  const shorthand = text.replace(/^\/+/, "");
  const prefixed = shorthand.match(/^(r|u|user)\/(.+)$/i);

  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    const rest = prefixed[2];
    const nameRaw = rest.split("/")[0];
    const [name] = nameRaw.split("?");
    if (!NAME_RE.test(name)) {
      return { error: `"${name}" is not a valid ${kind === "r" ? "subreddit" : "user"} name` };
    }
    // Keep anything after the name (a sort, a query) exactly as written.
    const suffix = rest.slice(nameRaw.length).replace(/^\/+/, "");
    const query = nameRaw.includes("?") ? nameRaw.slice(nameRaw.indexOf("?")) : "";

    if (kind === "r") {
      const path = suffix ? `r/${name}/${suffix}` : `r/${name}/`;
      return { url: `https://www.reddit.com/${path}${query}` };
    }
    // A user's media lives on their submitted-posts page; the overview mixes in
    // comments, which have nothing to download.
    const path = suffix ? `user/${name}/${suffix}` : `user/${name}/submitted/`;
    return { url: `https://www.reddit.com/${path}${query}` };
  }

  if (NAME_RE.test(shorthand)) {
    return { url: `https://www.reddit.com/r/${shorthand}/` };
  }

  return { error: "not a Reddit URL or r/subreddit" };
};

/**
 * Parse the whole textarea. Blank lines and `#` comments are ignored, duplicate
 * URLs are collapsed keeping the first occurrence, and order is preserved.
 */
export const parseUrlQueue = (text: string): ParsedQueue => {
  const entries: QueueEntry[] = [];
  const errors: ParsedQueue["errors"] = [];
  const seen = new Set<string>();
  let duplicates = 0;

  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;

    const result = normalizeRedditUrl(trimmed);
    if ("error" in result) {
      errors.push({ line: index + 1, text: trimmed, reason: result.error });
      return;
    }
    if (seen.has(result.url)) {
      duplicates += 1;
      return;
    }
    seen.add(result.url);
    entries.push({ url: result.url, label: labelForUrl(result.url) });
  });

  return { entries, errors, duplicates };
};

/**
 * True when two URLs point at the same Reddit page, ignoring trailing-slash and
 * www/old host differences. Used to skip a navigation when the tab is already
 * on the right page.
 */
export const isSameRedditPage = (a: string, b: string): boolean => {
  try {
    const left = new URL(a);
    const right = new URL(b);
    if (left.hostname.toLowerCase() !== right.hostname.toLowerCase()) {
      return false;
    }
    const path = (url: URL) => url.pathname.replace(/\/+$/, "").toLowerCase();
    return path(left) === path(right) && left.search === right.search;
  } catch {
    return false;
  }
};
