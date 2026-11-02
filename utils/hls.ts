/**
 * HLS playlist parsing (RFC 8216).
 *
 * The previous RedGIFs parser recognised a segment only when a line beginning
 * `#EXT-X-BYTERANGE:` was followed immediately by a line starting `https://`.
 * That is one narrow shape out of several the spec allows, and it rejects:
 *
 *   - relative segment URIs, which are the common case
 *   - segment lists with no byte ranges at all
 *   - master playlists, where the segments live one level down
 *   - `#EXT-X-MAP` without a BYTERANGE attribute
 *   - byte ranges with an implied offset, which continue the previous one
 *
 * Any of those produced zero segments, so every RedGIFs video failed — first
 * as an opaque `ErrnoError: FS error` from ffmpeg being handed an empty file,
 * and then, once that was reported properly, as "playlist yielded no video
 * data". This parser handles the shapes the spec actually permits.
 */

export type HlsByteRange = {
  length: number;
  /** Absent means "continues from the end of the previous range". */
  offset?: number;
};

export type HlsSegment = {
  /** Absolute URL, resolved against the playlist's own URL. */
  uri: string;
  byteRange?: HlsByteRange;
};

export type HlsVariant = {
  uri: string;
  bandwidth: number;
  /** Frame height, when RESOLUTION says. Used to pick the best stream. */
  height?: number;
};

export type HlsPlaylist =
  | { kind: "master"; variants: HlsVariant[] }
  | { kind: "media"; initSegment?: HlsSegment; segments: HlsSegment[] };

/** `#EXT-X-BYTERANGE:<n>[@<o>]` */
const parseByteRange = (value: string): HlsByteRange | undefined => {
  const [lengthText, offsetText] = value.trim().split("@");
  const length = Number(lengthText);
  if (!Number.isFinite(length) || length <= 0) return undefined;
  const offset = offsetText === undefined ? undefined : Number(offsetText);
  if (offset !== undefined && !Number.isFinite(offset)) return { length };
  return offset === undefined ? { length } : { length, offset };
};

/** Pull `KEY=value` / `KEY="value"` pairs out of a tag's attribute list. */
const parseAttributes = (text: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  // Values may be quoted (and then contain commas), so split on commas that
  // are not inside quotes.
  const parts = text.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals === -1) continue;
    const key = part.slice(0, equals).trim().toUpperCase();
    let value = part.slice(equals + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  }
  return attributes;
};

const resolve = (uri: string, baseUrl: string): string => {
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return uri;
  }
};

export const parseHlsPlaylist = (
  text: string,
  baseUrl: string,
): HlsPlaylist => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const variants: HlsVariant[] = [];
  const segments: HlsSegment[] = [];
  let initSegment: HlsSegment | undefined;

  // State carried to the next URI line.
  let pendingByteRange: HlsByteRange | undefined;
  let pendingVariant: { bandwidth: number; height?: number } | undefined;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-STREAM-INF:".length));
      const resolution = attributes.RESOLUTION?.match(/^(\d+)x(\d+)$/);
      pendingVariant = {
        bandwidth: Number(attributes.BANDWIDTH ?? attributes["AVERAGE-BANDWIDTH"] ?? 0) || 0,
        height: resolution ? Number(resolution[2]) : undefined,
      };
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attributes = parseAttributes(line.slice("#EXT-X-MAP:".length));
      if (attributes.URI) {
        initSegment = {
          uri: resolve(attributes.URI, baseUrl),
          // BYTERANGE is optional here: without it the whole file is the
          // initialisation section.
          byteRange: attributes.BYTERANGE
            ? parseByteRange(attributes.BYTERANGE)
            : undefined,
        };
      }
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingByteRange = parseByteRange(line.slice("#EXT-X-BYTERANGE:".length));
      continue;
    }

    // Any other tag or comment carries no URI.
    if (line.startsWith("#")) continue;

    // A bare line is a URI, belonging to whichever tag preceded it.
    if (pendingVariant) {
      variants.push({ uri: resolve(line, baseUrl), ...pendingVariant });
      pendingVariant = undefined;
      continue;
    }

    segments.push({
      uri: resolve(line, baseUrl),
      byteRange: pendingByteRange,
    });
    pendingByteRange = undefined;
  }

  // A playlist advertising variants is a master playlist; its segments live one
  // level down. Variants win even if stray URIs were also collected.
  if (variants.length > 0) return { kind: "master", variants };

  return { kind: "media", initSegment, segments };
};

/** Highest resolution, then highest bandwidth. */
export const pickBestVariant = (
  variants: HlsVariant[],
): HlsVariant | undefined =>
  [...variants].sort(
    (a, b) => (b.height ?? 0) - (a.height ?? 0) || b.bandwidth - a.bandwidth,
  )[0];

/**
 * Fill in byte-range offsets the playlist left implicit.
 *
 * Per the spec, `#EXT-X-BYTERANGE:<n>` without an offset starts where the
 * previous sub-range of the *same resource* ended. Without this the offset was
 * NaN and the Range header read `bytes=NaN-NaN`.
 */
export const resolveByteRanges = (segments: HlsSegment[]): HlsSegment[] => {
  const nextOffsetByUri = new Map<string, number>();

  return segments.map((segment) => {
    if (!segment.byteRange) return segment;

    const offset =
      segment.byteRange.offset ?? nextOffsetByUri.get(segment.uri) ?? 0;
    nextOffsetByUri.set(segment.uri, offset + segment.byteRange.length);

    return {
      ...segment,
      byteRange: { length: segment.byteRange.length, offset },
    };
  });
};

/** A short, safe excerpt of a playlist, for putting in an error message. */
export const describePlaylist = (text: string, maxLines = 12): string => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const head = lines.slice(0, maxLines).join(" ⏎ ");
  const more = lines.length > maxLines ? ` … (+${lines.length - maxLines} lines)` : "";
  return `${lines.length} line(s): ${head}${more}`.slice(0, 900);
};
