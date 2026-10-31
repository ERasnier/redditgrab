import { fetchFile } from "@ffmpeg/util";
import { logger } from "./logger";

/**
 * Add text overlay to an image
 * @param imageBlob - The original image blob
 * @param text - The text to overlay
 * @returns Promise<Blob> - The modified image as a blob
 */
export async function addTextToImage(
  imageBlob: Blob,
  text: string
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";

    // Hoisted so cleanup can reach them. A 4000x3000 source means a 48MB RGBA
    // backing store per canvas; left to the GC these pile up across a gallery.
    let tempCanvas: HTMLCanvasElement | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let objectUrl: string | null = null;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl);
        } catch {}
        objectUrl = null;
      }
      // Detach the decoded bitmap.
      img.onload = null;
      img.onerror = null;
      img.src = "";
      // Zeroing the dimensions frees the backing store now, rather than
      // whenever the GC gets round to the detached canvas.
      if (tempCanvas) {
        tempCanvas.width = 0;
        tempCanvas.height = 0;
        tempCanvas = null;
      }
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
    };

    img.onload = () => {
      try {
        // Calculate font size based on image width (responsive text)
        const fontSize = Math.max(24, Math.min(48, img.width / 20));
        const lineHeight = fontSize * 1.2;
        const padding = 16;

        // Word wrap for long titles to calculate needed height
        const maxWidth = img.width * 0.9;
        const words = text.split(" ");
        const lines: string[] = [];
        let currentLine = words[0];

        // Create temporary canvas to measure text
        const measureCanvas = document.createElement("canvas");
        tempCanvas = measureCanvas;
        const tempCtx = measureCanvas.getContext("2d")!;
        tempCtx.font = `bold ${fontSize}px Arial, sans-serif`;

        for (let i = 1; i < words.length; i++) {
          const word = words[i];
          const width = tempCtx.measureText(currentLine + " " + word).width;
          if (width < maxWidth) {
            currentLine += " " + word;
          } else {
            lines.push(currentLine);
            currentLine = word;
          }
        }
        lines.push(currentLine);

        // Calculate text area height
        const textAreaHeight = lines.length * lineHeight + padding * 2;

        // Create a canvas with extra height for text
        const outCanvas = document.createElement("canvas");
        canvas = outCanvas;
        outCanvas.width = img.width;
        outCanvas.height = img.height + textAreaHeight;
        const ctx = outCanvas.getContext("2d")!;

        // Fill the text area with white background
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, outCanvas.width, textAreaHeight);

        // Draw the original image below the text area
        ctx.drawImage(img, 0, textAreaHeight);

        // Set up text styling
        ctx.font = `bold ${fontSize}px Arial, sans-serif`;
        ctx.fillStyle = "black"; // Dark text on white background
        ctx.textAlign = "center";

        // Draw text lines in the white area
        const startY = padding + fontSize;

        lines.forEach((line, index) => {
          const y = startY + index * lineHeight;
          ctx.fillText(line, outCanvas.width / 2, y);
        });

        // Convert canvas to blob
        outCanvas.toBlob(
          (blob) => {
            // Release the source URL and both canvases before settling, so the
            // caller never holds the originals alongside the result.
            cleanup();
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error("Failed to create blob from canvas"));
            }
          },
          "image/png",
          0.95
        );
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    img.onerror = () => {
      cleanup();
      reject(new Error("Failed to load image"));
    };

    // Create object URL from blob and set as image source
    objectUrl = URL.createObjectURL(imageBlob);
    img.src = objectUrl;
  });
}

/**
 * Add text overlay to a video using FFmpeg
 * @param videoBlob - The original video blob
 * @param text - The text to overlay
 * @returns Promise<Blob> - The modified video as a blob
 */
export async function addTextToVideo(
  videoBlob: Blob,
  text: string
): Promise<Blob> {
  const { ffmpeg, run, readOutput, terminate } = await createFFmpeg();

  try {
    const videoData = new Uint8Array(await videoBlob.arrayBuffer());

    await ffmpeg.writeFile("input.mp4", videoData);

    try {
      const fontResponse = await fetchFile("/OpenSans-Bold.ttf");
      await ffmpeg.writeFile("OpenSans-Bold.ttf", new Uint8Array(fontResponse));
    } catch (e) {
      console.error("Could not load OpenSans font:", e);
      throw new Error("Font file required for video text overlay");
    }

    // Helper function to calculate sizing based on text length
    const calculateTextDimensions = (textLength: number) => {
      if (textLength > 80) {
        return { boxHeight: 150, fontSize: 28, maxCharsPerLine: 30 };
      } else if (textLength > 50) {
        return { boxHeight: 120, fontSize: 28, maxCharsPerLine: 30 };
      } else if (textLength > 30) {
        return { boxHeight: 100, fontSize: 28, maxCharsPerLine: 30 };
      } else {
        return { boxHeight: 90, fontSize: 32, maxCharsPerLine: 30 };
      }
    };

    // Helper function to wrap text into multiple lines with better logic
    const wrapTextIntoLines = (
      text: string,
      maxCharsPerLine: number
    ): string[] => {
      const words = text.split(" ");
      const lines: string[] = [];
      let currentLine = "";

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;

        if (testLine.length > maxCharsPerLine && currentLine.length > 0) {
          if (currentLine.length >= maxCharsPerLine * 0.8) {
            lines.push(currentLine.trim());
            currentLine = word;
          } else {
            currentLine = testLine;
          }
        } else {
          currentLine = testLine;
        }
      }

      if (currentLine.trim()) {
        lines.push(currentLine.trim());
      }

      return lines;
    };

    // Calculate dimensions and wrap text
    const textLength = text.length;
    const { boxHeight, fontSize, maxCharsPerLine } =
      calculateTextDimensions(textLength);
    const textLines = wrapTextIntoLines(text, maxCharsPerLine);

    const drawtextFilters = await Promise.all(
      textLines.map(async (line, index) => {
        await ffmpeg.writeFile(`temp${index}.txt`, line);
        const startY =
          (boxHeight / textLines.length) *
          Math.max(index, textLines.length === 1 ? 0.4 : 0.2);

        return `drawtext=textfile=${`temp${index}.txt`}:fontcolor=black:fontsize=${fontSize}:x=(w-text_w)/2:y=${startY}:fontfile=OpenSans-Bold.ttf`;
      })
    );

    // Create FFmpeg filter complex using pad to add white space at top
    const filterComplex = [
      `pad=iw:ih+${boxHeight}:0:${boxHeight}:white`,
      ...drawtextFilters,
    ].join(",");

    await run(
      [
        "-i",
        "input.mp4",
        "-vf",
        filterComplex,
        "-c:a",
        "copy", // Copy audio without re-encoding
        "-c:v",
        "libx264", // Use H.264 codec
        "-preset",
        "ultrafast", // Fastest encoding preset
        "-crf",
        "28", // Lower quality for speed (18-28 range, higher = faster)
        "-movflags",
        "+faststart", // Optimize for web playback
        "-threads",
        "0", // Use all available CPU threads
        "output.mp4",
      ],
      "video title overlay",
    );

    const data = await readOutput("output.mp4", "video title overlay");

    for (const file of [
      "input.mp4",
      "output.mp4",
      "OpenSans-Bold.ttf",
      ...textLines.map((_, index) => `temp${index}.txt`),
    ]) {
      try {
        await ffmpeg.deleteFile(file);
      } catch {}
    }

    return new Blob([data as BlobPart], { type: "video/mp4" });
  } catch (error) {
    logger.error("FFmpeg video processing failed:", error);
    throw error;
  } finally {
    terminate();
  }
}
