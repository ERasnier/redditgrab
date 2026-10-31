import { FFmpeg } from "@ffmpeg/ffmpeg";
import { logger } from "./logger";

import workerURL from "@ffmpeg/ffmpeg/worker?worker&url";

const FFMPEG_OPTIONS = {
  coreURL: browser.runtime.getURL("/ffmpeg/ffmpeg-core.js"),
  wasmURL: browser.runtime.getURL("/ffmpeg/ffmpeg-core.wasm"),
  workerURL: browser.runtime.getURL("/ffmpeg/ffmpeg-core.worker.js"),
  classWorkerURL: new URL(workerURL, import.meta.url).href,
};

/** Log lines kept per instance, enough to hold ffmpeg's actual complaint. */
const LOG_TAIL_SIZE = 40;

/** Give up on a single ffmpeg command rather than hanging the whole run. */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60_000;

/**
 * An ffmpeg instance plus the context needed to explain its failures.
 *
 * `ffmpeg.exec()` does not throw: it returns an exit code, 0 for success.
 * Every call site ignored that and went straight on to read the output file
 * exec was supposed to have produced — so a failed transcode surfaced as
 * `ErrnoError: FS error` from the read, with ffmpeg's actual complaint
 * discarded. That error names neither the operation nor the cause, which is
 * exactly the kind of dead end these diagnostics exist to prevent.
 */
export type FFmpegSession = {
  readonly ffmpeg: FFmpeg;
  /** Run a command; throws with ffmpeg's own output if it fails. */
  run: (args: string[], label: string) => Promise<void>;
  /** Read a file ffmpeg produced; throws clearly if it isn't there. */
  readOutput: (path: string, label: string) => Promise<Uint8Array>;
  /** The most recent ffmpeg log lines. */
  logTail: () => string[];
  terminate: () => void;
};

/** The informative part of ffmpeg's output, with the banner noise dropped. */
const meaningfulLines = (lines: string[]): string[] =>
  lines.filter(
    (line) =>
      line.trim() &&
      !/^\s*(configuration:|lib(av|sw)\w+\s+\d|built with|ffmpeg version)/i.test(
        line,
      ),
  );

export const createFFmpeg = async (): Promise<FFmpegSession> => {
  logger.log("Creating ffmpeg");
  const ffmpeg = new FFmpeg();

  const logLines: string[] = [];
  ffmpeg.on("log", ({ message }) => {
    logLines.push(message);
    if (logLines.length > LOG_TAIL_SIZE) logLines.shift();
    logger.log("FFmpeg:", message);
  });

  await ffmpeg.load(FFMPEG_OPTIONS);
  logger.log("Loaded ffmpeg");

  const logTail = () => [...logLines];

  const run = async (args: string[], label: string) => {
    logLines.length = 0;
    let code: number;
    try {
      code = await ffmpeg.exec(args, DEFAULT_EXEC_TIMEOUT_MS);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ffmpeg ${label} crashed: ${message}`);
    }

    if (code !== 0) {
      // Exit code 1 is also what a timeout reports, per the API docs.
      const detail = meaningfulLines(logLines).slice(-6).join(" | ");
      throw new Error(
        `ffmpeg ${label} failed (exit ${code})${detail ? `: ${detail}` : " with no output"}`,
      );
    }
  };

  const readOutput = async (path: string, label: string) => {
    try {
      return (await ffmpeg.readFile(path)) as Uint8Array;
    } catch (error) {
      // Reaching here means exec reported success but produced nothing, so the
      // log is the only clue left.
      const detail = meaningfulLines(logLines).slice(-6).join(" | ");
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ffmpeg ${label} produced no ${path} (${message})${detail ? `: ${detail}` : ""}`,
      );
    }
  };

  return {
    ffmpeg,
    run,
    readOutput,
    logTail,
    terminate: () => ffmpeg.terminate(),
  };
};
