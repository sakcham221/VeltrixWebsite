import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

const PORT = Number(process.env.PORT || 3002);

const TEMP_JOB_ROOT = path.join(
  os.tmpdir(),
  'veltrix-softwares-jobs'
);

fs.mkdirSync(TEMP_JOB_ROOT, { recursive: true });

/*
|--------------------------------------------------------------------------
| Middleware
|--------------------------------------------------------------------------
*/

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

app.use(express.json({ limit: '1mb' }));

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const expiresInMs = 15 * 60 * 1000;

const activeJobs = new Map();
const ipBuckets = new Map();

const ENABLE_REAL_DOWNLOADS =
  String(process.env.ENABLE_REAL_DOWNLOADS || 'true').toLowerCase() ===
  'true';

/*
|--------------------------------------------------------------------------
| Rate limits
|--------------------------------------------------------------------------
*/

const rateLimits = {
  analyze: {
    max: 12,
    windowMs: 10 * 60 * 1000,
  },

  download: {
    max: 8,
    windowMs: 60 * 1000,
  },
};

/*
|--------------------------------------------------------------------------
| Executable detection
|--------------------------------------------------------------------------
*/

function resolveYtDlpExecutable() {
  const configured =
    process.env.YTDLP_PATH ||
    process.env.YT_DLP_PATH;

  if (configured) {
    return configured;
  }

  /*
   * Windows development path
   */
  const winCandidate =
    'C:/Users/aa/AppData/Roaming/Python/Python314/Scripts/yt-dlp.exe';

  if (
    process.platform === 'win32' &&
    fs.existsSync(winCandidate)
  ) {
    return winCandidate;
  }

  /*
   * Linux / Render paths
   */
  const linuxCandidates = [
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    path.join(
      process.env.HOME || '',
      '.local',
      'bin',
      'yt-dlp'
    ),
  ];

  for (const candidate of linuxCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  /*
   * If yt-dlp is available through PATH,
   * spawning "yt-dlp" will still work.
   */
  return 'yt-dlp';
}

function resolveFfmpegExecutable() {
  const configured =
    process.env.FFMPEG_PATH ||
    process.env.FFMPEG_BIN;

  if (
    configured &&
    fs.existsSync(configured)
  ) {
    return configured;
  }

  const candidates = [
    /*
     * Windows
     */
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/Git/usr/bin/ffmpeg.exe',

    /*
     * Linux / Render
     */
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];

  for (const candidate of candidates) {
    if (
      candidate &&
      fs.existsSync(candidate)
    ) {
      return candidate;
    }
  }

  return '';
}

/*
|--------------------------------------------------------------------------
| JavaScript runtime for yt-dlp
|--------------------------------------------------------------------------
|
| Current yt-dlp YouTube extraction uses an external JS runtime.
|
| Since this backend itself is running on Node, we use the exact
| Node executable running this server.
|
*/

function resolveJsRuntimeArgs() {
  /*
   * You can explicitly disable the JS runtime if needed:
   *
   * YTDLP_DISABLE_JS_RUNTIME=true
   */
  if (
    String(
      process.env.YTDLP_DISABLE_JS_RUNTIME || 'false'
    ).toLowerCase() === 'true'
  ) {
    return [];
  }

  /*
   * Only enable Node runtime on Node.js.
   *
   * process.execPath gives us the actual Node executable
   * running this Render service.
   */
  if (process.versions?.node) {
    return [
      '--js-runtimes',
      `node:${process.execPath}`,
    ];
  }

  return [];
}

/*
|--------------------------------------------------------------------------
| Run external command
|--------------------------------------------------------------------------
*/

function runCommand(
  command,
  args,
  extraEnv = {},
  timeoutMs = 10 * 60 * 1000
) {
  return new Promise((resolve, reject) => {
    let finished = false;

    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...extraEnv,
      },
    });

    let stdout = '';
    let stderr = '';

    const timeout = setTimeout(() => {
      if (finished) return;

      finished = true;

      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore kill errors.
      }

      reject(
        new Error(
          `Command timed out after ${Math.round(
            timeoutMs / 1000
          )} seconds.`
        )
      );
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      reject(error);
    });

    child.on('close', (code) => {
      if (finished) return;

      finished = true;
      clearTimeout(timeout);

      if (code === 0) {
        resolve({
          stdout,
          stderr,
        });
      } else {
        const message =
          stderr ||
          stdout ||
          `Command failed with exit code ${code}`;

        reject(new Error(message));
      }
    });
  });
}

/*
|--------------------------------------------------------------------------
| Utility functions
|--------------------------------------------------------------------------
*/

function getClientIp(req) {
  return (
    req.headers['x-forwarded-for']
      ?.split(',')[0]
      ?.trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function getBucket(ip, bucketType) {
  const bucketKey = `${ip}:${bucketType}`;

  const now = Date.now();

  const bucket =
    ipBuckets.get(bucketKey) || {
      hits: [],
      lastReset: now,
    };

  bucket.hits = bucket.hits.filter(
    (timestamp) =>
      now - timestamp <
      rateLimits[bucketType].windowMs
  );

  ipBuckets.set(bucketKey, bucket);

  return bucket;
}

function enforceRateLimit(req, bucketType) {
  const ip = getClientIp(req);

  const bucket = getBucket(
    ip,
    bucketType
  );

  if (
    bucket.hits.length >=
    rateLimits[bucketType].max
  ) {
    return {
      ok: false,
      ip,
      retryAfterMs:
        rateLimits[bucketType].windowMs,
    };
  }

  bucket.hits.push(Date.now());

  return {
    ok: true,
    ip,
  };
}

function sanitizeUrl(input) {
  if (typeof input !== 'string') {
    return '';
  }

  return input.trim();
}

function isSupportedUrl(url) {
  try {
    const value = new URL(url);

    const host =
      value.hostname.toLowerCase();

    return (
      host.includes('youtube.com') ||
      host.includes('youtu.be') ||
      host.includes('instagram.com')
    );
  } catch {
    return false;
  }
}

function isYouTubeUrl(url) {
  return /(?:youtube\.com|youtu\.be)/i.test(
    url
  );
}

function isInstagramUrl(url) {
  return /instagram\.com/i.test(
    url
  );
}

/*
|--------------------------------------------------------------------------
| Temporary job cleanup
|--------------------------------------------------------------------------
*/

function cleanupJob(jobId) {
  const job = activeJobs.get(jobId);

  if (!job) {
    return;
  }

  if (job.filePath) {
    try {
      fs.rmSync(job.filePath, {
        force: true,
      });
    } catch {
      // Ignore cleanup errors.
    }
  }

  activeJobs.delete(jobId);
}

/*
|--------------------------------------------------------------------------
| Metadata
|--------------------------------------------------------------------------
*/

async function fetchMediaMetadata(url) {
  const trimmedUrl =
    sanitizeUrl(url);

  const youtubeMatch =
    trimmedUrl.match(
      /(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i
    ) ||
    trimmedUrl.match(
      /[?&]v=([A-Za-z0-9_-]{11})/i
    );

  const youtubeId =
    youtubeMatch?.[1];

  const metadataCandidates = [];

  /*
   * YouTube
   */
  if (youtubeId) {
    metadataCandidates.push(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(
        trimmedUrl
      )}&format=json`,

      `https://noembed.com/embed?url=${encodeURIComponent(
        trimmedUrl
      )}`
    );
  }

  /*
   * Instagram
   */
  if (
    /instagram\.com\/(?:reel|p)\//i.test(
      trimmedUrl
    )
  ) {
    metadataCandidates.push(
      `https://graph.facebook.com/instagram_oembed?url=${encodeURIComponent(
        trimmedUrl
      )}&access_token=0`
    );
  }

  for (
    const fetchUrl of metadataCandidates
  ) {
    try {
      const response =
        await fetch(fetchUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (compatible; VeltrixBot/1.0)',
            Accept:
              'application/json',
          },
        });

      if (!response.ok) {
        continue;
      }

      const data =
        await response.json();

      const title =
        data.title ||
        data.author_name ||
        (youtubeId
          ? 'YouTube video'
          : 'Supported media');

      const thumbnail =
        data.thumbnail_url ||
        data.thumbnail ||
        (youtubeId
          ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`
          : 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=900&q=80');

      if (title) {
        return {
          title,
          thumbnail,
          duration:
            'Available after processing',
        };
      }
    } catch {
      // Try the next metadata provider.
    }
  }

  /*
   * Fallback YouTube metadata
   */
  if (youtubeId) {
    return {
      title: 'YouTube video',

      thumbnail:
        `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`,

      duration:
        'Available after processing',
    };
  }

  /*
   * Fallback Instagram metadata
   */
  if (
    /instagram\.com\/(?:reel|p)\//i.test(
      trimmedUrl
    )
  ) {
    return {
      title: 'Instagram Reel',

      thumbnail:
        'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80',

      duration:
        'Available after processing',
    };
  }

  return {
    title: 'Supported media',

    thumbnail:
      'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=900&q=80',

    duration:
      'Available after processing',
  };
}

/*
|--------------------------------------------------------------------------
| Job creation
|--------------------------------------------------------------------------
*/

async function createJob(
  jobId,
  source,
  url
) {
  const now = Date.now();

  const metadata =
    await fetchMediaMetadata(url);

  const job = {
    id: jobId,

    source,

    url,

    createdAt: now,

    expiresAt:
      now + expiresInMs,

    status: 'ready',

    result: {
      title:
        metadata.title,

      thumbnail:
        metadata.thumbnail,

      duration:
        metadata.duration,

      formats: [
        {
          id: '720p',
          label: 'MP4 720p',
          quality: '720p',
          mimeType:
            'video/mp4',
          size:
            'Up to approximately 720p',
        },

        {
          id: '1080p',
          label: 'MP4 1080p HD',
          quality: '1080p',
          mimeType:
            'video/mp4',
          size:
            'Up to approximately 1080p',
        },

        {
          id: 'mp3',
          label: 'MP3',
          quality: 'audio',
          mimeType:
            'audio/mpeg',
          size:
            'Depends on source duration',
        },
      ],
    },
  };

  activeJobs.set(
    jobId,
    job
  );

  return job;
}

/*
|--------------------------------------------------------------------------
| yt-dlp download
|--------------------------------------------------------------------------
*/

async function createDownloadFile(
  jobId,
  format,
  sourceUrl
) {
  if (!ENABLE_REAL_DOWNLOADS) {
    const message =
      'Real media downloads are disabled in this demo build.';

    const error =
      new Error(message);

    error.code =
      'DEMO_MODE';

    throw error;
  }

  const extension =
    format.id === 'mp3'
      ? 'mp3'
      : 'mp4';

  const fileName =
    `${jobId}.${extension}`;

  const filePath =
    path.join(
      TEMP_JOB_ROOT,
      fileName
    );

  const ffmpegPath =
    resolveFfmpegExecutable();

  const ytDlp =
    resolveYtDlpExecutable();

  /*
   * Environment
   */
  const env = {};

  if (ffmpegPath) {
    const ffmpegDir =
      path.dirname(
        ffmpegPath
      );

    env.PATH =
      `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`;

    env.FFMPEG_PATH =
      ffmpegPath;
  }

  /*
   * IMPORTANT:
   *
   * Do NOT force:
   *
   * youtube:player-client=ios,web
   *
   * That was present in the old backend.
   *
   * We let current yt-dlp choose its appropriate
   * YouTube clients and enable its JS challenge
   * solver using Node.
   */

  const commonArgs = [
    '--no-playlist',

    '--restrict-filenames',

    '--no-warnings',

    '--no-progress',

    '--newline',

    '--output',
    filePath,

    ...resolveJsRuntimeArgs(),
  ];

  /*
   * Format selection
   */

  let formatArgs = [];

  if (format.id === 'mp3') {
    /*
     * MP3
     */
    if (ffmpegPath) {
      formatArgs = [
        '-f',
        'ba/b',

        '-x',

        '--audio-format',
        'mp3',

        '--audio-quality',
        '0',
      ];
    } else {
      formatArgs = [
        '-f',
        'bestaudio/best',

        '--extract-audio',

        '--audio-format',
        'mp3',

        '--audio-quality',
        '0',
      ];
    }
  }

  else if (format.id === '720p') {
    /*
     * Maximum 720p.
     *
     * Prefer separate video + audio streams when
     * FFmpeg is available.
     */
    if (ffmpegPath) {
      formatArgs = [
        '-f',
        'bv*[height<=720]+ba/b[height<=720]',

        '--merge-output-format',
        'mp4',
      ];
    } else {
      formatArgs = [
        '-f',
        'b[height<=720][ext=mp4]/b[height<=720]',
      ];
    }
  }

  else {
    /*
     * Maximum 1080p.
     */
    if (ffmpegPath) {
      formatArgs = [
        '-f',
        'bv*[height<=1080]+ba/b[height<=1080]',

        '--merge-output-format',
        'mp4',
      ];
    } else {
      formatArgs = [
        '-f',
        'b[height<=1080][ext=mp4]/b[height<=1080]',
      ];
    }
  }

  /*
   * Run yt-dlp
   */

  try {
    console.log(
      `[DOWNLOAD] ${format.id} -> ${sourceUrl}`
    );

    console.log(
      `[DOWNLOAD] yt-dlp: ${ytDlp}`
    );

    console.log(
      `[DOWNLOAD] FFmpeg: ${
        ffmpegPath || 'not found'
      }`
    );

    console.log(
      `[DOWNLOAD] JS runtime args:`,
      resolveJsRuntimeArgs()
    );

    await runCommand(
      ytDlp,

      [
        ...commonArgs,
        ...formatArgs,
        sourceUrl,
      ],

      env,

      /*
       * Maximum download process time:
       * 15 minutes
       */
      15 * 60 * 1000
    );

    /*
     * Verify the output exists.
     */
    if (
      !fs.existsSync(filePath)
    ) {
      throw new Error(
        'The downloader completed but did not produce a valid output file.'
      );
    }

    const stats =
      fs.statSync(filePath);

    if (stats.size <= 0) {
      throw new Error(
        'The downloader produced an empty file.'
      );
    }

    console.log(
      `[DOWNLOAD] Completed ${fileName} (${stats.size} bytes)`
    );

    return {
      fileName,
      filePath,
    };
  }

  catch (error) {
    /*
     * Remove partially-created file.
     */
    if (
      fs.existsSync(filePath)
    ) {
      try {
        fs.rmSync(
          filePath,
          {
            force: true,
          }
        );
      } catch {
        // Ignore cleanup errors.
      }
    }

    /*
     * Make the YouTube bot error easier
     * to understand in the frontend.
     */
    const message =
      String(
        error?.message || error
      );

    if (
      /sign in to confirm/i.test(
        message
      ) ||
      /not a bot/i.test(
        message
      ) ||
      /confirm you're not a bot/i.test(
        message
      )
    ) {
      const friendlyError =
        new Error(
          'YouTube rejected this download request because its anti-bot verification was triggered. The server connection is working, but YouTube requires additional verification for this request.'
        );

      friendlyError.code =
        'YOUTUBE_BOT_CHECK';

      throw friendlyError;
    }

    if (
      /po token/i.test(
        message
      ) ||
      /proof of origin/i.test(
        message
      )
    ) {
      const friendlyError =
        new Error(
          'YouTube requires a Proof-of-Origin token for this video request. yt-dlp reached YouTube successfully, but YouTube rejected the media request.'
        );

      friendlyError.code =
        'YOUTUBE_PO_TOKEN';

      throw friendlyError;
    }

    if (
      /js runtime/i.test(
        message
      ) ||
      /javascript runtime/i.test(
        message
      ) ||
      /ejs/i.test(
        message
      )
    ) {
      const friendlyError =
        new Error(
          'The YouTube JavaScript challenge could not be solved. Make sure Render is using Node.js 22+ and that yt-dlp was installed with the default EJS dependencies.'
        );

      friendlyError.code =
        'YOUTUBE_JS_RUNTIME';

      throw friendlyError;
    }

    throw error;
  }
}

/*
|--------------------------------------------------------------------------
| Health check
|--------------------------------------------------------------------------
*/

app.get(
  '/api/health',
  async (req, res) => {
    const ytDlp =
      resolveYtDlpExecutable();

    const ffmpeg =
      resolveFfmpegExecutable();

    res.json({
      status: 'ok',

      timestamp:
        Date.now(),

      runtime: {
        node:
          process.version,

        platform:
          process.platform,

        architecture:
          process.arch,
      },

      executables: {
        ytDlp,

        ytDlpExists:
          ytDlp !== 'yt-dlp'
            ? fs.existsSync(ytDlp)
            : true,

        ffmpeg:
          ffmpeg || null,

        ffmpegExists:
          Boolean(ffmpeg),
      },

      downloads: {
        enabled:
          ENABLE_REAL_DOWNLOADS,
      },

      jsRuntime: {
        enabled:
          resolveJsRuntimeArgs()
            .length > 0,

        args:
          resolveJsRuntimeArgs(),
      },
    });
  }
);

/*
|--------------------------------------------------------------------------
| Analyze endpoint
|--------------------------------------------------------------------------
*/

app.post(
  '/api/analyze',
  async (req, res) => {
    const rateCheck =
      enforceRateLimit(
        req,
        'analyze'
      );

    if (!rateCheck.ok) {
      return res.status(429).json({
        ok: false,

        error:
          'Too many analysis requests. Please try again in a few minutes.',

        retryAfterMs:
          rateCheck.retryAfterMs,
      });
    }

    try {
      const rawUrl =
        sanitizeUrl(
          req.body?.url || ''
        );

      const source =
        (
          req.body?.source ||
          'youtube'
        ).toLowerCase();

      const clientIp =
        getClientIp(req);

      if (
        !rawUrl ||
        !isSupportedUrl(rawUrl)
      ) {
        return res.status(400).json({
          ok: false,

          error:
            'Please provide a valid YouTube or Instagram URL.',
        });
      }

      /*
       * Prevent source mismatch.
       */
      if (
        source === 'youtube' &&
        !isYouTubeUrl(rawUrl)
      ) {
        return res.status(400).json({
          ok: false,

          error:
            'Please provide a valid YouTube URL.',
        });
      }

      if (
        source === 'instagram' &&
        !isInstagramUrl(rawUrl)
      ) {
        return res.status(400).json({
          ok: false,

          error:
            'Please provide a valid Instagram URL.',
        });
      }

      const jobId =
        crypto.randomUUID();

      const job =
        await createJob(
          jobId,
          source,
          rawUrl
        );

      return res.json({
        ok: true,

        jobId:
          job.id,

        clientIp,

        source:
          job.source,

        result:
          job.result,

        expiresAt:
          job.expiresAt,
      });
    }

    catch (error) {
      console.error(
        '[ANALYZE ERROR]',
        error
      );

      return res.status(500).json({
        ok: false,

        error:
          error?.message ||
          'Unable to analyze this URL.',
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Download endpoint
|--------------------------------------------------------------------------
*/

app.post(
  '/api/download',
  async (req, res) => {
    const rateCheck =
      enforceRateLimit(
        req,
        'download'
      );

    if (!rateCheck.ok) {
      return res.status(429).json({
        ok: false,

        error:
          'Too many download requests. Please wait a moment and try again.',

        retryAfterMs:
          rateCheck.retryAfterMs,
      });
    }

    const {
      jobId,
      formatId,
    } = req.body || {};

    const job =
      activeJobs.get(
        jobId
      );

    if (!job) {
      return res.status(404).json({
        ok: false,

        error:
          'Download job expired or not found.',
      });
    }

    if (
      Date.now() >
      job.expiresAt
    ) {
      cleanupJob(jobId);

      return res.status(410).json({
        ok: false,

        error:
          'This temporary download job has expired.',
      });
    }

    const format =
      job.result.formats.find(
        (item) =>
          item.id === formatId
      ) ||
      job.result.formats[0];

    try {
      const {
        fileName,
        filePath,
      } =
        await createDownloadFile(
          jobId,
          format,
          job.url
        );

      job.filePath =
        filePath;

      job.fileName =
        fileName;

      job.format =
        format;

      const payload = {
        ok: true,

        jobId,

        fileName,

        format,

        /*
         * Relative API URL.
         *
         * Your frontend should combine this with
         * your Render backend URL.
         */
        downloadUrl:
          `/api/files/${encodeURIComponent(
            fileName
          )}`,

        expiresAt:
          job.expiresAt,
      };

      return res.json(
        payload
      );
    }

    catch (error) {
      console.error(
        '[DOWNLOAD ERROR]',
        error
      );

      let statusCode =
        500;

      if (
        error?.code ===
        'DEMO_MODE'
      ) {
        statusCode =
          501;
      }

      if (
        error?.code ===
        'YOUTUBE_BOT_CHECK'
      ) {
        statusCode =
          503;
      }

      if (
        error?.code ===
        'YOUTUBE_PO_TOKEN'
      ) {
        statusCode =
          503;
      }

      if (
        error?.code ===
        'YOUTUBE_JS_RUNTIME'
      ) {
        statusCode =
          503;
      }

      let errorMessage =
        error?.message ||
        'Download is not available for this build.';

      if (
        error?.code ===
        'DEMO_MODE'
      ) {
        errorMessage =
          'This is a demo build. Real video download is not enabled yet, so no playable media file is generated.';
      }

      return res.status(
        statusCode
      ).json({
        ok: false,

        error:
          errorMessage,

        code:
          error?.code || 'DOWNLOAD_ERROR',
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Serve temporary files
|--------------------------------------------------------------------------
*/

app.get(
  '/api/files/:fileName',
  (req, res) => {
    const {
      fileName,
    } = req.params;

    const safeName =
      path.basename(
        fileName
      );

    const filePath =
      path.join(
        TEMP_JOB_ROOT,
        safeName
      );

    if (
      !safeName ||
      (
        !safeName.endsWith(
          '.mp4'
        ) &&
        !safeName.endsWith(
          '.mp3'
        )
      )
    ) {
      return res.status(400).json({
        ok: false,

        error:
          'Invalid file name.',
      });
    }

    if (
      !fs.existsSync(
        filePath
      )
    ) {
      return res.status(404).json({
        ok: false,

        error:
          'Temporary file has expired or is unavailable.',
      });
    }

    const extension =
      safeName.endsWith('.mp3')
        ? 'audio/mpeg'
        : 'video/mp4';

    const stream =
      fs.createReadStream(
        filePath
      );

    res.setHeader(
      'Content-Type',
      extension
    );

    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${safeName}"`
    );

    /*
     * Prevent caching of temporary downloads.
     */
    res.setHeader(
      'Cache-Control',
      'no-store, no-cache, must-revalidate'
    );

    stream.on(
      'error',
      (error) => {
        console.error(
          '[FILE STREAM ERROR]',
          error
        );

        if (!res.headersSent) {
          res.status(500).json({
            ok: false,

            error:
              'Unable to read the temporary file.',
          });
        }
      }
    );

    stream.on(
      'end',
      () => {
        /*
         * Find the job associated with this file.
         */
        for (
          const [
            jobId,
            job,
          ] of activeJobs.entries()
        ) {
          if (
            job.filePath ===
            filePath
          ) {
            cleanupJob(
              jobId
            );

            break;
          }
        }

        /*
         * Extra safety cleanup.
         */
        try {
          fs.rmSync(
            filePath,
            {
              force: true,
            }
          );
        } catch {
          // Ignore cleanup errors.
        }
      }
    );

    stream.pipe(res);
  }
);

/*
|--------------------------------------------------------------------------
| Periodic cleanup
|--------------------------------------------------------------------------
*/

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        jobId,
        job,
      ] of activeJobs.entries()
    ) {
      if (
        job.expiresAt <=
        now
      ) {
        cleanupJob(
          jobId
        );
      }
    }
  },

  60 * 1000
);

/*
|--------------------------------------------------------------------------
| Startup
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  () => {
    console.log(
      '=================================================='
    );

    console.log(
      'Veltrix backend started'
    );

    console.log(
      `Port: ${PORT}`
    );

    console.log(
      `Node: ${process.version}`
    );

    console.log(
      `Platform: ${process.platform}`
    );

    console.log(
      `yt-dlp: ${resolveYtDlpExecutable()}`
    );

    console.log(
      `FFmpeg: ${
        resolveFfmpegExecutable() ||
        'NOT FOUND'
      }`
    );

    console.log(
      'JS runtime:',
      resolveJsRuntimeArgs()
    );

    console.log(
      `Real downloads: ${ENABLE_REAL_DOWNLOADS}`
    );

    console.log(
      '=================================================='
    );
  }
);
