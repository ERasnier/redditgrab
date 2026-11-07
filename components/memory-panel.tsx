import { useEffect, useRef, useState } from "react";
import { sendMessage } from "webext-bridge/popup";
import type { PageStats } from "@/types/shim";
import type { ExtensionMemoryStats } from "@/utils/memory-stats";

const POLL_MS = 3000;
/** Samples kept for the trend: about a minute at the poll rate. */
const TREND_SAMPLES = 20;

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
};

const Stat = ({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) => (
  <div className="rounded border border-gray-200 dark:border-gray-700 px-2 py-1.5">
    <div className="text-[10px] uppercase tracking-wide text-gray-500 dark:text-gray-400">
      {label}
    </div>
    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
      {value}
    </div>
    {hint && (
      <div className="text-[10px] text-gray-500 dark:text-gray-400">{hint}</div>
    )}
  </div>
);

/**
 * A live view of what the run is holding in memory.
 *
 * Firefox gives extensions no way to read how much memory a tab or the
 * extension really uses, so this shows what drives it: how much of the Reddit
 * page is still loaded, and what the download side is holding. It polls only
 * while the sidebar is visible.
 */
export const MemoryPanel = () => {
  const [page, setPage] = useState<PageStats | null>(null);
  const [extension, setExtension] = useState<ExtensionMemoryStats | null>(null);
  const [peakElements, setPeakElements] = useState(0);
  const trend = useRef<number[]>([]);
  const [trendDelta, setTrendDelta] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      if (document.visibilityState !== "visible") return;

      try {
        const stats = await sendMessage("GET_MEMORY_STATS", undefined, "background");
        if (!cancelled) setExtension(stats);
      } catch {}

      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (!tab?.id || !tab.url?.includes("reddit.com")) {
          if (!cancelled) setPage(null);
          return;
        }
        const stats = await sendMessage(
          "GET_PAGE_STATS",
          undefined,
          `content-script@${tab.id}`,
        );
        if (cancelled || !stats) return;
        setPage(stats);
        setPeakElements((peak) => Math.max(peak, stats.elements));
        const samples = trend.current;
        samples.push(stats.elements);
        if (samples.length > TREND_SAMPLES) samples.shift();
        setTrendDelta(samples.length > 1 ? samples[samples.length - 1] - samples[0] : null);
      } catch {
        // The page is mid-navigation or has no content script yet.
      }
    };

    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const trendText =
    trendDelta === null
      ? undefined
      : trendDelta > 200
        ? `rising: +${trendDelta} in the last minute`
        : trendDelta < -200
          ? `falling: ${trendDelta} in the last minute`
          : "steady over the last minute";

  return (
    <details className="rounded border border-gray-200 dark:border-gray-700 p-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-gray-700 dark:text-gray-300">
        Memory
        {page ? ` · ${page.posts} posts on the page` : ""}
        {extension && extension.heldBytes > 0
          ? ` · ${formatBytes(extension.heldBytes)} held`
          : ""}
      </summary>
      <div className="mt-2 space-y-2">
        <div className="text-[11px] font-medium text-gray-600 dark:text-gray-400">
          Reddit tab
        </div>
        {page ? (
          <div className="grid grid-cols-2 gap-1.5">
            <Stat label="Posts on page" value={String(page.posts)} />
            <Stat
              label="Page elements"
              value={page.elements.toLocaleString()}
              hint={trendText ?? `peak ${peakElements.toLocaleString()}`}
            />
            <Stat label="Video players" value={String(page.videos)} />
            <Stat label="Images" value={String(page.images)} />
            <Stat label="Download buttons" value={String(page.buttons)} />
            <Stat
              label="Removed this session"
              value={String(page.removedFromPage)}
              hint={
                page.releasedInPlace > 0
                  ? `${page.releasedInPlace} more released in place`
                  : undefined
              }
            />
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Open a Reddit page to see what it is holding.
          </p>
        )}
        <div className="text-[11px] font-medium text-gray-600 dark:text-gray-400">
          Downloads
        </div>
        {extension ? (
          <div className="grid grid-cols-2 gap-1.5">
            <Stat
              label="Held in memory"
              value={formatBytes(extension.heldBytes)}
              hint={`${extension.heldFiles} file(s) · peak ${formatBytes(extension.peakHeldBytes)}`}
            />
            <Stat
              label="Video tool running"
              value={String(extension.ffmpegActive)}
              hint={`peak ${extension.peakFfmpeg}`}
            />
            <Stat
              label="Saving now"
              value={String(extension.downloadsInFlight)}
            />
          </div>
        ) : (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Waiting for the background page…
          </p>
        )}
        <p className="text-[10px] leading-snug text-gray-500 dark:text-gray-400">
          Firefox doesn't let extensions read real memory use, so these are the
          things that use it. For actual figures, open about:processes in a tab.
        </p>
      </div>
    </details>
  );
};
