/**
 * What the extension is holding on to right now, for the sidebar's memory panel.
 *
 * Firefox gives extensions no way to read real memory use — there is no
 * equivalent of Chrome's performance.memory — so this counts the things that
 * cost memory instead: downloaded files still held as blobs, video-tool
 * instances (each one a WebAssembly heap that can run to hundreds of
 * megabytes), and downloads in flight. Each count lives in the context that
 * owns it; the sidebar asks the background page, where downloads happen.
 */

const heldBlobs = new Map<string, number>();
let peakHeldBytes = 0;
let ffmpegActive = 0;
let peakFfmpeg = 0;
let downloadsInFlight = 0;

const heldBytes = () => {
  let total = 0;
  for (const size of heldBlobs.values()) total += size;
  return total;
};

export const trackBlobUrl = (url: string, bytes: number) => {
  heldBlobs.set(url, bytes);
  peakHeldBytes = Math.max(peakHeldBytes, heldBytes());
};

export const untrackBlobUrl = (url: string) => {
  heldBlobs.delete(url);
};

export const noteFfmpegStarted = () => {
  ffmpegActive += 1;
  peakFfmpeg = Math.max(peakFfmpeg, ffmpegActive);
};

export const noteFfmpegEnded = () => {
  ffmpegActive = Math.max(0, ffmpegActive - 1);
};

export const noteDownloadStarted = () => {
  downloadsInFlight += 1;
};

export const noteDownloadEnded = () => {
  downloadsInFlight = Math.max(0, downloadsInFlight - 1);
};

export type ExtensionMemoryStats = {
  heldBytes: number;
  heldFiles: number;
  peakHeldBytes: number;
  ffmpegActive: number;
  peakFfmpeg: number;
  downloadsInFlight: number;
};

export const getExtensionMemoryStats = (): ExtensionMemoryStats => ({
  heldBytes: heldBytes(),
  heldFiles: heldBlobs.size,
  peakHeldBytes,
  ffmpegActive,
  peakFfmpeg,
  downloadsInFlight,
});
