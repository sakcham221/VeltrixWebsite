import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const app = express();

const PORT = process.env.PORT || 3000;

/*
|--------------------------------------------------------------------------
| Environment configuration
|--------------------------------------------------------------------------
*/

const FRONTEND_URL = process.env.FRONTEND_URL || "*";
const BACKEND_URL = process.env.BACKEND_URL || "";

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(
  cors({
    origin:
      FRONTEND_URL === "*"
        ? true
        : FRONTEND_URL.split(",")
            .map((url) => url.trim())
            .filter(Boolean),

    methods: ["GET", "POST", "OPTIONS"],

    allowedHeaders: ["Content-Type"],

    credentials: false,
  })
);

app.use(express.json({ limit: "1mb" }));

/*
|--------------------------------------------------------------------------
| Temporary in-memory jobs
|--------------------------------------------------------------------------
|
| No database.
|
| Job information exists only temporarily in RAM.
| Downloaded files are stored temporarily on the server and deleted
| automatically.
|
|--------------------------------------------------------------------------
*/

const jobs = new Map();

const JOB_TTL = 15 * 60 * 1000;

/*
|--------------------------------------------------------------------------
| Periodic cleanup
|--------------------------------------------------------------------------
*/

function cleanupJobs() {
  const now = Date.now();

  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL) {
      removeJobFiles(job);

      jobs.delete(jobId);
    }
  }
}

setInterval(cleanupJobs, 60 * 1000);

/*
|--------------------------------------------------------------------------
| Remove temporary files
|--------------------------------------------------------------------------
*/

function removeJobFiles(job) {
  if (!job) {
    return;
  }

  try {
    if (job.outputPath && fs.existsSync(job.outputPath)) {
      fs.unlinkSync(job.outputPath);
    }
  } catch (error) {
    console.error("File cleanup error:", error.message);
  }

  try {
    if (job.outputDir && fs.existsSync(job.outputDir)) {
      fs.rmSync(job.outputDir, {
        recursive: true,
        force: true,
      });
    }
  } catch (error) {
    console.error("Directory cleanup error:", error.message);
  }
}

/*
|--------------------------------------------------------------------------
| URL validation
|--------------------------------------------------------------------------
*/

function isValidUrl(value) {
  try {
    const parsed = new URL(value);

    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:"
    );
  } catch {
    return false;
  }
}

/*
|--------------------------------------------------------------------------
| Detect supported source
|--------------------------------------------------------------------------
*/

function detectSource(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();

    /*
     * YouTube
     */
    if (
      hostname === "youtube.com" ||
      hostname === "www.youtube.com" ||
      hostname === "m.youtube.com" ||
      hostname === "music.youtube.com" ||
      hostname === "youtu.be" ||
      hostname.endsWith(".youtube.com")
    ) {
      return "youtube";
    }

    /*
     * Instagram
     */
    if (
      hostname === "instagram.com" ||
      hostname === "www.instagram.com" ||
      hostname === "m.instagram.com" ||
      hostname.endsWith(".instagram.com")
    ) {
      return "instagram";
    }

    return null;
  } catch {
    return null;
  }
}

/*
|--------------------------------------------------------------------------
| Filename sanitization
|--------------------------------------------------------------------------
*/

function sanitizeFilename(name) {
  return String(name || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "video";
}

/*
|--------------------------------------------------------------------------
| Duration formatting
|--------------------------------------------------------------------------
*/

function formatDuration(seconds) {
  if (
    seconds === null ||
    seconds === undefined ||
    Number.isNaN(Number(seconds))
  ) {
    return "Unknown";
  }

  const total = Math.floor(Number(seconds));

  if (total < 0) {
    return "Unknown";
  }

  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      secs
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/*
|--------------------------------------------------------------------------
| Execute yt-dlp
|--------------------------------------------------------------------------
*/

async function runYtDlp(args) {
  try {
    const result = await execFileAsync("yt-dlp", args, {
      maxBuffer: 25 * 1024 * 1024,
      timeout: 180000,
    });

    return result.stdout || "";
  } catch (error) {
    const stderr = error.stderr || "";
    const stdout = error.stdout || "";

    const message =
      stderr.trim() ||
      stdout.trim() ||
      error.message ||
      "yt-dlp failed.";

    throw new Error(message);
  }
}

/*
|--------------------------------------------------------------------------
| yt-dlp extractor configuration
|--------------------------------------------------------------------------
*/

function getExtractorArgs(source) {
  if (source === "youtube") {
    return [
      "--extractor-args",
      "youtube:player_client=tv,web_embedded,mweb",
    ];
  }

  return [];
}

/*
|--------------------------------------------------------------------------
| Build frontend format list
|--------------------------------------------------------------------------
|
| Your App.jsx expects:
|
| format.id
| format.label
|
|--------------------------------------------------------------------------
*/

function buildFrontendFormats(info) {
  const formats = Array.isArray(info.formats)
    ? info.formats
    : [];

  const result = [];

  /*
   * ---------------------------------------------------------------
   * Progressive video formats
   * ---------------------------------------------------------------
   *
   * These already contain video + audio.
   */

  const progressiveFormats = formats
    .filter((format) => {
      return (
        format.vcodec &&
        format.vcodec !== "none" &&
        format.acodec &&
        format.acodec !== "none" &&
        format.height
      );
    })
    .sort((a, b) => {
      return (
        Number(a.height || 0) -
        Number(b.height || 0)
      );
    });

  const progressiveHeights = new Set();

  for (const format of progressiveFormats) {
    const height = Number(format.height);

    if (!height) {
      continue;
    }

    if (progressiveHeights.has(height)) {
      continue;
    }

    progressiveHeights.add(height);

    result.push({
      id: `progressive:${format.format_id}`,

      label: `${height}p MP4`,

      type: "video",

      height,

      formatId: String(format.format_id),

      selector: String(format.format_id),
    });
  }

  /*
   * ---------------------------------------------------------------
   * Video-only formats
   * ---------------------------------------------------------------
   *
   * YouTube frequently provides high-quality video separately
   * from audio.
   *
   * During download we merge the selected video with bestaudio.
   */

  const videoOnlyFormats = formats
    .filter((format) => {
      return (
        format.vcodec &&
        format.vcodec !== "none" &&
        (!format.acodec ||
          format.acodec === "none") &&
        format.height
      );
    })
    .sort((a, b) => {
      return (
        Number(a.height || 0) -
        Number(b.height || 0)
      );
    });

  const videoHeights = new Set();

  for (const format of videoOnlyFormats) {
    const height = Number(format.height);

    if (!height) {
      continue;
    }

    /*
     * If we already have a progressive format for this resolution,
     * prefer the progressive one.
     */

    if (progressiveHeights.has(height)) {
      continue;
    }

    if (videoHeights.has(height)) {
      continue;
    }

    videoHeights.add(height);

    result.push({
      id: `video:${format.format_id}`,

      label: `${height}p MP4`,

      type: "video",

      height,

      formatId: String(format.format_id),

      selector: `${format.format_id}+bestaudio/best`,
    });
  }

  /*
   * ---------------------------------------------------------------
   * Audio
   * ---------------------------------------------------------------
   */

  const audioFormats = formats
    .filter((format) => {
      return (
        format.acodec &&
        format.acodec !== "none" &&
        (!format.vcodec ||
          format.vcodec === "none")
      );
    })
    .sort((a, b) => {
      return (
        Number(b.abr || 0) -
        Number(a.abr || 0)
      );
    });

  const bestAudio = audioFormats[0];

  if (bestAudio) {
    result.push({
      id: `audio:${bestAudio.format_id}`,

      label: "Audio MP3",

      type: "audio",

      formatId: String(bestAudio.format_id),

      selector: String(bestAudio.format_id),
    });
  }

  /*
   * ---------------------------------------------------------------
   * Absolute fallback
   * ---------------------------------------------------------------
   */

  if (result.length === 0) {
    result.push({
      id: "best",

      label: "Best Available",

      type: "video",

      formatId: "best",

      selector: "best",
    });
  }

  /*
   * Video first, audio last.
   */

  result.sort((a, b) => {
    if (a.type === "audio" && b.type !== "audio") {
      return 1;
    }

    if (a.type !== "audio" && b.type === "audio") {
      return -1;
    }

    return (
      Number(a.height || 0) -
      Number(b.height || 0)
    );
  });

  return result;
}

/*
|--------------------------------------------------------------------------
| Public backend URL
|--------------------------------------------------------------------------
*/

function getPublicBaseUrl(req) {
  if (BACKEND_URL) {
    return BACKEND_URL.replace(/\/$/, "");
  }

  const forwardedProtocol =
    req.headers["x-forwarded-proto"];

  const protocol =
    forwardedProtocol ||
    req.protocol ||
    "http";

  const forwardedHost =
    req.headers["x-forwarded-host"];

  const host =
    forwardedHost ||
    req.get("host");

  return `${protocol}://${host}`;
}

/*
|--------------------------------------------------------------------------
| HEALTH CHECK
|--------------------------------------------------------------------------
*/

app.get("/api/health", async (req, res) => {
  try {
    const version = await runYtDlp([
      "--version",
    ]);

    return res.json({
      ok: true,

      service: "Veltrix Downloader Backend",

      ytDlpVersion: version.trim(),
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,

      error:
        "yt-dlp is not installed or cannot be executed by the server.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| ANALYZE URL
|--------------------------------------------------------------------------
|
| Called by:
|
| analyzeUrl(url, source)
|
|--------------------------------------------------------------------------
*/

app.post("/api/analyze", async (req, res) => {
  try {
    const { url, source } = req.body || {};

    /*
     * Validate URL
     */

    if (!url || typeof url !== "string") {
      return res.status(400).json({
        ok: false,

        error: "Please provide a video URL.",
      });
    }

    if (!isValidUrl(url)) {
      return res.status(400).json({
        ok: false,

        error: "Please enter a valid URL.",
      });
    }

    /*
     * Detect actual source.
     */

    const detectedSource = detectSource(url);

    if (!detectedSource) {
      return res.status(400).json({
        ok: false,

        error:
          "Unsupported URL. Please use a public YouTube or Instagram URL.",
      });
    }

    /*
     * Make sure frontend selected source matches URL.
     */

    if (
      source &&
      source !== detectedSource
    ) {
      return res.status(400).json({
        ok: false,

        error:
          `This URL does not appear to be a ${source} URL.`,
      });
    }

    /*
     * Ask yt-dlp for metadata.
     */

    const args = [
      "--dump-single-json",

      "--no-warnings",

      "--no-playlist",

      "--skip-download",

      /*
       * Avoid downloading unnecessary thumbnails.
       */

      ...getExtractorArgs(detectedSource),

      url,
    ];

    const output = await runYtDlp(args);

    let info;

    try {
      info = JSON.parse(output);
    } catch {
      throw new Error(
        "yt-dlp returned invalid media information."
      );
    }

    /*
     * Build formats expected by App.jsx.
     */

    const formats = buildFrontendFormats(info);

    if (!formats.length) {
      throw new Error(
        "No downloadable formats were found."
      );
    }

    /*
     * Create temporary job.
     */

    const jobId = crypto.randomUUID();

    const formatMap = new Map();

    for (const format of formats) {
      formatMap.set(
        format.id,
        format
      );
    }

    jobs.set(jobId, {
      jobId,

      url,

      source: detectedSource,

      title: info.title || "Video",

      createdAt: Date.now(),

      formats: formatMap,

      outputPath: null,

      outputDir: null,

      fileName: null,
    });

    /*
     * EXACT response shape required by App.jsx + api.js
     */

    return res.json({
      ok: true,

      jobId,

      result: {
        title:
          info.title ||
          "Video",

        duration:
          formatDuration(info.duration),

        thumbnail:
          info.thumbnail ||
          "",

        formats,
      },
    });
  } catch (error) {
    console.error(
      "ANALYZE ERROR:",
      error
    );

    const message = String(
      error.message || ""
    );

    /*
     * Common YouTube bot/login errors.
     */

    if (
      message.includes(
        "Sign in to confirm"
      ) ||
      message.includes(
        "not a bot"
      ) ||
      message.toLowerCase().includes(
        "bot"
      ) ||
      message.includes(
        "confirm you're not a bot"
      )
    ) {
      return res.status(502).json({
        ok: false,

        error:
          "The source platform temporarily blocked automated access. Please try again later or try another public URL.",
      });
    }

    /*
     * Private/deleted/unavailable videos.
     */

    if (
      message.includes(
        "Private video"
      ) ||
      message.includes(
        "Video unavailable"
      ) ||
      message.includes(
        "This video is unavailable"
      )
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "This video is private or unavailable.",
      });
    }

    /*
     * Unsupported URL.
     */

    if (
      message.includes(
        "Unsupported URL"
      )
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "This URL is not supported.",
      });
    }

    /*
     * Generic failure.
     */

    return res.status(500).json({
      ok: false,

      error:
        "Unable to analyze this URL right now. Please try another public video.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| DOWNLOAD
|--------------------------------------------------------------------------
|
| Called by:
|
| requestDownload(jobId, formatId)
|
|--------------------------------------------------------------------------
*/

app.post("/api/download", async (req, res) => {
  try {
    const {
      jobId,
      formatId,
    } = req.body || {};

    /*
     * Validate request.
     */

    if (!jobId || !formatId) {
      return res.status(400).json({
        ok: false,

        error:
          "jobId and formatId are required.",
      });
    }

    /*
     * Find temporary job.
     */

    const job = jobs.get(jobId);

    if (!job) {
      return res.status(404).json({
        ok: false,

        error:
          "This download session has expired. Please analyze the URL again.",
      });
    }

    /*
     * Make sure selected format belongs to this job.
     */

    const selectedFormat =
      job.formats.get(formatId);

    if (!selectedFormat) {
      return res.status(400).json({
        ok: false,

        error:
          "Invalid format selection.",
      });
    }

    /*
     * Create temporary directory.
     */

    const tempDir =
      fs.mkdtempSync(
        path.join(
          os.tmpdir(),
          "veltrix-"
        )
      );

    const outputTemplate =
      path.join(
        tempDir,
        "%(title).150s.%(ext)s"
      );

    /*
     * yt-dlp download arguments.
     */

    const args = [
      "--no-warnings",

      "--no-playlist",

      "--retries",
      "2",

      "--fragment-retries",
      "2",

      "--concurrent-fragments",
      "2",

      /*
       * Prefer MP4 when yt-dlp can merge into it.
       */

      "--merge-output-format",
      "mp4",

      /*
       * Output into temporary directory.
       */

      "-o",
      outputTemplate,

      /*
       * User-selected format.
       */

      "-f",
      selectedFormat.selector,

      /*
       * Source-specific extraction settings.
       */

      ...getExtractorArgs(
        job.source
      ),

      /*
       * Original URL.
       */

      job.url,
    ];

    /*
     * Download.
     */

    await runYtDlp(args);

    /*
     * Locate generated file.
     */

    const files =
      fs.readdirSync(tempDir);

    const outputFile =
      files
        .map((file) =>
          path.join(
            tempDir,
            file
          )
        )
        .find((file) => {
          try {
            return fs.statSync(
              file
            ).isFile();
          } catch {
            return false;
          }
        });

    if (!outputFile) {
      throw new Error(
        "The downloader did not create a media file."
      );
    }

    /*
     * ---------------------------------------------------------------
     * Audio
     * ---------------------------------------------------------------
     */

    if (
      selectedFormat.type ===
      "audio"
    ) {
      const safeTitle =
        sanitizeFilename(
          job.title
        );

      const extension =
        path
          .extname(outputFile)
          .toLowerCase();

      /*
       * If already MP3, use it.
       */

      if (
        extension === ".mp3"
      ) {
        job.outputPath =
          outputFile;

        job.outputDir =
          tempDir;

        job.fileName =
          `${safeTitle}.mp3`;
      } else {
        /*
         * Convert audio to MP3 using FFmpeg.
         */

        const mp3Path =
          path.join(
            tempDir,
            `${safeTitle}.mp3`
          );

        try {
          await execFileAsync(
            "ffmpeg",
            [
              "-y",

              "-i",
              outputFile,

              "-vn",

              "-codec:a",
              "libmp3lame",

              "-q:a",
              "2",

              mp3Path,
            ],
            {
              timeout: 180000,

              maxBuffer:
                10 * 1024 * 1024,
            }
          );
        } catch (error) {
          throw new Error(
            error.stderr ||
              "FFmpeg could not convert the audio to MP3."
          );
        }

        try {
          if (
            fs.existsSync(
              outputFile
            )
          ) {
            fs.unlinkSync(
              outputFile
            );
          }
        } catch {}

        job.outputPath =
          mp3Path;

        job.outputDir =
          tempDir;

        job.fileName =
          `${safeTitle}.mp3`;
      }
    } else {
      /*
       * ---------------------------------------------------------------
       * Video
       * ---------------------------------------------------------------
       */

      const safeTitle =
        sanitizeFilename(
          job.title
        );

      const extension =
        path
          .extname(outputFile)
          .replace(".", "")
          .toLowerCase();

      /*
       * Do not claim a WebM file is MP4.
       */

      if (
        extension === "mp4"
      ) {
        job.fileName =
          `${safeTitle}.mp4`;
      } else if (
        extension
      ) {
        job.fileName =
          `${safeTitle}.${extension}`;
      } else {
        job.fileName =
          `${safeTitle}.mp4`;
      }

      job.outputPath =
        outputFile;

      job.outputDir =
        tempDir;
    }

    /*
     * Temporary file endpoint.
     */

    const downloadUrl =
      `${getPublicBaseUrl(
        req
      )}/api/file/${encodeURIComponent(
        jobId
      )}`;

    /*
     * EXACT response shape required by api.js + App.jsx.
     */

    return res.json({
      ok: true,

      downloadUrl,

      fileName:
        job.fileName,
    });
  } catch (error) {
    console.error(
      "DOWNLOAD ERROR:",
      error
    );

    const message = String(
      error.message || ""
    );

    /*
     * Clean temporary files if a download failed.
     */

    /*
     * We find the job through the request body.
     */

    const failedJob =
      jobs.get(
        req.body?.jobId
      );

    if (failedJob) {
      removeJobFiles(
        failedJob
      );

      failedJob.outputPath =
        null;

      failedJob.outputDir =
        null;
    }

    /*
     * Common YouTube access errors.
     */

    if (
      message.includes(
        "Sign in to confirm"
      ) ||
      message.includes(
        "not a bot"
      ) ||
      message.toLowerCase().includes(
        "bot"
      ) ||
      message.includes(
        "confirm you're not a bot"
      )
    ) {
      return res.status(502).json({
        ok: false,

        error:
          "The source platform blocked this download request. Please try again later.",
      });
    }

    /*
     * Private/unavailable.
     */

    if (
      message.includes(
        "Private video"
      ) ||
      message.includes(
        "Video unavailable"
      ) ||
      message.includes(
        "This video is unavailable"
      )
    ) {
      return res.status(400).json({
        ok: false,

        error:
          "This video is private or unavailable.",
      });
    }

    /*
     * FFmpeg missing.
     */

    if (
      message.toLowerCase().includes(
        "ffmpeg"
      )
    ) {
      return res.status(500).json({
        ok: false,

        error:
          "FFmpeg is not installed correctly on the backend server.",
      });
    }

    /*
     * yt-dlp missing.
     */

    if (
      message.includes(
        "yt-dlp"
      ) &&
      (
        message.includes(
          "not found"
        ) ||
        message.includes(
          "ENOENT"
        )
      )
    ) {
      return res.status(500).json({
        ok: false,

        error:
          "yt-dlp is not installed correctly on the backend server.",
      });
    }

    return res.status(500).json({
      ok: false,

      error:
        "Unable to create the download right now. Please try again.",
    });
  }
});

/*
|--------------------------------------------------------------------------
| TEMPORARY FILE DOWNLOAD
|--------------------------------------------------------------------------
|
| Browser calls this URL after /api/download returns successfully.
|
|--------------------------------------------------------------------------
*/

app.get(
  "/api/file/:jobId",
  async (req, res) => {
    const {
      jobId,
    } = req.params;

    const job =
      jobs.get(jobId);

    if (
      !job ||
      !job.outputPath
    ) {
      return res.status(404).send(
        "This download has expired. Please analyze the URL again."
      );
    }

    /*
     * Make sure the file still exists.
     */

    if (
      !fs.existsSync(
        job.outputPath
      )
    ) {
      jobs.delete(jobId);

      return res.status(404).send(
        "This download has expired. Please analyze the URL again."
      );
    }

    /*
     * Content type.
     */

    const isMp3 =
      job.fileName
        ?.toLowerCase()
        .endsWith(".mp3");

    res.setHeader(
      "Content-Type",
      isMp3
        ? "audio/mpeg"
        : "video/mp4"
    );

    /*
     * Force browser download.
     */

    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${job.fileName.replace(
        /"/g,
        ""
      )}"`
    );

    /*
     * Stream file.
     */

    const stream =
      fs.createReadStream(
        job.outputPath
      );

    let cleaned = false;

    const cleanupAfterDownload =
      () => {
        if (cleaned) {
          return;
        }

        cleaned = true;

        /*
         * Give the response a moment to finish.
         */

        setTimeout(() => {
          removeJobFiles(
            job
          );

          jobs.delete(
            jobId
          );
        }, 1000);
      };

    stream.on(
      "error",
      (error) => {
        console.error(
          "FILE STREAM ERROR:",
          error
        );

        cleanupAfterDownload();

        if (
          !res.headersSent
        ) {
          res.status(500).end();
        }
      }
    );

    res.on(
      "finish",
      cleanupAfterDownload
    );

    res.on(
      "close",
      cleanupAfterDownload
    );

    stream.pipe(res);
  }
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use(
  (req, res) => {
    res.status(404).json({
      ok: false,

      error:
        "Endpoint not found.",
    });
  }
);

/*
|--------------------------------------------------------------------------
| Global error handler
|--------------------------------------------------------------------------
*/

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      "GLOBAL ERROR:",
      error
    );

    if (
      res.headersSent
    ) {
      return next(
        error
      );
    }

    res.status(500).json({
      ok: false,

      error:
        "Internal server error.",
    });
  }
);

/*
|--------------------------------------------------------------------------
| Start server
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  () => {
    console.log(
      `Veltrix backend running on port ${PORT}`
    );

    console.log(
      `Health check: http://localhost:${PORT}/api/health`
    );
  }
);
