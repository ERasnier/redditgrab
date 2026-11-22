import { useEffect, useRef, useState } from "react";
import { sendMessage } from "webext-bridge/popup";
import { Button } from "@/components/ui/button";
import { HISTORY_FILE_NAME, importHistoryFromFile } from "@/utils/download-history";
import { logger } from "@/utils/logger";

type Notice = { kind: "ok" | "warn" | "error"; text: string };
const noticeClass: Record<Notice["kind"], string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-400",
};

/**
 * The record of every downloaded post, kept as a SQLite file in the
 * extension's folder and read back on every start, so the "already
 * downloaded" list survives Firefox wiping the extension's storage.
 */
export const HistoryPanel = ({
  disabled,
  onImported,
}: {
  disabled: boolean;
  /** Called after an import changes the processed list. */
  onImported: () => void;
}) => {
  const [records, setRecords] = useState<number | null>(null);
  const [startupText, setStartupText] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      const status = await sendMessage("HISTORY_STATUS", undefined, "background");
      setRecords(status.records);
      const startup = status.startup;
      setStartupText(
        startup.status === "imported"
          ? `Restored at start from ${HISTORY_FILE_NAME}: ${startup.records} posts, ${startup.restoredIds} put back in the processed list.`
          : startup.status === "failed"
            ? `Couldn't read ${HISTORY_FILE_NAME} at start: ${startup.error}`
            : startup.status === "none"
              ? `No ${HISTORY_FILE_NAME} in the extension folder yet. Save it once to start keeping it.`
              : null,
      );
    } catch {
      // Background not ready yet; the next refresh will catch up.
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const run = async (task: () => Promise<Notice>) => {
    setBusy(true);
    try {
      setNotice(await task());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("History action failed:", error);
      setNotice({ kind: "error", text: message });
    } finally {
      setBusy(false);
      void refresh();
    }
  };

  const saveNow = () =>
    run(async () => {
      const result = await sendMessage("HISTORY_WRITE", undefined, "background");
      return result.readable
        ? {
            kind: "ok",
            text: `Saved ${result.records} posts to ${result.savedTo}. It will be read back automatically when Firefox starts.`,
          }
        : {
            kind: "warn",
            text:
              `Saved ${result.records} posts to ${result.savedTo}, but the extension can't read it from there, so it won't restore automatically. ` +
              `Set "Extension folder" under Presets to the folder you loaded the extension from, and save again.`,
          };
    });

  const importFile = (file: File) =>
    run(async () => {
      const result = await importHistoryFromFile(file);
      onImported();
      // Fold the import into the file on disk straight away.
      await sendMessage("HISTORY_WRITE", undefined, "background");
      return {
        kind: "ok",
        text: `Imported ${result.records} posts from ${file.name}; ${result.restoredIds} were new to the processed list.`,
      };
    });

  const off = disabled || busy;

  return (
    <details className="rounded border border-gray-200 dark:border-gray-700 p-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-gray-700 dark:text-gray-300">
        Download history{records !== null ? ` · ${records.toLocaleString()} posts` : ""}
      </summary>
      <div className="mt-2 space-y-2">
        <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          Every downloaded post is recorded — link, subreddit, title, media
          links and where the files were saved — in {HISTORY_FILE_NAME} in the
          extension folder (set under Presets). It&apos;s updated a few minutes
          after each download and at the end of every run, and read back
          whenever Firefox starts. It&apos;s a normal SQLite database you can
          open with other tools.
        </p>
        {startupText && (
          <p className="text-[11px] leading-snug text-gray-600 dark:text-gray-300">
            {startupText}
          </p>
        )}
        <div className="flex gap-1.5">
          <Button size="sm" className="flex-1" onClick={saveNow} disabled={off}>
            Save history file now
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => fileInput.current?.click()}
            disabled={off}
          >
            Import…
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept=".sqlite,.db,.sqlite3,.txt,.csv,.jsonl,.json,.log"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </div>
        <p className="text-[10px] leading-snug text-gray-500 dark:text-gray-400">
          Import takes a history .sqlite file, or any text file with Reddit
          post links or t3_ ids in it (a retry list, a run log, a link list).
        </p>
        {notice && (
          <p className={`text-[11px] leading-snug ${noticeClass[notice.kind]}`}>{notice.text}</p>
        )}
      </div>
    </details>
  );
};
