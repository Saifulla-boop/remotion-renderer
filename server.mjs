import express from "express";
import os from "os";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import crypto from "crypto";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "10mb" }));

// -------------------- CONFIG --------------------
const PORT = Number(process.env.PORT || 3000);
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";
const OUTPUT_FPS = Number(process.env.OUTPUT_FPS || 30);

// сколько хранить результаты (минуты)
const JOB_TTL_MIN = Number(process.env.JOB_TTL_MIN || 60);
// как часто чистить (секунды)
const JOB_CLEANUP_EVERY_SEC = Number(process.env.JOB_CLEANUP_EVERY_SEC || 60);

const MIN_SEC = 6;
const MAX_SEC = 30;

// -------------------- Drive (Service Account, READONLY) --------------------
function getDrive() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const keyRaw = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !keyRaw) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY env vars.");
  }

  const key = keyRaw.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

async function downloadFromDrive(fileId, outPath) {
  const drive = getDrive();

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(outPath);
    res.data.on("end", resolve).on("error", reject).pipe(dest);
  });

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(`Downloaded file too small (${stat.size}). fileId=${fileId}`);
  }

  return outPath;
}

// -------------------- Asset serving (for Chromium) --------------------
const ASSETS = new Map(); // token -> { videoPath, musicPath?, expiresAt }

function createToken() {
  return crypto.randomBytes(16).toString("hex");
}

function registerAssets({ videoPath, musicPath }) {
  const token = createToken();
  ASSETS.set(token, {
    videoPath,
    musicPath,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  return token;
}

function cleanupToken(token) {
  ASSETS.delete(token);
}

setInterval(() => {
  const now = Date.now();
  for (const [token, v] of ASSETS.entries()) {
    if (v.expiresAt < now) ASSETS.delete(token);
  }
}, 60 * 1000);

// Range support (Chromium любит range)
function addRangeSupport(req, res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);

  if (!range) {
    res.setHeader("Content-Length", fileSize);
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) return res.status(416).end();

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : fileSize - 1;

  if (start >= fileSize || end >= fileSize) return res.status(416).end();

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", end - start + 1);

  fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get("/asset/:token/video", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.videoPath) return res.status(404).send("Not found");
  addRangeSupport(req, res, entry.videoPath, "video/mp4");
});

app.get("/asset/:token/music", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.musicPath) return res.status(404).send("Not found");
  addRangeSupport(req, res, entry.musicPath, "audio/mpeg");
});

// -------------------- Remotion bundle cache --------------------
let serveUrl = null;

async function getBundle() {
  if (serveUrl) return serveUrl;
  console.log("[remotion] bundling...");
  serveUrl = await bundle({
    entryPoint: path.join(process.cwd(), "remotion", "src", "index.ts"),
  });
  console.log("[remotion] bundle ready:", serveUrl);
  return serveUrl;
}

// -------------------- JOB QUEUE (in-memory) --------------------
/**
 * status:
 *  - queued
 *  - rendering
 *  - done
 *  - error
 */
const JOBS = new Map(); // jobId -> job

function newJobId() {
  // Node 18 имеет randomUUID
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

// автоочистка job’ов + файлов
async function cleanupOldJobs() {
  const ttlMs = JOB_TTL_MIN * 60 * 1000;
  const now = Date.now();

  for (const [id, job] of JOBS.entries()) {
    const age = now - job.createdAt;
    const canDelete =
      age > ttlMs && (job.status === "done" || job.status === "error");

    if (!canDelete) continue;

    try {
      if (job.assetToken) cleanupToken(job.assetToken);
      if (job.outPath) await fsp.unlink(job.outPath).catch(() => {});
      if (job.localVideo) await fsp.unlink(job.localVideo).catch(() => {});
      if (job.localMusic) await fsp.unlink(job.localMusic).catch(() => {});
    } catch {}

    JOBS.delete(id);
    console.log(`[jobs] cleaned ${id}`);
  }
}

setInterval(() => {
  cleanupOldJobs().catch(() => {});
}, JOB_CLEANUP_EVERY_SEC * 1000);

// -------------------- Core render worker --------------------
async function processJob(jobId) {
  const job = JOBS.get(jobId);
  if (!job) return;

  job.status = "rendering";
  job.startedAt = Date.now();
  job.progress = 0;
  job.updatedAtIso = nowIso();

  console.log(`[job ${jobId}] start`);

  let assetToken = null;

  try {
    const serve = await getBundle();

    // 1) download sources
    const localVideo = path.join(os.tmpdir(), `job-${jobId}-video.mp4`);
    await downloadFromDrive(job.payload.videoFileId, localVideo);

    let localMusic = null;
    if (job.payload.musicFileId) {
      localMusic = path.join(os.tmpdir(), `job-${jobId}-music.mp3`);
      await downloadFromDrive(job.payload.musicFileId, localMusic);
    }

    job.localVideo = localVideo;
    job.localMusic = localMusic;

    // 2) register local assets and create URLs for Chromium
    assetToken = registerAssets({ videoPath: localVideo, musicPath: localMusic });
    job.assetToken = assetToken;

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${assetToken}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${assetToken}/music` : "";

    // 3) inputProps (передаём ВСЕ варианты имён)
    const inputProps = {
      hook: safeStr(job.payload.hook),
      description: safeStr(job.payload.description),
      durationSec: job.payload.durationSec,

      videoUrl,
      musicUrl,

      videoSrc: videoUrl,
      musicSrc: musicUrl,

      videoPath: videoUrl,
      musicPath: musicUrl,

      // громкость
      videoVolume: job.payload.videoVolume,
      musicVolume: job.payload.musicVolume,
    };

    // 4) select composition (валидируем что всё ок)
    const composition = await selectComposition({
      serveUrl: serve,
      id: COMPOSITION_ID,
      inputProps,
    });

    // 5) output
    const outPath = path.join(os.tmpdir(), `job-${jobId}-out.mp4`);
    job.outPath = outPath;

    const durationInFrames = Math.round(job.payload.durationSec * OUTPUT_FPS);

    // 6) render with progress logs
    let lastLog = 0;

    await renderMedia({
      composition: {
        ...composition,
        fps: OUTPUT_FPS,
        durationInFrames,
      },
      serveUrl: serve,
      codec: "h264",
      pixelFormat: "yuv420p",
      outputLocation: outPath,
      inputProps,

      // стабильность в контейнере
      chromiumOptions: {
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
      },

      // чтобы не убивать CPU пиками
      concurrency: 1,

      // таймауты — увеличены, но они теперь редко нужны (мы не держим HTTP)
      timeoutInMilliseconds: 30 * 60 * 1000,
      delayRenderTimeoutInMilliseconds: 10 * 60 * 1000,

      onProgress: (p) => {
        // Remotion может отдавать разные поля, берём максимально надёжно
        const overall =
          typeof p?.overallProgress === "number"
            ? p.overallProgress
            : typeof p?.progress === "number"
            ? p.progress
            : null;

        if (overall !== null) job.progress = Math.max(0, Math.min(1, overall));

        job.updatedAtIso = nowIso();

        const nowT = Date.now();
        if (nowT - lastLog > 1500) {
          lastLog = nowT;
          const percent = Math.round((job.progress || 0) * 100);
          console.log(`[job ${jobId}] progress ${percent}%`);
        }
      },
    });

    // sanity
    const stat = fs.statSync(outPath);
    if (!stat.size || stat.size < 1024) throw new Error("Output mp4 is too small");

    job.status = "done";
    job.finishedAt = Date.now();
    job.progress = 1;
    job.updatedAtIso = nowIso();

    console.log(
      `[job ${jobId}] done in ${Math.round((job.finishedAt - job.startedAt) / 1000)}s`
    );
  } catch (e) {
    job.status = "error";
    job.error = String(e?.message || e);
    job.finishedAt = Date.now();
    job.updatedAtIso = nowIso();

    console.log(`[job ${jobId}] ERROR:`, job.error);
  } finally {
    // asset token держим — нужен до скачивания результата.
    // автоочистка удалит позже по TTL.
  }
}

// -------------------- Routes --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /render
 * body: { hook, description, durationSec, videoFileId, musicFileId?, videoVolume?, musicVolume? }
 * returns: { jobId }
 */
app.post("/render", (req, res) => {
  try {
    const body = req.body || {};

    const videoFileId =
      body.videoFileId ??
      body.videoFieldId ??
      body.videoFileid ??
      body.videoFieldid;

    const musicFileId =
      body.musicFileId ??
      body.musicFieldId ??
      body.musicFileid ??
      body.musicFieldid;

    if (!videoFileId) {
      return res.status(400).json({ ok: false, error: "videoFileId required" });
    }

    const duration = Number.isFinite(Number(body.durationSec))
      ? Math.min(Math.max(Number(body.durationSec), MIN_SEC), MAX_SEC)
      : 12;

    const jobId = newJobId();

    JOBS.set(jobId, {
      id: jobId,
      status: "queued",
      progress: 0,
      error: null,

      createdAt: Date.now(),
      createdAtIso: nowIso(),
      updatedAtIso: nowIso(),

      // всё, что нужно рендеру
      payload: {
        hook: safeStr(body.hook),
        description: safeStr(body.description),
        durationSec: duration,

        videoFileId: String(videoFileId),
        musicFileId: musicFileId ? String(musicFileId) : "",

        // громкости (опционально)
        videoVolume:
          typeof body.videoVolume === "number" ? body.videoVolume : 1,
        musicVolume:
          typeof body.musicVolume === "number" ? body.musicVolume : 0.35,
      },

      // runtime fields
      startedAt: null,
      finishedAt: null,
      outPath: null,
      localVideo: null,
      localMusic: null,
      assetToken: null,
    });

    // запускаем рендер в фоне
    setImmediate(() => processJob(jobId));

    return res.json({ ok: true, jobId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * GET /status/:jobId
 * returns status + progress + error
 */
app.get("/status/:jobId", (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: "Job not found" });

  return res.json({
    ok: true,
    jobId: job.id,
    status: job.status,
    progress: job.progress ?? 0,
    error: job.error,
    createdAt: job.createdAtIso,
    updatedAt: job.updatedAtIso,
  });
});

/**
 * GET /download/:jobId
 * returns mp4 file (attachment)
 */
app.get("/download/:jobId", (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).send("Job not found");

  if (job.status !== "done" || !job.outPath) {
    return res.status(409).send("Not ready");
  }

  if (!fs.existsSync(job.outPath)) {
    return res.status(410).send("File missing");
  }

  // отдаём файлом (как ты и сделал — на телефонах это лучше)
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="short-${job.id}.mp4"`);

  fs.createReadStream(job.outPath).pipe(res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer async running on ${PORT}`);
  console.log(`COMPOSITION_ID=${COMPOSITION_ID}, OUTPUT_FPS=${OUTPUT_FPS}`);
  console.log(`JOB_TTL_MIN=${JOB_TTL_MIN}, CLEANUP_EVERY_SEC=${JOB_CLEANUP_EVERY_SEC}`);
});
