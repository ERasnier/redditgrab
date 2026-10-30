import { useMemo } from "react";
import { Icon } from "@iconify/react";
import { parseUrlQueue } from "@/utils/url-queue";

export type QueueEntryStatus = "pending" | "active" | "done" | "failed";

const STATUS_ICON: Record<QueueEntryStatus, string> = {
  pending: "lucide:circle",
  active: "lucide:loader-2",
  done: "lucide:check-circle-2",
  failed: "lucide:x-circle",
};

const STATUS_CLASS: Record<QueueEntryStatus, string> = {
  pending: "text-gray-400 dark:text-gray-500",
  active: "text-blue-600 dark:text-blue-400 animate-spin",
  done: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
};

type Props = {
  value: string;
  onChange: (value: string) => void;
  /** Per-entry status while a run is in progress; empty when idle. */
  statuses: QueueEntryStatus[];
  disabled?: boolean;
};

/**
 * The list of pages a mass download should work through.
 *
 * Accepts whatever shape people paste — full URLs, `r/pics`, `u/someone`, bare
 * subreddit names, with or without bullets — and shows what each line resolved
 * to, so a typo is visible before the run rather than discovered halfway
 * through it. Left empty, the download just works on the current page as it
 * always has.
 */
export function UrlQueueInput({
  value,
  onChange,
  statuses,
  disabled = false,
}: Props) {
  const { entries, errors, duplicates } = useMemo(
    () => parseUrlQueue(value),
    [value],
  );

  const hasInput = value.trim().length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label
          htmlFor="url-queue"
          className="text-sm font-medium text-gray-700 dark:text-gray-200"
        >
          Pages to download
        </label>
        {entries.length > 0 && (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            {entries.length} page{entries.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <textarea
        id="url-queue"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
        rows={5}
        spellCheck={false}
        placeholder={"r/pics\nr/aww/top/?t=month\nhttps://old.reddit.com/r/woodworking/\nu/someone"}
        className="w-full px-2 py-1.5 text-xs font-mono border border-gray-300 dark:border-gray-600 rounded focus:ring-2 focus:ring-orange-500 focus:border-transparent transition-colors bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-60 resize-y"
      />

      <p className="text-xs text-gray-500 dark:text-gray-400">
        One per line. Firefox visits each in turn and downloads it before moving
        on. Leave empty to download the page you&apos;re on.
      </p>

      {/* What each line resolved to, with live status during a run. */}
      {entries.length > 0 && (
        <ul className="space-y-1">
          {entries.map((entry, index) => {
            const status = statuses[index] ?? "pending";
            return (
              <li
                key={entry.url}
                className="flex items-start gap-1.5 text-xs text-gray-600 dark:text-gray-300"
              >
                <Icon
                  icon={STATUS_ICON[status]}
                  className={`mt-0.5 size-3 shrink-0 ${STATUS_CLASS[status]}`}
                />
                <span
                  className={
                    status === "active"
                      ? "font-medium text-blue-700 dark:text-blue-300"
                      : undefined
                  }
                  title={entry.url}
                >
                  {entry.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {duplicates > 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {duplicates} duplicate{duplicates === 1 ? "" : "s"} ignored.
        </p>
      )}

      {errors.length > 0 && (
        <div className="rounded border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-900/20 p-2">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-200 mb-1">
            {errors.length} line{errors.length === 1 ? "" : "s"} will be skipped:
          </p>
          <ul className="space-y-0.5">
            {errors.slice(0, 5).map((error) => (
              <li
                key={`${error.line}-${error.text}`}
                className="text-xs text-amber-700 dark:text-amber-300 break-all"
              >
                Line {error.line}: {error.text} — {error.reason}
              </li>
            ))}
            {errors.length > 5 && (
              <li className="text-xs text-amber-700 dark:text-amber-300">
                …and {errors.length - 5} more.
              </li>
            )}
          </ul>
        </div>
      )}

      {hasInput && entries.length === 0 && errors.length === 0 && (
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Nothing usable in the list yet.
        </p>
      )}
    </div>
  );
}
