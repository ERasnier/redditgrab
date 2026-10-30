import { useState } from "react";

export const useScrapingProgress = () => {
  const [scrapingStatus, setScrapingStatus] = useState({
    isScraping: false,
    downloadedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    examinedCount: 0,
    totalPostsFound: 0,
    currentBatchCount: 0,
    currentPostId: null as string | null,
    lastFailure: null as { postId: string; reason: string } | null,
    currentPostInfo: null as {
      index: number;
      type: string;
      subreddit: string;
    } | null,
  });

  const startScraping = () => {
    setScrapingStatus((prev) => ({
      ...prev,
      isScraping: true,
      downloadedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      examinedCount: 0,
      totalPostsFound: 0,
      currentBatchCount: 0,
      lastFailure: null,
      currentPostInfo: null,
    }));
  };

  const stopScraping = () => {
    setScrapingStatus((prev) => ({ ...prev, isScraping: false }));
  };

  const setCurrentBatchCount = (currentBatchCount: number) => {
    setScrapingStatus((prev) => ({ ...prev, currentBatchCount }));
  };

  const incrementDownloadCount = () => {
    setScrapingStatus((prev) => ({
      ...prev,
      downloadedCount: prev.downloadedCount + 1,
    }));
  };

  const addToTotalPostsFound = (count: number) => {
    setScrapingStatus((prev) => ({
      ...prev,
      totalPostsFound: prev.totalPostsFound + count,
    }));
  };

  /** A download was attempted and did not land. */
  const recordFailure = (postId: string, reason: string) => {
    setScrapingStatus((prev) => ({
      ...prev,
      failedCount: prev.failedCount + 1,
      lastFailure: { postId, reason },
    }));
  };

  /** Posts the scan looked at but never turned into a download candidate. */
  const addScanTotals = (skipped: number, examined: number) => {
    setScrapingStatus((prev) => ({
      ...prev,
      skippedCount: prev.skippedCount + skipped,
      examinedCount: prev.examinedCount + examined,
    }));
  };

  const setCurrentPostInfo = (
    postInfo: { index: number; type: string; subreddit: string } | null
  ) => {
    setScrapingStatus((prev) => ({
      ...prev,
      currentPostInfo: postInfo,
    }));
  };

  return {
    scrapingStatus,
    startScraping,
    stopScraping,
    setCurrentBatchCount,
    incrementDownloadCount,
    addToTotalPostsFound,
    setCurrentPostInfo,
    recordFailure,
    addScanTotals,
  };
};
