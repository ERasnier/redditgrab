import { useState, useEffect, useRef } from "react";
import { useForm } from "react-hook-form";
import { arktypeResolver } from "@hookform/resolvers/arktype";
import { DatePicker } from "@/components/ui/date-picker";
import {
  folderDestination as folderDestinationStorage,
  filenamePattern as filenamePatternStorage,
  useGalleryFolders as useGalleryFoldersStorage,
  addTitleToImages as addTitleToImagesStorage,
  addTitleToVideos as addTitleToVideosStorage,
  markDownloadedAsVisited as markDownloadedAsVisitedStorage,
  showDownloadedMarkers as showDownloadedMarkersStorage,
  forceDownloadProcessed as forceDownloadProcessedStorage,
  requestDelaySeconds as requestDelaySecondsStorage,
  savePostArchive as savePostArchiveStorage,
  urlQueueText as urlQueueTextStorage,
  useDateRange as useDateRangeStorage,
  dateRangeStart as dateRangeStartStorage,
  dateRangeEnd as dateRangeEndStorage,
  darkMode as darkModeStorage,
} from "@/utils/storage";
import { debounce } from "es-toolkit";
import { sendMessage } from "webext-bridge/popup";
import { useScrapingProgress } from "./use-scraping-progress";
import {
  processedPostIds,
  addProcessedPostId,
  addProcessedPostIds,
  flushProcessedPostIds,
  resetProcessedPostIdCache,
  debugLogging as debugLoggingStorage,
  keepWatching as keepWatchingStorage,
} from "@/utils/storage";
import {
  formatDiagnosticsReport,
  isFailure,
  isRoutine,
  permalinkForPostId,
  type PostDiagnostic,
} from "@/utils/diagnostics";
import { parseUrlQueue, isSameRedditPage } from "@/utils/url-queue";
import { runPageUntilExhausted } from "@/utils/page-runner";
import {
  UrlQueueInput,
  type QueueEntryStatus,
} from "@/components/url-queue-input";
import { createTextFileUrl, downloadAndRelease, revokeIfObjectUrl } from "@/utils/blob-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Icon } from "@iconify/react";
import { logger } from "@/utils/logger";
import { SettingsSchema, type SettingsFormData } from "@/types/settings-schema";
import { FAQ } from "@/components/faq";
import { Changelog } from "@/components/changelog";
import { SidebarFooter } from "@/components/sidebar-footer";
import {
  MassDownloadMediaFilter,
  mediaTypeMatchesMassDownloadFilter,
  type MassDownloadMediaFilterValue,
} from "@/components/mass-download-media-filter";
import { processFolderDestination } from "@/utils/post-utils";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many consecutive scrolls may load nothing before a page is treated as
 * finished. Reddit's infinite scroll is intermittent — one quiet scroll near
 * the end of a listing is normal — so a single miss isn't proof.
 */
const EMPTY_SCROLLS_BEFORE_DONE = 3;

/** Longest to wait for a navigation to finish loading. */
const NAV_LOAD_TIMEOUT_MS = 45_000;
/** Longest to wait for the content script to answer on the new page. */
const NAV_READY_TIMEOUT_MS = 20_000;

/**
 * Wait until the tab has finished loading the page we asked for.
 *
 * Checking only for `status === "complete"` isn't enough: for a moment after
 * `tabs.update` the tab still reports the *previous* page as complete, so a
 * naive check returns at once and the scan runs against the page we were trying
 * to leave. Require the URL to have actually moved as well — either to the
 * target, or somewhere else if Reddit redirected us.
 */
const waitForTabLoad = async (
  tabId: number,
  targetUrl: string,
  previousUrl: string | undefined,
) => {
  const deadline = Date.now() + NAV_LOAD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(300);
    let tab: Browser.tabs.Tab;
    try {
      tab = await browser.tabs.get(tabId);
    } catch {
      // The tab was closed under us; nothing left to download into.
      throw new Error("the tab was closed");
    }
    if (tab.status !== "complete" || !tab.url) continue;

    const arrived = isSameRedditPage(tab.url, targetUrl);
    const movedOn = !previousUrl || tab.url !== previousUrl;
    if (arrived || movedOn) {
      if (!arrived) {
        logger.warn(`Expected ${targetUrl} but landed on ${tab.url}`);
      }
      return tab.url;
    }
  }
  throw new Error(
    `page did not finish loading within ${NAV_LOAD_TIMEOUT_MS / 1000}s`,
  );
};

/**
 * Wait for the content script to respond on the newly loaded page.
 *
 * A freshly navigated tab accepts messages only once the content script has
 * been injected and registered its handlers; scanning before then fails with a
 * confusing bridge error, so poll a cheap PING until it answers.
 */
const waitForContentScript = async (tabId: number) => {
  const deadline = Date.now() + NAV_READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const pong = await sendMessage(
        "PING",
        undefined,
        `content-script@${tabId}`,
      );
      if (pong?.success) return pong;
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(
    `content script did not respond within ${NAV_READY_TIMEOUT_MS / 1000}s${
      lastError ? ` (${String(lastError)})` : ""
    }`,
  );
};

/**
 * Point the tab at a queued URL and wait until it is ready to be scanned.
 * Skips the navigation when the tab is already on that page, so starting a
 * queue whose first entry is the current page doesn't pointlessly reload it.
 */
const navigateTab = async (tabId: number, url: string) => {
  let current: Browser.tabs.Tab | undefined;
  try {
    current = await browser.tabs.get(tabId);
  } catch {
    throw new Error("the tab was closed");
  }

  if (current?.url && isSameRedditPage(current.url, url)) {
    logger.log(`Already on ${url}, not reloading`);
    await waitForContentScript(tabId);
    return;
  }

  await browser.tabs.update(tabId, { url });
  await waitForTabLoad(tabId, url, current?.url);
  const pong = await waitForContentScript(tabId);
  logger.log(
    `Opened ${pong.url} (${pong.layout} layout, ${pong.posts} posts on screen)`,
  );
};

const debouncedSaveFolder = debounce(async (value: string) => {
  await folderDestinationStorage.setValue(value);
}, 500);

const debouncedSaveFilename = debounce(async (value: string) => {
  await filenamePatternStorage.setValue(value);
}, 500);

const debouncedSaveGalleryFolders = debounce(async (value: boolean) => {
  await useGalleryFoldersStorage.setValue(value);
}, 500);

const debouncedSaveTitleToImages = debounce(async (value: boolean) => {
  await addTitleToImagesStorage.setValue(value);
}, 500);

const debouncedSaveTitleToVideos = debounce(async (value: boolean) => {
  await addTitleToVideosStorage.setValue(value);
}, 500);

const debouncedSaveMarkDownloadedAsVisited = debounce(
  async (value: boolean) => {
    await markDownloadedAsVisitedStorage.setValue(value);
  },
  500,
);

const debouncedSaveShowDownloadedMarkers = debounce(async (value: boolean) => {
  await showDownloadedMarkersStorage.setValue(value);
}, 500);

const debouncedSaveForceDownloadProcessed = debounce(async (value: boolean) => {
  await forceDownloadProcessedStorage.setValue(value);
}, 500);

const debouncedSaveRequestDelaySeconds = debounce(async (value: number) => {
  await requestDelaySecondsStorage.setValue(value);
}, 500);

const debouncedSaveUrlQueue = debounce(async (value: string) => {
  await urlQueueTextStorage.setValue(value);
}, 500);

const debouncedSaveSavePostArchive = debounce(async (value: boolean) => {
  await savePostArchiveStorage.setValue(value);
}, 500);

const debouncedSaveUseDateRange = debounce(async (value: boolean) => {
  await useDateRangeStorage.setValue(value);
}, 500);

const debouncedSaveDateRangeStart = debounce(
  async (value: number | undefined) => {
    await dateRangeStartStorage.setValue(value ? value.toString() : "");
  },
  500,
);

const debouncedSaveDateRangeEnd = debounce(
  async (value: number | undefined) => {
    await dateRangeEndStorage.setValue(value ? value.toString() : "");
  },
  500,
);

function SidebarApp() {
  const form = useForm<SettingsFormData>({
    resolver: arktypeResolver(SettingsSchema),
    mode: "onChange", // Validate on every change
    reValidateMode: "onChange", // Re-validate on every change
    defaultValues: {
      folderDestination: "Reddit Downloads/{subreddit}/{date}",
      filenamePattern: "{subreddit}_{timestamp}_{filename}",
      useGalleryFolders: false,
      addTitleToImages: false,
      addTitleToVideos: false,
      markDownloadedAsVisited: false,
      showDownloadedMarkers: false,
      forceDownloadProcessed: false,
      requestDelaySeconds: 1,
      savePostArchive: false,
      useDateRange: false,
      dateRangeStart: undefined,
      dateRangeEnd: undefined,
    },
  });

  const [isClearingHistory, setIsClearingHistory] = useState(false);
  const [debugLogging, setDebugLogging] = useState(false);
  const [keepWatching, setKeepWatching] = useState(true);
  // Raw textarea text, and the per-entry status of the run in progress.
  const [urlQueueInput, setUrlQueueInput] = useState("");
  const [queueStatuses, setQueueStatuses] = useState<QueueEntryStatus[]>([]);
  const [queueProgress, setQueueProgress] = useState<{
    index: number;
    total: number;
    label: string;
  } | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string>("");
  const [isRedditPage, setIsRedditPage] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [massDownloadScrollUp, setMassDownloadScrollUp] = useState(false);
  const [massDownloadMediaFilter, setMassDownloadMediaFilter] =
    useState<MassDownloadMediaFilterValue>("all");

  // Load values from storage into form
  useEffect(() => {
    const loadSettings = async () => {
      const [
        folderDestination,
        filenamePattern,
        useGalleryFolders,
        addTitleToImages,
        addTitleToVideos,
        markDownloadedAsVisited,
        showDownloadedMarkers,
        forceDownloadProcessed,
        requestDelaySeconds,
        savePostArchive,
        useDateRange,
        dateRangeStart,
        dateRangeEnd,
        darkMode,
        debugLoggingValue,
        keepWatchingValue,
        urlQueueValue,
      ] = await Promise.all([
        folderDestinationStorage.getValue(),
        filenamePatternStorage.getValue(),
        useGalleryFoldersStorage.getValue(),
        addTitleToImagesStorage.getValue(),
        addTitleToVideosStorage.getValue(),
        markDownloadedAsVisitedStorage.getValue(),
        showDownloadedMarkersStorage.getValue(),
        forceDownloadProcessedStorage.getValue(),
        requestDelaySecondsStorage.getValue(),
        savePostArchiveStorage.getValue(),
        useDateRangeStorage.getValue(),
        dateRangeStartStorage.getValue(),
        dateRangeEndStorage.getValue(),
        darkModeStorage.getValue(),
        debugLoggingStorage.getValue(),
        keepWatchingStorage.getValue(),
        urlQueueTextStorage.getValue(),
      ]);

      setDebugLogging(debugLoggingValue || false);
      setKeepWatching(keepWatchingValue !== false);
      setUrlQueueInput(urlQueueValue || "");

      form.reset({
        folderDestination:
          folderDestination || "Reddit Downloads/{subreddit}/{date}",
        filenamePattern:
          filenamePattern || "{subreddit}_{timestamp}_{filename}",
        useGalleryFolders: useGalleryFolders || false,
        addTitleToImages: addTitleToImages || false,
        addTitleToVideos: addTitleToVideos || false,
        markDownloadedAsVisited: markDownloadedAsVisited || false,
        showDownloadedMarkers: showDownloadedMarkers || false,
        forceDownloadProcessed: forceDownloadProcessed || false,
        requestDelaySeconds: requestDelaySeconds ?? 1,
        savePostArchive: savePostArchive || false,
        useDateRange: useDateRange || false,
        dateRangeStart: dateRangeStart ? parseInt(dateRangeStart) : undefined,
        dateRangeEnd: dateRangeEnd ? parseInt(dateRangeEnd) : undefined,
      });

      // Set dark mode
      setIsDarkMode(darkMode || false);
      document.documentElement.classList.toggle("dark", darkMode || false);
    };

    loadSettings();
  }, [form]);

  // Watch form changes and save to storage
  useEffect(() => {
    const subscription = form.watch((value, { name }) => {
      if (name) {
        switch (name) {
          case "folderDestination":
            debouncedSaveFolder(value.folderDestination || "");
            break;
          case "filenamePattern":
            debouncedSaveFilename(value.filenamePattern || "");
            break;
          case "useGalleryFolders":
            debouncedSaveGalleryFolders(value.useGalleryFolders || false);
            break;
          case "addTitleToImages":
            debouncedSaveTitleToImages(value.addTitleToImages || false);
            break;
          case "addTitleToVideos":
            debouncedSaveTitleToVideos(value.addTitleToVideos || false);
            break;
          case "markDownloadedAsVisited":
            debouncedSaveMarkDownloadedAsVisited(
              value.markDownloadedAsVisited || false,
            );
            break;
          case "showDownloadedMarkers":
            debouncedSaveShowDownloadedMarkers(
              value.showDownloadedMarkers || false,
            );
            break;
          case "forceDownloadProcessed":
            debouncedSaveForceDownloadProcessed(
              value.forceDownloadProcessed || false,
            );
            break;
          case "requestDelaySeconds":
            if (
              typeof value.requestDelaySeconds === "number" &&
              value.requestDelaySeconds >= 0 &&
              value.requestDelaySeconds <= 60
            ) {
              debouncedSaveRequestDelaySeconds(value.requestDelaySeconds);
            }
            break;
          case "savePostArchive":
            debouncedSaveSavePostArchive(value.savePostArchive || false);
            break;
          case "useDateRange":
            debouncedSaveUseDateRange(value.useDateRange || false);
            break;
          case "dateRangeStart":
            debouncedSaveDateRangeStart(value.dateRangeStart);
            form.trigger(["dateRangeStart", "dateRangeEnd"]);
            break;
          case "dateRangeEnd":
            debouncedSaveDateRangeEnd(value.dateRangeEnd);
            form.trigger(["dateRangeStart", "dateRangeEnd"]);
            break;
        }
      }
    });
    return () => subscription.unsubscribe();
  }, [form]);

  // Check if current tab is on Reddit
  useEffect(() => {
    const checkCurrentTab = async () => {
      try {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });

        if (tab?.url) {
          setCurrentUrl(tab.url);
          const isReddit = tab.url.includes("reddit.com");
          setIsRedditPage(isReddit);
        }
      } catch (error) {
        console.error("Failed to get current tab:", error);
        setIsRedditPage(false);
      }
    };

    checkCurrentTab();

    const handleTabUpdate = (
      tabId: number,
      changeInfo: Browser.tabs.OnUpdatedInfo,
      tab: Browser.tabs.Tab,
    ) => {
      if (changeInfo.url && tab.active) {
        setCurrentUrl(tab.url as string);
        const isReddit = tab.url?.includes("reddit.com");
        setIsRedditPage(isReddit ?? false);
      }
    };

    const handleTabActivated = async (
      activeInfo: Browser.tabs.OnActivatedInfo,
    ) => {
      try {
        const tab = await browser.tabs.get(activeInfo.tabId);
        if (tab?.url) {
          setCurrentUrl(tab.url);
          const isReddit = tab.url.includes("reddit.com");
          setIsRedditPage(isReddit);
        }
      } catch (error) {
        console.error("Failed to get activated tab:", error);
      }
    };

    // Add listeners for tab updates and activation
    browser.tabs.onUpdated.addListener(handleTabUpdate);
    browser.tabs.onActivated.addListener(handleTabActivated);

    // Cleanup listeners on unmount
    return () => {
      browser.tabs.onUpdated.removeListener(handleTabUpdate);
      browser.tabs.onActivated.removeListener(handleTabActivated);
    };
  }, []);

  const {
    scrapingStatus,
    startScraping,
    stopScraping,
    setCurrentBatchCount,
    incrementDownloadCount,
    addToTotalPostsFound,
    setCurrentPostInfo,
    recordFailure,
    addScanTotals,
  } = useScrapingProgress();

  // Ref to control continuous processing loop
  const shouldContinueProcessingRef = useRef(false);

  /**
   * Every post this run did not download, with the reason. Accumulated across
   * scan passes so a run can be audited afterwards rather than relying on
   * whatever happens to still be in the console.
   */
  const diagnosticsRef = useRef<PostDiagnostic[]>([]);
  /**
   * postId+reason pairs already recorded. A post with no media element is
   * re-examined on every scan cycle (nothing adds it to a skip set), so without
   * this the same handful of text posts would be appended every few seconds.
   */
  const seenDiagnosticsRef = useRef<Set<string>>(new Set());
  const runStartedAtRef = useRef<number | null>(null);
  /** Live count, readable from async callbacks where state would be stale. */
  const downloadedCountRef = useRef(0);
  const [diagnosticsCount, setDiagnosticsCount] = useState(0);
  const [isSavingReport, setIsSavingReport] = useState(false);

  /**
   * Separate budgets, for the reason given on DiagnosticsCollector: a shared
   * cap let a feed full of already-processed posts squeeze out the download
   * failures the report is actually for.
   */
  const PROBLEM_LIMIT = 5000;
  const ROUTINE_LIMIT = 200;
  const routineStoredRef = useRef(0);
  const problemStoredRef = useRef(0);
  /**
   * Counts per reason across the whole run, including skips that were counted
   * but not individually recorded, so the report's summary is complete even
   * when the per-record budgets are full.
   */
  const reasonCountsRef = useRef<Record<string, number>>({});

  const countReasons = (tally: Record<string, number>) => {
    for (const [reason, count] of Object.entries(tally)) {
      reasonCountsRef.current[reason] =
        (reasonCountsRef.current[reason] ?? 0) + count;
    }
  };

  const pushDiagnostics = (records: PostDiagnostic[]) => {
    if (records.length === 0) return;
    let added = 0;
    for (const record of records) {
      const routine = !isFailure(record.reason) && isRoutine(record.reason);
      if (routine && routineStoredRef.current >= ROUTINE_LIMIT) continue;
      if (!routine && problemStoredRef.current >= PROBLEM_LIMIT) continue;

      const key = `${record.postId}|${record.reason}`;
      if (seenDiagnosticsRef.current.has(key)) continue;
      seenDiagnosticsRef.current.add(key);

      diagnosticsRef.current.push(record);
      if (routine) routineStoredRef.current += 1;
      else problemStoredRef.current += 1;
      added += 1;
    }
    if (added > 0) setDiagnosticsCount(diagnosticsRef.current.length);
  };

  // Fed into each scan as skipPostIds so a failing post can't loop forever.
  const failedPostIdsRef = useRef<Set<string>>(new Set());

  // Post ids already handled during the current mass-download run. Fed into each
  // scan as skipPostIds so the loop advances and terminates even when
  // forceDownloadProcessed ignores the persistent history (otherwise the same
  // posts would be re-scanned every cycle and never scroll/stop).
  const handledThisRunRef = useRef<Set<string>>(new Set());

  const handleMassScrape = async () => {
    try {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab?.id) {
        throw new Error("No active tab found");
      }

      // Entries are resolved up front so a typo surfaces before anything is
      // downloaded rather than halfway through a long run.
      const { entries: queue, errors: queueErrors } =
        parseUrlQueue(urlQueueInput);
      if (queueErrors.length > 0) {
        logger.error(
          `Ignoring ${queueErrors.length} unusable queue line(s):`,
          queueErrors.map((e) => `line ${e.line}: ${e.text} — ${e.reason}`),
        );
      }

      const delaySeconds = form.getValues("requestDelaySeconds");
      const requestDelayMs =
        Number.isFinite(delaySeconds) && delaySeconds >= 0
          ? delaySeconds * 1000
          : 1000;

      startScraping();
      shouldContinueProcessingRef.current = true;
      failedPostIdsRef.current = new Set();
      handledThisRunRef.current = new Set();
      diagnosticsRef.current = [];
      seenDiagnosticsRef.current = new Set();
      routineStoredRef.current = 0;
      problemStoredRef.current = 0;
      reasonCountsRef.current = {};
      downloadedCountRef.current = 0;
      runStartedAtRef.current = Date.now();
      setDiagnosticsCount(0);
      setQueueProgress(null);
      setQueueStatuses([]);

      /**
       * Scan the page once and download whatever that scan turned up.
       * Returns how many posts were queued and attempted so the caller can
       * decide whether the page still has anything left.
       */
      const processOneBatch = async (
        scrollUp: boolean,
      ): Promise<{
        queued: number;
        attempted: number;
      }> => {
        let scanPayload: {
          scrollUp?: boolean;
          anchorPostId?: string;
          skipPostIds?: string[];
        } = {
          scrollUp,
          skipPostIds: [
            ...failedPostIdsRef.current,
            ...handledThisRunRef.current,
          ],
        };

        if (scrollUp) {
          try {
            const anchorRes = await sendMessage(
              "GET_CURRENT_POST_ID",
              undefined,
              `content-script@${tab.id}`,
            );
            if (anchorRes?.success && anchorRes.postId) {
              scanPayload.anchorPostId = anchorRes.postId;
              logger.log("Scroll up: using anchor post", anchorRes.postId);
            }
          } catch (e) {
            logger.warn("Could not get current post id for scroll up", e);
          }
        }

        // Ask content script to scan for media using webext-bridge
        const response = await sendMessage(
          "SCAN_PAGE_MEDIA",
          scanPayload,
          `content-script@${tab.id}`,
        );

        logger.log(
          "Content script response:",
          JSON.stringify(response, null, 2),
        );

        if (!response.success || !response.data) {
          throw new Error("Failed to get media from page");
        }

        const { mediaUrls } = response.data;

        // Posts the content script examined but never queued, with reasons.
        const scanSkips = response.data.skipped ?? [];
        pushDiagnostics(scanSkips);
        const scanTally = response.data.skipTally ?? {};
        countReasons(scanTally);
        // The tally covers skips that were counted but not recorded, so it is
        // the true total; fall back to the record count if it's absent.
        const tallied = Object.values(scanTally).reduce((sum, n) => sum + n, 0);
        const scanSkipTotal = tallied > 0 ? tallied : scanSkips.length;
        addScanTotals(scanSkipTotal, response.data.examined ?? 0);

        // Mark every scanned post as handled this run so it isn't re-scanned on
        // the next cycle (needed for loop termination when force download
        // ignores the persistent processed history).
        for (const item of mediaUrls) {
          handledThisRunRef.current.add(item.mediaPostId);
        }

        const filteredMediaUrls = mediaUrls.filter((item) =>
          mediaTypeMatchesMassDownloadFilter(
            item.type,
            massDownloadMediaFilter,
          ),
        );

        const skippedByFilter = mediaUrls.filter(
          (item) =>
            !mediaTypeMatchesMassDownloadFilter(
              item.type,
              massDownloadMediaFilter,
            ),
        );
        if (skippedByFilter.length > 0) {
          // Batched write rather than read-spread-write per post.
          await addProcessedPostIds(
            skippedByFilter.map((item) => item.mediaPostId),
          );
          countReasons({ "media-type-filtered": skippedByFilter.length });
          pushDiagnostics(
            skippedByFilter.map((item) => ({
              postId: item.mediaPostId,
              stage: "filter" as const,
              reason: "media-type-filtered" as const,
              detail: `type=${item.type}, filter=${massDownloadMediaFilter}`,
              title: item.postTitle,
              subreddit: item.subredditName,
              permalink: permalinkForPostId(item.mediaPostId),
              at: Date.now(),
            })),
          );
          logger.log(
            `Skipped ${skippedByFilter.length} post(s) (media type filter: ${massDownloadMediaFilter})`,
          );
        }

        logger.log(
          `Starting downloads for ${filteredMediaUrls.length} of ${mediaUrls.length} media item(s)`,
        );

        // Update progress tracking
        setCurrentBatchCount(filteredMediaUrls.length);
        addToTotalPostsFound(filteredMediaUrls.length);

        // Process downloads similar to download-button.tsx
        for (let i = 0; i < filteredMediaUrls.length; i++) {
          const mediaItem = filteredMediaUrls[i];

          if (!shouldContinueProcessingRef.current) {
            logger.log("Processing stopped by user");
            break;
          }

          try {
            // Calculate folder destination with variable substitution
            const currentFolderDestination =
              form.getValues("folderDestination");
            const finalFolderDestination = processFolderDestination(
              currentFolderDestination,
              null, // No post element available in sidebar
              mediaItem.subredditName,
              mediaItem.postDate,
              mediaItem.postAuthor,
              mediaItem.postTitle,
            );

            logger.log(
              `Downloading ${i + 1}/${filteredMediaUrls.length}: ${
                mediaItem.type
              } with ${mediaItem.urls.length} URLs`,
            );

            // Update current post info and highlight
            setCurrentPostInfo({
              index: i + 1,
              type: mediaItem.type,
              subreddit: mediaItem.subredditName,
            });

            try {
              await sendMessage(
                "HIGHLIGHT_CURRENT_POST",
                {
                  mediaPostId: mediaItem.mediaPostId,
                  subredditName: mediaItem.subredditName,
                  mediaType: mediaItem.type,
                },
                `content-script@${tab.id}`,
              );
            } catch (error) {
              console.warn("Failed to highlight post:", error);
            }

            // Send download request to background script
            const downloadResponse = await sendMessage(
              "DOWNLOAD_REQUEST",
              {
                timestamp: Date.now(),
                mediaContentType: mediaItem.type,
                urls: mediaItem.urls,
                folderDestination: finalFolderDestination,
                subredditName: mediaItem.subredditName,
                useGalleryFolders: form.getValues("useGalleryFolders"),
                addTitleToImages: form.getValues("addTitleToImages"),
                addTitleToVideos: form.getValues("addTitleToVideos"),
                postTitle: mediaItem.postTitle,
                postAuthor: mediaItem.postAuthor,
                postId: mediaItem.mediaPostId,
                savePostArchive: form.getValues("savePostArchive"),
              },
              "background",
            );

            if (downloadResponse?.success) {
              logger.log(`Download ${i + 1} completed`);
              incrementDownloadCount();
              downloadedCountRef.current += 1;

              // Mark this post as processed. Buffered and flushed in batches
              // instead of rewriting the whole id array per download.
              await addProcessedPostId(mediaItem.mediaPostId);

              if (form.getValues("markDownloadedAsVisited")) {
                try {
                  await sendMessage(
                    "MARK_POST_VISITED",
                    { mediaPostId: mediaItem.mediaPostId },
                    `content-script@${tab.id}`,
                  );
                } catch (e) {
                  console.warn("Failed to mark post as visited:", e);
                }
              }
            } else {
              const message = downloadResponse?.message ?? "no reason given";
              const reason =
                downloadResponse?.reason ?? "download-request-failed";
              // Always logged, with enough to find the post again.
              logger.error(
                `Download failed for ${mediaItem.mediaPostId} (${mediaItem.type}, r/${mediaItem.subredditName}): ${message}`,
                permalinkForPostId(mediaItem.mediaPostId) ?? "",
              );
              failedPostIdsRef.current.add(mediaItem.mediaPostId);
              recordFailure(mediaItem.mediaPostId, reason);
              countReasons({ [reason]: 1 });
              pushDiagnostics([
                {
                  postId: mediaItem.mediaPostId,
                  stage: "download",
                  reason,
                  detail: message,
                  title: mediaItem.postTitle,
                  subreddit: mediaItem.subredditName,
                  permalink: permalinkForPostId(mediaItem.mediaPostId),
                  at: Date.now(),
                },
              ]);
            }

            // Pause between downloads so Reddit doesn't rate limit the page
            if (i < filteredMediaUrls.length - 1) {
              const delaySeconds = form.getValues("requestDelaySeconds");
              const delayMs =
                Number.isFinite(delaySeconds) && delaySeconds >= 0
                  ? delaySeconds * 1000
                  : 1000;
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error(
              `Download threw for ${mediaItem.mediaPostId} (${mediaItem.type}, r/${mediaItem.subredditName}): ${message}`,
              permalinkForPostId(mediaItem.mediaPostId) ?? "",
            );
            failedPostIdsRef.current.add(mediaItem.mediaPostId);
            recordFailure(mediaItem.mediaPostId, "download-threw");
            countReasons({ "download-threw": 1 });
            pushDiagnostics([
              {
                postId: mediaItem.mediaPostId,
                stage: "download",
                reason: "download-threw",
                detail: message,
                title: mediaItem.postTitle,
                subreddit: mediaItem.subredditName,
                permalink: permalinkForPostId(mediaItem.mediaPostId),
                at: Date.now(),
              },
            ]);
          }
        }

        // Make sure buffered processed-ids reach storage at the end of each
        // batch, not only when the buffer happens to fill up.
        await flushProcessedPostIds();

        logger.always(
          `Batch complete: ${mediaUrls.length} queued, ${filteredMediaUrls.length} attempted, ${scanSkips.length} skipped during scan.`,
        );
        setCurrentPostInfo(null);

        return {
          queued: mediaUrls.length,
          attempted: filteredMediaUrls.length,
        };
      };

      /**
       * Download everything on the page the tab is currently showing, scrolling
       * to pull in more as needed, and resolve once the page is exhausted.
       *
       * This replaces a chain of recursive setTimeouts that had no terminal
       * state when scrolling down: it scrolled at the bottom of a finished
       * listing forever. The scroll call now reports whether anything actually
       * loaded, so an exhausted page can be recognised — which is also what
       * lets the URL queue know when to move on.
       */
      const runCurrentPage = (scrollUp: boolean, watch = false) =>
        runPageUntilExhausted({
          scrollUp,
          keepWatching: watch,
          processBatch: () => processOneBatch(scrollUp),
          scrollForMore: async () => {
            const scroll = await sendMessage(
              "SCROLL_TO_LOAD_MORE",
              { scrollUp },
              `content-script@${tab.id}`,
            );
            return { grew: scroll?.grew === true };
          },
          shouldContinue: () => shouldContinueProcessingRef.current,
          sleep,
          log: (message) => logger.always(message),
          emptyScrollsBeforeDone: EMPTY_SCROLLS_BEFORE_DONE,
        });

      const finish = async (note: string) => {
        shouldContinueProcessingRef.current = false;
        await flushProcessedPostIds();
        setCurrentPostInfo(null);
        setQueueProgress(null);
        stopScraping();
        logger.always(note);
        logRunSummary();
      };

      // --- No queue: download the page the user is already looking at. ---
      if (queue.length === 0) {
        if (keepWatching) {
          logger.always(
            "Watching this page: the run keeps going after the listing runs out, picking up new posts until you stop it.",
          );
        }
        const outcome = await runCurrentPage(massDownloadScrollUp, keepWatching);
        await finish(
          outcome === "stopped"
            ? "Processing stopped by user"
            : "Mass download complete.",
        );
        return;
      }

      // --- Queue: navigate to each entry in turn. ---
      // Every queued page opens at the top, so "scroll up from current post"
      // has nothing to scroll up from; downloading each page top-to-bottom is
      // the only sensible reading.
      if (massDownloadScrollUp) {
        logger.always(
          'Ignoring "scroll up from current post" — each queued page starts at the top.',
        );
      }
      logger.always(`Queue: ${queue.length} page(s) to visit`);
      setQueueStatuses(queue.map(() => "pending"));

      for (let index = 0; index < queue.length; index++) {
        if (!shouldContinueProcessingRef.current) break;

        const entry = queue[index];
        setQueueProgress({
          index: index + 1,
          total: queue.length,
          label: entry.label,
        });
        setQueueStatuses((prev) => {
          const next = [...prev];
          next[index] = "active";
          return next;
        });

        // Per-page skip sets: these exist to terminate the loop on one page, so
        // carrying them across pages would only bloat every scan message.
        failedPostIdsRef.current = new Set();
        handledThisRunRef.current = new Set();

        logger.always(
          `[${index + 1}/${queue.length}] ${entry.label} — ${entry.url}`,
        );

        try {
          await navigateTab(tab.id, entry.url);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.error(`Could not open ${entry.url}: ${message}`);
          setQueueStatuses((prev) => {
            const next = [...prev];
            next[index] = "failed";
            return next;
          });
          continue;
        }

        if (!shouldContinueProcessingRef.current) break;

        const outcome = await runCurrentPage(false);
        setQueueStatuses((prev) => {
          const next = [...prev];
          next[index] = outcome === "stopped" ? "pending" : "done";
          return next;
        });

        if (outcome === "stopped") break;

        // Breathe between sites so Reddit doesn't see a burst of navigations.
        if (index < queue.length - 1) {
          await sleep(Math.max(1000, requestDelayMs));
        }
      }

      await finish(
        shouldContinueProcessingRef.current
          ? "Queue finished."
          : "Processing stopped by user",
      );
    } catch (error) {
      logger.error("Failed to start mass scraping:", error);
      shouldContinueProcessingRef.current = false;
      await flushProcessedPostIds();
      setQueueProgress(null);
      stopScraping();
    }
  };

  const handleStopScraping = async () => {
    try {
      shouldContinueProcessingRef.current = false;
      setCurrentPostInfo(null);
      stopScraping();
      await flushProcessedPostIds();
      logRunSummary();
    } catch (error) {
      logger.error("Failed to stop mass scraping:", error);
    }
  };

  /** Always-visible end-of-run accounting, debug mode or not. */
  const logRunSummary = () => {
    const records = diagnosticsRef.current;
    const failures = records.filter((record) => isFailure(record.reason));
    // Read from the ref, not from state — this runs inside async callbacks
    // whose closed-over state is from whenever the run started.
    logger.always(
      `Mass download finished — downloaded ${downloadedCountRef.current}, failed ${failures.length}, skipped ${records.length - failures.length}.`,
    );
    if (records.length > 0) {
      logger.always(
        "Reasons:",
        records.reduce<Record<string, number>>((counts, record) => {
          counts[record.reason] = (counts[record.reason] ?? 0) + 1;
          return counts;
        }, {}),
      );
      logger.always(
        'Use "Save diagnostics report" in the sidebar for the per-post detail.',
      );
    }
  };

  /**
   * Write the accumulated diagnostics out as a text file, so a run can be
   * audited without keeping a console open for the whole thing.
   */
  const handleSaveDiagnostics = async () => {
    if (diagnosticsRef.current.length === 0) return;
    setIsSavingReport(true);
    let url: string | null = null;
    try {
      const report = formatDiagnosticsReport(diagnosticsRef.current, {
        url: currentUrl,
        startedAt: runStartedAtRef.current ?? undefined,
        finishedAt: Date.now(),
        counts: reasonCountsRef.current,
        downloaded: downloadedCountRef.current,
      });
      url = createTextFileUrl(report, "text/plain;charset=utf-8");
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      await downloadAndRelease(url, `RedditGrab/diagnostics_${stamp}.txt`);
      url = null;
    } catch (error) {
      logger.error("Failed to save diagnostics report:", error);
      if (url) revokeIfObjectUrl(url);
    } finally {
      setIsSavingReport(false);
    }
  };

  const handleClearProcessedPosts = async () => {
    try {
      setIsClearingHistory(true);
      await processedPostIds.setValue([]);
      resetProcessedPostIdCache();
      logger.log("Cleared processed posts history");
      // Small delay to show the loading state
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error("Failed to clear processed posts:", error);
    } finally {
      setIsClearingHistory(false);
    }
  };

  const handleToggleDarkMode = async () => {
    const newDarkMode = !isDarkMode;
    setIsDarkMode(newDarkMode);
    document.documentElement.classList.toggle("dark", newDarkMode);
    await darkModeStorage.setValue(newDarkMode);
  };

  // The Media search tab has no post dates in its grid, so date filtering can't
  // apply there. Disable the control and explain why.
  const isMediaSearchTab = (() => {
    try {
      const url = new URL(currentUrl);
      return (
        url.pathname.includes("/search") &&
        url.searchParams.get("type") === "media"
      );
    } catch {
      return false;
    }
  })();

  // Show different content if not on Reddit
  if (!isRedditPage) {
    return (
      <div
        className="w-full h-full min-h-screen p-4 bg-gradient-to-br from-gray-50 to-white flex flex-col items-center justify-center"
        style={{ minWidth: "300px" }}
      >
        {/* Header */}
        <div className="text-center mb-6">
          <div className="w-16 h-16 bg-orange-500 rounded-full flex items-center justify-center mx-auto mb-4">
            <Icon icon="lucide:alert-circle" className="text-white w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold text-gray-800 mb-2">RedditGrab</h1>
          <p className="text-sm text-gray-600 mb-4">
            This extension only works on Reddit.com
          </p>
        </div>

        {/* Current URL Display */}
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4 mb-6 w-full">
          <div className="flex items-start space-x-3">
            <Icon
              icon="lucide:info"
              className="text-yellow-600 w-5 h-5 mt-0.5 flex-shrink-0"
            />
            <div>
              <h3 className="text-sm font-medium text-yellow-800 mb-1">
                Current Page
              </h3>
              <p className="text-xs text-yellow-700 break-all">
                {currentUrl || "Unable to detect current page"}
              </p>
            </div>
          </div>
        </div>

        {/* Instructions */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 w-full">
          <div className="flex items-start space-x-3">
            <Icon
              icon="lucide:lightbulb"
              className="text-blue-600 w-5 h-5 mt-0.5 shrink-0"
            />
            <div>
              <h3 className="text-sm font-medium text-blue-800 mb-2">
                How to use:
              </h3>
              <ol className="text-xs text-blue-700 space-y-1 list-decimal list-inside">
                <li>Navigate to any Reddit page (reddit.com)</li>
                <li>Open this sidebar panel</li>
                <li>Configure your download settings</li>
                <li>Click "Start Mass Download" to begin</li>
              </ol>
            </div>
          </div>
        </div>

        {/* Reddit Link */}
        <div className="mt-6">
          <a
            href="https://reddit.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center space-x-2 bg-orange-500 hover:bg-orange-600 text-white px-4 py-2 rounded-lg transition-colors"
          >
            <Icon icon="lucide:external-link" className="w-4 h-4" />
            <span className="text-sm font-medium">Go to Reddit</span>
          </a>
        </div>
      </div>
    );
  }

  return (
    <div
      className="w-full h-full min-h-screen p-4 bg-gradient-to-br from-gray-50 to-white dark:from-gray-900 dark:to-gray-800"
      style={{ minWidth: "300px" }}
    >
      <div className="text-center mb-6">
        <div className="flex justify-center items-center mb-2 relative">
          <div className="w-10 h-10 bg-orange-500 rounded-full flex items-center justify-center">
            <Icon icon="lucide:download" className="text-white w-5 h-5" />
          </div>
          <Button
            onClick={handleToggleDarkMode}
            variant="ghost"
            size="sm"
            className="p-2 absolute right-0"
          >
            <Icon
              icon={isDarkMode ? "lucide:sun" : "lucide:moon"}
              className="w-4 h-4 text-gray-600 dark:text-gray-300"
            />
          </Button>
        </div>
        <h1 className="text-lg font-bold text-gray-800 dark:text-gray-100 mb-1">
          RedditGrab
        </h1>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Grab images and videos from Reddit posts
        </p>
      </div>

      <Form {...form}>
        <div className="space-y-4 mb-6">
          <FormField
            control={form.control}
            name="folderDestination"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Download Folder</FormLabel>
                <FormControl>
                  <input
                    type="text"
                    {...field}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-colors bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    placeholder="Enter folder name"
                  />
                </FormControl>
                <FormDescription>
                  Available: {"{subreddit}"}, {"{date}"}, {"{title}"},
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="text-blue-600 cursor-help">
                          {" {user}"}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          May not work on all pages (works best on subreddit
                          pages)
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="filenamePattern"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Filename Pattern</FormLabel>
                <FormControl>
                  <input
                    type="text"
                    {...field}
                    className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-colors bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    placeholder="{subreddit}_{timestamp}_{filename}"
                  />
                </FormControl>
                <FormDescription>
                  Available: {"{subreddit}"}, {"{timestamp}"}, {"{title}"},{" "}
                  {"{user}"}, {"{filename}"}
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="useGalleryFolders"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none">
                  <FormLabel>Create folders for image galleries</FormLabel>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="addTitleToImages"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none flex items-center gap-1.5">
                  <FormLabel>Embed post title on images</FormLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                          <Icon icon="lucide:info" className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Overlays the post title as a text caption onto the
                          downloaded image
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="addTitleToVideos"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none flex items-center gap-1.5">
                  <FormLabel>Embed post title on videos</FormLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                          <Icon icon="lucide:info" className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Overlays the post title as a text caption onto the
                          downloaded video. Downloads will be slower.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="markDownloadedAsVisited"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none flex items-center gap-1.5">
                  <FormLabel>Mark downloaded posts as visited</FormLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                          <Icon icon="lucide:info" className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">Experimental</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="showDownloadedMarkers"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none flex items-center gap-1.5">
                  <FormLabel>Show downloaded markers on posts</FormLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                          <Icon icon="lucide:info" className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Adds a green corner check to posts you've already
                          downloaded, on feeds and search results
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="forceDownloadProcessed"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none flex items-center gap-1.5">
                  <FormLabel>Force redownload</FormLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                          <Icon icon="lucide:info" className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Ignores your download history during mass download, so
                          posts you've already downloaded get grabbed again.
                          Lets you redownload a page without clearing your
                          history.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="savePostArchive"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                </FormControl>
                <div className="space-y-1 leading-none flex items-center gap-1.5">
                  <FormLabel>Save post text &amp; comments</FormLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                          <Icon icon="lucide:info" className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Saves each post as an HTML page (title, text, images
                          and comments, no ads or sidebars) next to its media.
                          Print it to get a PDF. Mass download on feeds and old
                          Reddit also saves text-only posts.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="requestDelaySeconds"
            render={({ field }) => (
              <FormItem>
                <div className="flex items-center gap-1.5">
                  <FormLabel>Delay between requests (seconds)</FormLabel>
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                          <Icon icon="lucide:info" className="size-3.5" />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p className="text-xs">
                          Waits this long between mass downloads and between
                          post lookups on search pages. Raise it if Reddit
                          stops loading posts partway through.
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
                <FormControl>
                  <input
                    type="number"
                    min={0}
                    max={60}
                    step={0.5}
                    name={field.name}
                    ref={field.ref}
                    onBlur={field.onBlur}
                    value={Number.isFinite(field.value) ? field.value : ""}
                    onChange={(e) => field.onChange(e.target.valueAsNumber)}
                    className="w-24 px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-colors bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="useDateRange"
            render={({ field }) => (
              <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                <FormControl>
                  <Checkbox
                    checked={field.value && !isMediaSearchTab}
                    onCheckedChange={field.onChange}
                    disabled={isMediaSearchTab}
                  />
                </FormControl>
                <div className="space-y-1 leading-none flex items-center gap-1.5">
                  <FormLabel
                    className={
                      isMediaSearchTab
                        ? "text-gray-400 dark:text-gray-500"
                        : undefined
                    }
                  >
                    Filter posts by date range
                  </FormLabel>
                  {isMediaSearchTab && (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="inline-flex text-gray-500 dark:text-gray-400 cursor-help">
                            <Icon icon="lucide:info" className="size-3.5" />
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="text-xs">
                            The search Media tab doesn't show post dates, so date
                            filtering isn't available here. Use the Posts tab to
                            filter by date.
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </FormItem>
            )}
          />

          {form.watch("useDateRange") && !isMediaSearchTab && (
            <div className="space-y-3 ml-6 border-l-2 border-gray-200 pl-4">
              <FormField
                control={form.control}
                name="dateRangeStart"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start Date</FormLabel>
                    <FormControl>
                      <DatePicker
                        {...field}
                        placeholder="Select start date"
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-colors bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="dateRangeEnd"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End Date</FormLabel>
                    <FormControl>
                      <DatePicker
                        {...field}
                        placeholder="Select end date"
                        useEndOfDay={true}
                        className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-colors bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    </FormControl>
                    <FormDescription>
                      Only posts from this date range will be downloaded
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
        </div>
      </Form>

      <div className="mb-3">
        <UrlQueueInput
          value={urlQueueInput}
          onChange={(value) => {
            setUrlQueueInput(value);
            debouncedSaveUrlQueue(value);
          }}
          statuses={queueStatuses}
          disabled={scrapingStatus.isScraping}
        />
      </div>

      <div className="space-y-3">
        {!scrapingStatus.isScraping ? (
          <Button onClick={handleMassScrape} className="w-full">
            <Icon icon="lucide:download" className="w-4 h-4" />
            Start Mass Download
          </Button>
        ) : (
          <Button
            onClick={handleStopScraping}
            variant="destructive"
            className="w-full"
          >
            <Icon icon="lucide:square" className="w-4 h-4" />
            Stop Scraping
          </Button>
        )}
        <p className="text-center text-xs text-gray-500 dark:text-gray-400">
          {scrapingStatus.isScraping
            ? "Auto-scrolling and downloading media posts..."
            : queueStatuses.length > 0 || urlQueueInput.trim()
              ? "This will visit each page in the list and download it"
              : "This will scroll and download all media on the page"}
        </p>
        {!scrapingStatus.isScraping && (
          <div className="space-y-3 pl-1">
            <div className="flex flex-row items-center space-x-2">
              <Checkbox
                id="mass-download-scroll-up"
                checked={massDownloadScrollUp}
                onCheckedChange={(checked) =>
                  setMassDownloadScrollUp(checked === true)
                }
              />
              <label
                htmlFor="mass-download-scroll-up"
                className="text-xs text-gray-500 dark:text-gray-400 leading-none cursor-pointer select-none"
              >
                Scroll up from current post
              </label>
            </div>
            <MassDownloadMediaFilter
              value={massDownloadMediaFilter}
              onValueChange={setMassDownloadMediaFilter}
            />
            <div className="flex flex-row items-center space-x-2">
              <Checkbox
                id="keep-watching"
                checked={keepWatching}
                onCheckedChange={async (checked) => {
                  const value = checked === true;
                  setKeepWatching(value);
                  await keepWatchingStorage.setValue(value);
                }}
              />
              <label
                htmlFor="keep-watching"
                className="text-xs text-gray-500 dark:text-gray-400 leading-none cursor-pointer select-none"
              >
                Keep running after the page runs out
              </label>
            </div>
            <div className="flex flex-row items-center space-x-2">
              <Checkbox
                id="debug-logging"
                checked={debugLogging}
                onCheckedChange={async (checked) => {
                  const value = checked === true;
                  setDebugLogging(value);
                  await debugLoggingStorage.setValue(value);
                }}
              />
              <label
                htmlFor="debug-logging"
                className="text-xs text-gray-500 dark:text-gray-400 leading-none cursor-pointer select-none"
              >
                Debug logging (console)
              </label>
            </div>
          </div>
        )}

        {/* Progress Display */}
        {scrapingStatus.isScraping && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded p-3">
            {queueProgress && (
              <p className="mb-2 text-xs font-medium text-blue-800 dark:text-blue-200 break-all">
                Page {queueProgress.index} of {queueProgress.total}:{" "}
                {queueProgress.label}
              </p>
            )}
            <div className="flex justify-between items-center mb-2">
              <span className="text-sm font-medium text-blue-800 dark:text-blue-200">
                Progress: {scrapingStatus.downloadedCount}/
                {scrapingStatus.totalPostsFound}
              </span>
              <span className="text-xs text-blue-600 dark:text-blue-300">
                {scrapingStatus.totalPostsFound > 0
                  ? Math.round(
                      (scrapingStatus.downloadedCount /
                        scrapingStatus.totalPostsFound) *
                        100,
                    )
                  : 0}
                %
              </span>
            </div>
            <div className="w-full bg-blue-200 rounded-full h-2">
              <div
                className="bg-blue-600 h-2 rounded-full transition-all duration-300"
                style={{
                  width: `${
                    scrapingStatus.totalPostsFound > 0
                      ? (scrapingStatus.downloadedCount /
                          scrapingStatus.totalPostsFound) *
                        100
                      : 0
                  }%`,
                }}
              />
            </div>
            {scrapingStatus.currentPostInfo && (
              <div className="flex items-center justify-center mt-2">
                <Icon
                  icon="lucide:loader-2"
                  className="animate-spin mr-2 size-3 text-blue-600"
                />
                <p className="text-xs text-blue-600">
                  Downloading post {scrapingStatus.currentPostInfo.index} -{" "}
                  {scrapingStatus.currentPostInfo.type} from r/
                  {scrapingStatus.currentPostInfo.subreddit}
                </p>
              </div>
            )}

            {/* What didn't make it. A download that fails is visible here
                rather than only as a count that quietly stops rising. */}
            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs">
              <span className="text-green-700 dark:text-green-400">
                {scrapingStatus.downloadedCount} downloaded
              </span>
              <span
                className={
                  scrapingStatus.failedCount > 0
                    ? "text-red-600 dark:text-red-400 font-medium"
                    : "text-gray-500 dark:text-gray-400"
                }
              >
                {scrapingStatus.failedCount} failed
              </span>
              <span className="text-gray-500 dark:text-gray-400">
                {scrapingStatus.skippedCount} skipped of{" "}
                {scrapingStatus.examinedCount} seen
              </span>
            </div>
            {scrapingStatus.lastFailure && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400 break-all">
                Last failure: {scrapingStatus.lastFailure.postId} —{" "}
                {scrapingStatus.lastFailure.reason}
              </p>
            )}
          </div>
        )}

        {/* Diagnostics export, available during and after a run. */}
        {diagnosticsCount > 0 && (
          <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
            <p className="text-xs text-gray-600 dark:text-gray-300 mb-2">
              {diagnosticsCount} post
              {diagnosticsCount === 1 ? " was" : "s were"} not downloaded this
              run.
            </p>
            <Button
              onClick={handleSaveDiagnostics}
              variant="outline"
              size="sm"
              disabled={isSavingReport}
              className="w-full text-xs"
            >
              {isSavingReport ? (
                <>
                  <Icon
                    icon="lucide:loader-2"
                    className="animate-spin mr-1 size-3"
                  />
                  Saving...
                </>
              ) : (
                <>
                  <Icon icon="lucide:file-text" className="mr-1 size-3" />
                  Save diagnostics report
                </>
              )}
            </Button>
          </div>
        )}
      </div>

      {!scrapingStatus.isScraping && (
        <div className="mt-3 text-center">
          <Button
            onClick={handleClearProcessedPosts}
            variant="link"
            size="sm"
            disabled={isClearingHistory}
            className="text-xs"
          >
            {isClearingHistory ? (
              <>
                <Icon
                  icon="lucide:loader-2"
                  className="animate-spin -ml-1 mr-1 size-4"
                />
                Clearing...
              </>
            ) : (
              "Clear processed posts history"
            )}
          </Button>
        </div>
      )}

      <FAQ />

      <Changelog />

      <SidebarFooter />
    </div>
  );
}

export default SidebarApp;
