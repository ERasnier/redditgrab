import { logger } from "./logger";
import { readExtensionFolderFile, writeExtensionFolderFile } from "./extension-folder";
import * as stored from "./storage";

/**
 * Presets: the sidebar's settings, saved under names, exported to a file and
 * read back automatically.
 *
 * Why a file the extension reads by itself: a temporarily loaded add-on loses
 * all of its storage when Firefox closes (it is unloaded, and unloading clears
 * storage.local). An extension can't read arbitrary files, but it can read its
 * own folder, so the export is written into the folder the extension was
 * loaded from, and every start checks for it there.
 */

export const PRESET_FILE_NAME = "redditgrab-presets.json";
const FORMAT = "redditgrab-presets";
const VERSION = 1;

/**
 * Every setting a preset carries, with the storage item behind it and a check
 * on the value, so a hand-edited or older file can't put a wrong type into
 * storage. Not included: the download history, the page-list progress and
 * this preset machinery itself.
 */
const FIELDS = {
  folderDestination: { item: stored.folderDestination, ok: isString },
  filenamePattern: { item: stored.filenamePattern, ok: isString },
  useGalleryFolders: { item: stored.useGalleryFolders, ok: isBoolean },
  addTitleToImages: { item: stored.addTitleToImages, ok: isBoolean },
  addTitleToVideos: { item: stored.addTitleToVideos, ok: isBoolean },
  markDownloadedAsVisited: { item: stored.markDownloadedAsVisited, ok: isBoolean },
  showDownloadedMarkers: { item: stored.showDownloadedMarkers, ok: isBoolean },
  forceDownloadProcessed: { item: stored.forceDownloadProcessed, ok: isBoolean },
  requestDelaySeconds: { item: stored.requestDelaySeconds, ok: isDelay },
  savePostArchive: { item: stored.savePostArchive, ok: isBoolean },
  useDateRange: { item: stored.useDateRange, ok: isBoolean },
  dateRangeStart: { item: stored.dateRangeStart, ok: isString },
  dateRangeEnd: { item: stored.dateRangeEnd, ok: isString },
  keepWatching: { item: stored.keepWatching, ok: isBoolean },
  debugLogging: { item: stored.debugLogging, ok: isBoolean },
  verifyDownloads: { item: stored.verifyDownloads, ok: isBoolean },
  freeMemoryDuringRuns: { item: stored.freeMemoryDuringRuns, ok: isBoolean },
  clearFinishedDownloads: { item: stored.clearFinishedDownloads, ok: isBoolean },
  massDownloadMediaFilter: { item: stored.massDownloadMediaFilter, ok: isMediaFilter },
  massDownloadScrollUp: { item: stored.massDownloadScrollUp, ok: isBoolean },
  urlQueueText: { item: stored.urlQueueText, ok: isString },
  darkMode: { item: stored.darkMode, ok: isBoolean },
} as const;

type FieldName = keyof typeof FIELDS;
export type PresetSettings = Partial<Record<FieldName, unknown>>;

function isString(value: unknown): value is string {
  return typeof value === "string";
}
function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}
function isDelay(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 600;
}
function isMediaFilter(value: unknown): value is "all" | "images" | "videos" {
  return value === "all" || value === "images" || value === "videos";
}

export type PresetFile = {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  /** The settings in use when the file was exported; applied on import. */
  active: PresetSettings;
  presets: stored.NamedPreset[];
};

/** The settings as they are now. */
export const readCurrentSettings = async (): Promise<PresetSettings> => {
  const entries = await Promise.all(
    (Object.keys(FIELDS) as FieldName[]).map(
      async (name) => [name, await FIELDS[name].item.getValue()] as const,
    ),
  );
  return Object.fromEntries(entries);
};

/**
 * Write a preset's settings into storage. Unknown keys and wrong types are
 * skipped, and the names of anything skipped are returned.
 */
export const applySettings = async (settings: PresetSettings) => {
  const skipped: string[] = [];
  for (const [name, value] of Object.entries(settings ?? {})) {
    const field = FIELDS[name as FieldName];
    if (!field || !field.ok(value)) {
      skipped.push(name);
      continue;
    }
    // Each field's check guarantees the value suits its item.
    await (field.item as { setValue: (v: unknown) => Promise<void> }).setValue(value);
  }
  if (skipped.length) logger.warn(`Preset values skipped: ${skipped.join(", ")}`);
  return { skipped };
};

const isPresetFile = (value: unknown): value is PresetFile => {
  const file = value as Partial<PresetFile> | null;
  return (
    !!file &&
    file.format === FORMAT &&
    typeof file.exportedAt === "number" &&
    typeof file.active === "object" &&
    Array.isArray(file.presets)
  );
};

/** Parse and check a preset file's text; throws with a readable reason. */
export const parsePresetFile = (text: string): PresetFile => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the file isn't valid JSON");
  }
  if (!isPresetFile(parsed)) {
    throw new Error("the file isn't a RedditGrab preset file");
  }
  if (parsed.version > VERSION) {
    logger.warn(`Preset file version ${parsed.version} is newer than this build; importing what it recognises.`);
  }
  return {
    ...parsed,
    presets: parsed.presets.filter(
      (preset) =>
        preset &&
        typeof preset.name === "string" &&
        preset.name.trim() !== "" &&
        typeof preset.settings === "object",
    ),
  };
};

/**
 * Bring a preset file in: its named presets are merged with the ones here (the
 * file wins on a name clash) and its active settings applied.
 */
export const importPresetFile = async (file: PresetFile) => {
  const local = await stored.namedPresets.getValue();
  const byName = new Map(local.map((preset) => [preset.name, preset]));
  for (const preset of file.presets) byName.set(preset.name, preset);
  await stored.namedPresets.setValue([...byName.values()]);
  const { skipped } = await applySettings(file.active);
  await stored.presetsSyncedAt.setValue(file.exportedAt);
  logger.always(
    `Imported presets exported ${new Date(file.exportedAt).toLocaleString()}: ${file.presets.length} named preset(s)`,
  );
  return { presets: file.presets.length, skipped };
};

/** The preset file in the extension's own folder, if there is one. */
export const readBundledPresetFile = async (): Promise<PresetFile | null> => {
  const response = await readExtensionFolderFile(PRESET_FILE_NAME);
  if (!response) return null;
  try {
    return parsePresetFile(await response.text());
  } catch (error) {
    logger.error(`Found ${PRESET_FILE_NAME} but could not read it:`, error);
    return null;
  }
};

export type AutoImportResult =
  | { status: "none" }
  | { status: "up-to-date"; exportedAt: number }
  | { status: "imported"; exportedAt: number; presets: number };

/**
 * Import the preset file in the extension's folder if it's newer than what was
 * last exported or imported here — which, after Firefox has wiped the
 * extension's storage, is any file at all.
 */
export const autoImportPresets = async (): Promise<AutoImportResult> => {
  const file = await readBundledPresetFile();
  if (!file) return { status: "none" };
  const syncedAt = await stored.presetsSyncedAt.getValue();
  if (syncedAt !== null && file.exportedAt <= syncedAt) {
    return { status: "up-to-date", exportedAt: file.exportedAt };
  }
  const { presets } = await importPresetFile(file);
  return { status: "imported", exportedAt: file.exportedAt, presets };
};

export type ExportResult = {
  /** Where Firefox wrote the file. */
  savedTo: string;
  /** Whether the extension can read it back, i.e. auto-import will work. */
  autoImportReady: boolean;
};

/** The JSON text of a preset file holding the current settings and presets. */
export const buildPresetFile = async (): Promise<PresetFile> => ({
  format: FORMAT,
  version: VERSION,
  exportedAt: Date.now(),
  active: await readCurrentSettings(),
  presets: await stored.namedPresets.getValue(),
});

/**
 * Write the preset file into the extension's folder, then read it back to
 * check that auto-import will find it.
 */
export const exportPresets = async (): Promise<ExportResult> => {
  const file = await buildPresetFile();
  const savedTo = await writeExtensionFolderFile(
    PRESET_FILE_NAME,
    new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
  );
  await stored.presetsSyncedAt.setValue(file.exportedAt);
  const readBack = await readBundledPresetFile();
  return {
    savedTo,
    autoImportReady: readBack?.exportedAt === file.exportedAt,
  };
};
