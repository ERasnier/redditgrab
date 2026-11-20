import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  applySettings,
  exportPresets,
  importPresetFile,
  parsePresetFile,
  PRESET_FILE_NAME,
  readCurrentSettings,
  type ExportResult,
} from "@/utils/presets";
import {
  namedPresets as namedPresetsStorage,
  presetFolder as presetFolderStorage,
  type NamedPreset,
} from "@/utils/storage";
import { logger } from "@/utils/logger";

/** Setting edits are saved half a second after typing stops; let them land. */
const waitForPendingSaves = () => new Promise((resolve) => setTimeout(resolve, 600));

type Notice = { kind: "ok" | "warn" | "error"; text: string };

const noticeClass: Record<Notice["kind"], string> = {
  ok: "text-green-700 dark:text-green-400",
  warn: "text-amber-700 dark:text-amber-300",
  error: "text-red-700 dark:text-red-400",
};

/**
 * Save the sidebar's settings under names, export them to a file, and import
 * them back. The export goes into the extension's own folder, which the
 * extension checks every time it starts, so settings survive Firefox wiping a
 * temporary add-on's storage.
 */
export const PresetsPanel = ({
  disabled,
  onApplied,
  startupNotice,
}: {
  /** True while a run is going: settings shouldn't change under it. */
  disabled: boolean;
  /** Called after settings change, so the sidebar reloads them. */
  onApplied: () => void;
  /** What the automatic import did when the sidebar opened, if anything. */
  startupNotice: string | null;
}) => {
  const [presets, setPresets] = useState<NamedPreset[]>([]);
  const [selected, setSelected] = useState("");
  const [newName, setNewName] = useState("");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastExport, setLastExport] = useState<ExportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const reload = async () => {
    const list = await namedPresetsStorage.getValue();
    setPresets(list);
    setSelected((current) =>
      list.some((preset) => preset.name === current) ? current : (list[0]?.name ?? ""),
    );
  };

  useEffect(() => {
    void reload();
    void presetFolderStorage.getValue().then(setFolder);
  }, []);

  const run = async (task: () => Promise<Notice>) => {
    setBusy(true);
    try {
      setNotice(await task());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Preset action failed:", error);
      setNotice({ kind: "error", text: message });
    } finally {
      setBusy(false);
    }
  };

  const saveCurrent = () =>
    run(async () => {
      const name = newName.trim();
      if (!name) return { kind: "warn", text: "Give the preset a name first." };
      await waitForPendingSaves();
      const settings = await readCurrentSettings();
      const list = await namedPresetsStorage.getValue();
      const replaced = list.some((preset) => preset.name === name);
      const next = [
        ...list.filter((preset) => preset.name !== name),
        { name, savedAt: Date.now(), settings },
      ];
      await namedPresetsStorage.setValue(next);
      setNewName("");
      await reload();
      setSelected(name);
      return {
        kind: "ok",
        text: `${replaced ? "Updated" : "Saved"} "${name}". Export to keep it after Firefox restarts.`,
      };
    });

  const applySelected = () =>
    run(async () => {
      const preset = presets.find((p) => p.name === selected);
      if (!preset) return { kind: "warn", text: "Choose a preset to apply." };
      const { skipped } = await applySettings(preset.settings);
      onApplied();
      return {
        kind: skipped.length ? "warn" : "ok",
        text:
          `Applied "${preset.name}".` +
          (skipped.length ? ` Skipped values this version doesn't use: ${skipped.join(", ")}.` : ""),
      };
    });

  const deleteSelected = () =>
    run(async () => {
      const list = await namedPresetsStorage.getValue();
      await namedPresetsStorage.setValue(list.filter((p) => p.name !== selected));
      await reload();
      return { kind: "ok", text: `Deleted "${selected}".` };
    });

  const exportAll = () =>
    run(async () => {
      await presetFolderStorage.setValue(folder.trim());
      await waitForPendingSaves();
      const result = await exportPresets();
      setLastExport(result);
      return result.autoImportReady
        ? {
            kind: "ok",
            text: `Exported to ${result.savedTo}. The extension can read it there, so it will import it automatically after a restart.`,
          }
        : {
            kind: "warn",
            text:
              `Exported to ${result.savedTo}, but the extension can't read it from there, so it won't import automatically. ` +
              `Set "Extension folder" to the folder you loaded the extension from (inside your Downloads folder) and export again, ` +
              `or move ${PRESET_FILE_NAME} into that folder.`,
          };
    });

  const importChosenFile = (file: File) =>
    run(async () => {
      const parsed = parsePresetFile(await file.text());
      const { presets: count, skipped } = await importPresetFile(parsed);
      await reload();
      onApplied();
      return {
        kind: skipped.length ? "warn" : "ok",
        text:
          `Imported ${count} preset(s) and the settings saved with them (exported ${new Date(parsed.exportedAt).toLocaleString()}).` +
          (skipped.length ? ` Skipped: ${skipped.join(", ")}.` : ""),
      };
    });

  const off = disabled || busy;

  return (
    <details className="rounded border border-gray-200 dark:border-gray-700 p-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-gray-700 dark:text-gray-300">
        Presets{presets.length ? ` · ${presets.length} saved` : ""}
      </summary>
      <div className="mt-2 space-y-3">
        {startupNotice && (
          <p className="text-[11px] text-green-700 dark:text-green-400">{startupNotice}</p>
        )}
        <p className="text-[11px] leading-snug text-gray-500 dark:text-gray-400">
          A preset holds the download folder, filename pattern, every checkbox,
          the request delay and the pages to download list.
        </p>

        <div className="space-y-1.5">
          <div className="flex gap-1.5">
            <select
              aria-label="Saved presets"
              className="min-w-0 flex-1 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-900 dark:text-gray-100"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              disabled={off || presets.length === 0}
            >
              {presets.length === 0 && <option value="">No presets saved yet</option>}
              {presets.map((preset) => (
                <option key={preset.name} value={preset.name}>
                  {preset.name}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={applySelected} disabled={off || !selected}>
              Apply
            </Button>
            <Button size="sm" variant="outline" onClick={deleteSelected} disabled={off || !selected}>
              Delete
            </Button>
          </div>
          <div className="flex gap-1.5">
            <Input
              aria-label="New preset name"
              placeholder="Name for current settings"
              className="h-8 text-xs"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              disabled={off}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveCurrent();
              }}
            />
            <Button size="sm" variant="outline" onClick={saveCurrent} disabled={off}>
              Save
            </Button>
          </div>
        </div>

        <div className="space-y-1.5 border-t border-gray-200 dark:border-gray-700 pt-2">
          <label
            htmlFor="preset-folder"
            className="block text-[11px] font-medium text-gray-600 dark:text-gray-400"
          >
            Extension folder (inside your Downloads folder)
          </label>
          <Input
            id="preset-folder"
            className="h-8 text-xs"
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            disabled={off}
          />
          <div className="flex gap-1.5">
            <Button size="sm" className="flex-1" onClick={exportAll} disabled={off}>
              Export presets
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1"
              onClick={() => fileInput.current?.click()}
              disabled={off}
            >
              Import from file…
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void importChosenFile(file);
              }}
            />
          </div>
          {lastExport?.autoImportReady && (
            <p className="text-[11px] text-gray-500 dark:text-gray-400">
              Auto-import is set up: {PRESET_FILE_NAME} is in the extension folder.
            </p>
          )}
        </div>

        {notice && (
          <p className={`text-[11px] leading-snug ${noticeClass[notice.kind]}`}>{notice.text}</p>
        )}
      </div>
    </details>
  );
};
