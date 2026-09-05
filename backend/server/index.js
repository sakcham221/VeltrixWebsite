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
const TEMP_JOB_ROOT = path.join(os.tmpdir(), 'veltrix-softwares-jobs');

fs.mkdirSync(TEMP_JOB_ROOT, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const expiresInMs = 15 * 60 * 1000;
const activeJobs = new Map();
const ipBuckets = new Map();
const ENABLE_REAL_DOWNLOADS = String(process.env.ENABLE_REAL_DOWNLOADS || 'true').toLowerCase() === 'true';

function resolveYtDlpExecutable() {
  const configured = process.env.YTDLP_PATH || process.env.YT_DLP_PATH;
  if (configured) return configured;

  const winCandidate = 'C:/Users/aa/AppData/Roaming/Python/Python314/Scripts/yt-dlp.exe';
  if (process.platform === 'win32' && fs.existsSync(winCandidate)) {
    return winCandidate;
  }

  return 'yt-dlp';
}

function resolveFfmpegExecutable() {
  const configured = process.env.FFMPEG_PATH || process.env.FFMPEG_BIN;
  if (configured && fs.existsSync(configured)) return configured;

  const candidates = [
    'C:/Users/aa/AppData/Local/Microsoft/WinGet/Packages/yt-dlp.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-N-125875-g5d4d3bdc61-win64-gpl/bin/ffmpeg.exe',
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/Git/usr/bin/ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return '';
}

function runCommand(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr || stdout || `Command failed with exit code ${code}`));
      }
    });
  });
}

const rateLimits = {
  analyze: { max: 12, windowMs: 10 * 60 * 1000 },
  download: { max: 8, windowMs: 60 * 1000 },
};

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

function getBucket(ip, bucketType) {
  const bucketKey = `${ip}:${bucketType}`;
  const now = Date.now();
  const bucket = ipBuckets.get(bucketKey) || { hits: [], lastReset: now };

  bucket.hits = bucket.hits.filter((timestamp) => now - timestamp < rateLimits[bucketType].windowMs);
  ipBuckets.set(bucketKey, bucket);
  return bucket;
}

function enforceRateLimit(req, bucketType) {
  const ip = getClientIp(req);
  const bucket = getBucket(ip, bucketType);

  if (bucket.hits.length >= rateLimits[bucketType].max) {
    return { ok: false, ip, retryAfterMs: rateLimits[bucketType].windowMs };
  }

  bucket.hits.push(Date.now());
  return { ok: true, ip };
}

function sanitizeUrl(input) {
  if (typeof input !== 'string') return '';
  return input.trim();
}

function isSupportedUrl(url) {
  try {
    const value = new URL(url);
    const host = value.hostname.toLowerCase();
    return host.includes('youtube.com') || host.includes('youtu.be') || host.includes('instagram.com');
  } catch {
    return false;
  }
}

function cleanupJob(jobId) {
  const job = activeJobs.get(jobId);
  if (!job) return;

  if (job.filePath) {
    try {
      fs.rmSync(job.filePath, { force: true });
    } catch {
      // Ignore cleanup errors for temporary files.
    }
  }

  activeJobs.delete(jobId);
}

async function fetchMediaMetadata(url) {
  const trimmedUrl = sanitizeUrl(url);
  const youtubeMatch = trimmedUrl.match(/(?:youtube\.com\/(?:watch\?v=|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/i)
    || trimmedUrl.match(/[?&]v=([A-Za-z0-9_-]{11})/i);
  const youtubeId = youtubeMatch?.[1];

  const metadataCandidates = [];

  if (youtubeId) {
    metadataCandidates.push(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(trimmedUrl)}&format=json`,
      `https://noembed.com/embed?url=${encodeURIComponent(trimmedUrl)}`,
    );
  }

  if (/instagram\.com\/(?:reel|p)\//i.test(trimmedUrl)) {
    metadataCandidates.push(`https://graph.facebook.com/instagram_oembed?url=${encodeURIComponent(trimmedUrl)}&access_token=0`);
  }

  for (const fetchUrl of metadataCandidates) {
    try {
      const response = await fetch(fetchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; VeltrixBot/1.0)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) continue;

      const data = await response.json();
      const title = data.title || data.author_name || (youtubeId ? 'YouTube video' : 'Supported media');
      const thumbnail = data.thumbnail_url || data.thumbnail || (youtubeId ? `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg` : 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=900&q=80');

      if (title) {
        return {
          title,
          thumbnail,
          duration: 'Available after processing',
        };
      }
    } catch {
      // continue trying other metadata sources
    }
  }

  if (youtubeId) {
    return {
      title: 'YouTube video',
      thumbnail: `https://img.youtube.com/vi/${youtubeId}/hqdefault.jpg`,
      duration: 'Available after processing',
    };
  }

  if (/instagram\.com\/(?:reel|p)\//i.test(trimmedUrl)) {
    return {
      title: 'Instagram Reel',
      thumbnail: 'https://images.unsplash.com/photo-1516280440614-37939bbacd81?auto=format&fit=crop&w=900&q=80',
      duration: 'Available after processing',
    };
  }

  return {
    title: 'Supported media',
    thumbnail: 'https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=900&q=80',
    duration: 'Available after processing',
  };
}

async function createJob(jobId, source, url) {
  const now = Date.now();
  const metadata = await fetchMediaMetadata(url);
  const job = {
    id: jobId,
    source,
    url,
    createdAt: now,
    expiresAt: now + expiresInMs,
    status: 'ready',
    result: {
      title: metadata.title,
      thumbnail: metadata.thumbnail,
      duration: metadata.duration,
      formats: [
        { id: '720p', label: 'MP4 720p', quality: '720p', mimeType: 'video/mp4', size: '180 MB' },
        { id: '1080p', label: 'MP4 1080p HD', quality: '1080p', mimeType: 'video/mp4', size: '320 MB' },
        { id: 'mp3', label: 'MP3', quality: 'audio', mimeType: 'audio/mpeg', size: '9 MB' },
      ],
    },
  };

  activeJobs.set(jobId, job);
  return job;
}

async function createDownloadFile(jobId, format, sourceUrl) {
  if (!ENABLE_REAL_DOWNLOADS) {
    const message = 'Real media downloads are disabled in this demo build. This project currently exposes metadata only.';
    const error = new Error(message);
    error.code = 'DEMO_MODE';
    throw error;
  }

  const extension = format.id === 'mp3' ? 'mp3' : 'mp4';
  const fileName = `${jobId}.${extension}`;
  const filePath = path.join(TEMP_JOB_ROOT, fileName);
  const ffmpegPath = resolveFfmpegExecutable();
  const env = {};

  if (ffmpegPath) {
    const ffmpegDir = path.dirname(ffmpegPath);
    env.PATH = `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}`;
    env.FFMPEG_PATH = ffmpegPath;
  }

  const ytDlp = resolveYtDlpExecutable();
  const outputTemplate = filePath;
  const commonArgs = [
    '--no-playlist',
    '--restrict-filenames',
    '--no-warnings',
    '--output',
    outputTemplate,
  ];

  const formatArgs = format.id === 'mp3'
    ? ffmpegPath
      ? ['-x', '--audio-format', 'mp3', '--audio-quality', '0']
      : ['-f', 'bestaudio/best', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0']
    : ffmpegPath
      ? ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4']
      : ['-f', 'best[ext=mp4]/best'];

  try {
    await runCommand(ytDlp, [...commonArgs, ...formatArgs, sourceUrl], env);
    if (!fs.existsSync(filePath)) {
      throw new Error('The downloader did not produce a valid file.');
    }
    return { fileName, filePath };
  } catch (error) {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
    throw error;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

app.post('/api/analyze', async (req, res) => {
  const rateCheck = enforceRateLimit(req, 'analyze');
  if (!rateCheck.ok) {
    return res.status(429).json({
      ok: false,
      error: 'Too many analysis requests. Please try again in a few minutes.',
      retryAfterMs: rateCheck.retryAfterMs,
    });
  }

  const rawUrl = sanitizeUrl(req.body?.url || '');
  const source = (req.body?.source || 'youtube').toLowerCase();
  const clientIp = getClientIp(req);

  if (!rawUrl || !isSupportedUrl(rawUrl)) {
    return res.status(400).json({
      ok: false,
      error: 'Please provide a valid YouTube or Instagram URL.',
    });
  }

  const jobId = crypto.randomUUID();
  const job = await createJob(jobId, source, rawUrl);

  res.json({
    ok: true,
    jobId: job.id,
    clientIp,
    source: job.source,
    result: job.result,
    expiresAt: job.expiresAt,
  });
});

app.post('/api/download', async (req, res) => {
  const rateCheck = enforceRateLimit(req, 'download');
  if (!rateCheck.ok) {
    return res.status(429).json({
      ok: false,
      error: 'Too many download requests. Please wait a moment and try again.',
      retryAfterMs: rateCheck.retryAfterMs,
    });
  }

  const { jobId, formatId } = req.body || {};
  const job = activeJobs.get(jobId);

  if (!job) {
    return res.status(404).json({ ok: false, error: 'Download job expired or not found.' });
  }

  if (Date.now() > job.expiresAt) {
    cleanupJob(jobId);
    return res.status(410).json({ ok: false, error: 'This temporary download job has expired.' });
  }

  const format = job.result.formats.find((item) => item.id === formatId) || job.result.formats[0];

  try {
    const { fileName, filePath } = await createDownloadFile(jobId, format, job.url);

    job.filePath = filePath;
    job.fileName = fileName;
    job.format = format;

    const payload = {
      ok: true,
      jobId,
      fileName,
      format,
      downloadUrl: `/api/files/${fileName}`,
      expiresAt: job.expiresAt,
    };

    return res.json(payload);
  } catch (error) {
    return res.status(501).json({
      ok: false,
      error: error.code === 'DEMO_MODE'
        ? 'This is a demo build. Real video download is not enabled yet, so no playable media file is generated.'
        : error.message || 'Download is not available for this build.',
    });
  }
});

app.get('/api/files/:fileName', (req, res) => {
  const { fileName } = req.params;
  const safeName = path.basename(fileName);
  const filePath = path.join(TEMP_JOB_ROOT, safeName);

  if (!safeName || (!safeName.endsWith('.mp4') && !safeName.endsWith('.mp3'))) {
    return res.status(400).json({ ok: false, error: 'Invalid file name.' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, error: 'Temporary file has expired or is unavailable.' });
  }

  const extension = safeName.endsWith('.mp3') ? 'audio/mpeg' : 'video/mp4';
  const stream = fs.createReadStream(filePath);

  res.setHeader('Content-Type', extension);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);

  stream.on('end', () => {
    for (const [jobId, job] of activeJobs.entries()) {
      if (job.filePath === filePath) {
        cleanupJob(jobId);
        break;
      }
    }

    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      // Ignore cleanup errors after delivery.
    }
  });

  stream.pipe(res);
});

setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of activeJobs.entries()) {
    if (job.expiresAt <= now) {
      cleanupJob(jobId);
    }
  }
}, 60 * 1000);

app.listen(PORT, () => {
  console.log(`Veltrix backend listening on http://localhost:${PORT}`);
});
