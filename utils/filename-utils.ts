import filenamify from "filenamify/browser";

export interface FilenameData {
  subreddit: string;
  timestamp: string;
  filename: string;
  extension: string;
  title?: string;
  user?: string;
}

/**
 * Strip filesystem-unsafe characters from a string so it's safe to use as a filename
 */
export function sanitizeForFilename(
  raw: string | undefined | null,
  maxLength = 80,
): string {
  if (!raw) return "";

  // filenamify's own maxLength preserves what it takes to be the extension,
  // and it treats everything after the final dot as one. A title containing a
  // dot therefore came back as just that tail — "there's no cute way to say
  // this... i have an obscene amount…" became ". i have an obscene amount…":
  // 99 characters despite a limit of 80, missing its first half, and starting
  // with a dot. Use filenamify for character sanitising only and bound the
  // length here, where there is no extension to misread.
  let cleaned = filenamify(raw, { maxLength: 10_000, replacement: " " })
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length > maxLength) {
    cleaned = cleaned.slice(0, maxLength);
    // Prefer not to end mid-word, but only if that keeps most of the text.
    const lastSpace = cleaned.lastIndexOf(" ");
    if (lastSpace > maxLength * 0.6) cleaned = cleaned.slice(0, lastSpace);
  }

  // A leading dot makes a hidden file, and Firefox's own path check strips
  // leading dots and spaces — so a segment that has them differs from what it
  // would sanitise to, and it rejects the whole download with "filename must
  // not contain illegal characters".
  return cleaned.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
}

export function generateFilename(pattern: string, data: FilenameData): string {
  const safeTitle = sanitizeForFilename(data.title) || "untitled";
  const safeUser = sanitizeForFilename(data.user) || "unknown-user";
  return (
    pattern
      .replace(/{subreddit}/g, data.subreddit)
      .replace(/{user}/g, safeUser)
      .replace(/{timestamp}/g, data.timestamp)
      .replace(/{title}/g, safeTitle)
      .replace(/{filename}/g, data.filename) +
    "." +
    data.extension
  );
}

/**
 * Sanitize a full download path for browser.downloads.download, which throws
 * "filename must not contain illegal characters" otherwise. The browser's rule
 * (base::i18n::IsFilenameLegal) bans the reserved punctuation plus every Unicode
 * control (\p{Cc}) and format (\p{Cf}) character. The latter is what breaks
 * "complex" emoji: a ZWJ sequence like 🤷‍♀️ contains a zero-width joiner
 * (U+200D, category Cf). We strip those (and bidi marks, zero-width spaces, BOM)
 * but keep the visible emoji glyphs, which are legal. Cleans each "/" segment,
 * keeps the separators, collapses whitespace, and drops leading and trailing
 * dots/spaces — Firefox strips both, and a segment that still has them does
 * not match what it would sanitise to, so it refuses the download.
 */
export function sanitizeDownloadPath(path: string): string {
  const segments = path
    .split("/")
    .map((segment) =>
      segment
        .replace(/[<>:"|?*\\\p{Cc}\p{Cf}]/gu, "")
        .replace(/\s+/g, " ")
        .replace(/^[ .]+/, "")
        .replace(/[ .]+$/, "")
        .trim(),
    )
    .filter((segment) => segment.length > 0);
  return segments.join("/");
}

export function extractFilenameFromUrl(url: string): string {
  const urlPath = new URL(url).pathname;
  const lastPart = urlPath.split("/").pop()?.split(".")[0] || "file";
  return lastPart;
}

export function getCurrentTimestamp(): string {
  const now = new Date();
  return now.toISOString().slice(0, 19).replace(/[T:]/g, "-");
}
