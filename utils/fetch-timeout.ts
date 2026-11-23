/**
 * fetch with time limits.
 *
 * No request in the extension had one. A server that accepts the connection
 * and never answers — Reddit's API under load, RedGIFs, a CDN — left the
 * request, and the run waiting on it, hanging for good, with nothing written
 * to the log. Run logs from 23 Nov show exactly that: a run going silent on a
 * page for 8 and 25 minutes.
 *
 * Two limits: one for the response to start, and one for the whole body,
 * which for a large video has to be generous.
 */
export class FetchTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchTimeoutError";
  }
}

export type FetchLimits = {
  /** Until the response headers arrive. */
  startMs?: number;
  /** From then until the body has been read. */
  bodyMs?: number;
};

export const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  { startMs = 30_000, bodyMs = 120_000 }: FetchLimits = {},
): Promise<Response> => {
  const controller = new AbortController();
  let reason = "";
  const abortAfter = (ms: number, why: string) =>
    setTimeout(() => {
      reason = why;
      controller.abort();
    }, ms);

  const startTimer = abortAfter(
    startMs,
    `no response from ${new URL(url).host} within ${Math.round(startMs / 1000)}s`,
  );
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (reason) throw new FetchTimeoutError(reason);
    throw error;
  } finally {
    clearTimeout(startTimer);
  }

  // The body is read by the caller, after this returns, so its limit can't be
  // cleared here; when it fires on a finished request it does nothing. A
  // timed-out read rejects with AbortError, renamed below where we can.
  const bodyTimer = abortAfter(
    bodyMs,
    `${new URL(url).host} stopped sending within ${Math.round(bodyMs / 1000)}s`,
  );
  const wrap =
    <T>(read: () => Promise<T>) =>
    async (): Promise<T> => {
      try {
        return await read();
      } catch (error) {
        if (reason) throw new FetchTimeoutError(reason);
        throw error;
      } finally {
        clearTimeout(bodyTimer);
      }
    };
  const original = {
    blob: response.blob.bind(response),
    text: response.text.bind(response),
    json: response.json.bind(response),
    arrayBuffer: response.arrayBuffer.bind(response),
  };
  Object.assign(response, {
    blob: wrap(original.blob),
    text: wrap(original.text),
    json: wrap(original.json),
    arrayBuffer: wrap(original.arrayBuffer),
  });
  return response;
};
