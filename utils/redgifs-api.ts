import { logger } from "./logger";

/**
 * RedGIFs' documented way to get a video: a temporary token, then the gif's
 * record, which carries signed links to its HD and SD MP4 files.
 *
 * The extension used to rely only on an undocumented HLS playlist at
 * /v2/gifs/<id>/hd.m3u8. That 404s for some gifs — most of all the ones
 * Reddit embeds with long numeric ids — and its segment links carry no
 * signature, which RedGIFs answers with 403 for some older uploads. The
 * documented route also gives a single MP4, so there is no ffmpeg run, no
 * segment assembly and no multi-hundred-megabyte wasm heap per video.
 *
 * Signed links expire within the hour and are tied to the IP address and user
 * agent that asked for them, so they're fetched fresh for each download and
 * used straight away, from the same browser.
 *
 * https://github.com/Redgifs/api/wiki/Requesting-media-links
 */

const API = "https://api.redgifs.com/v2";
/** Temporary tokens last longer than this; an hour keeps well inside it. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

let cachedToken: { value: string; fetchedAt: number } | null = null;

export class RedGifsApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RedGifsApiError";
  }
}

const getToken = async (refresh = false): Promise<string> => {
  if (
    !refresh &&
    cachedToken &&
    Date.now() - cachedToken.fetchedAt < TOKEN_TTL_MS
  ) {
    return cachedToken.value;
  }
  const response = await fetch(`${API}/auth/temporary`);
  if (!response.ok) {
    throw new RedGifsApiError(
      `RedGIFs token request returned ${response.status}`,
      response.status,
    );
  }
  const body = (await response.json()) as { token?: string };
  if (!body.token) throw new RedGifsApiError("RedGIFs token response had no token");
  cachedToken = { value: body.token, fetchedAt: Date.now() };
  return body.token;
};

/** The gif id from one of our playlist URLs, or null. */
export const redGifsIdFromPlaylistUrl = (url: string): string | null =>
  url.match(/api\.redgifs\.com\/v2\/gifs\/([^/?#]+)\/hd\.m3u8/i)?.[1] ?? null;

/**
 * A signed MP4 link for the gif, HD where there is one. Throws a
 * RedGifsApiError carrying the HTTP status when RedGIFs refuses.
 */
export const resolveRedGifsMp4 = async (id: string): Promise<string> => {
  // The API wants lower case; the embed sometimes gives mixed case.
  const gifId = id.toLowerCase();
  const request = async (token: string) =>
    fetch(`${API}/gifs/${encodeURIComponent(gifId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

  let response = await request(await getToken());
  if (response.status === 401) {
    // Token expired or was revoked early; get a new one and try once more.
    response = await request(await getToken(true));
  }
  if (!response.ok) {
    throw new RedGifsApiError(
      `RedGIFs API returned ${response.status} for gif ${gifId}`,
      response.status,
    );
  }

  const body = (await response.json()) as {
    gif?: { urls?: { hd?: string; sd?: string } };
  };
  const url = body.gif?.urls?.hd ?? body.gif?.urls?.sd;
  if (!url) {
    throw new RedGifsApiError(`RedGIFs API listed no video file for gif ${gifId}`);
  }
  logger.log(`RedGIFs ${gifId}: using ${body.gif?.urls?.hd ? "HD" : "SD"} MP4`);
  return url;
};
