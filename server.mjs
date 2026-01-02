import express from "express";
import os from "os";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import crypto from "crypto";
import { spawn } from "child_process";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "10mb" }));

// -------------------- CONFIG --------------------
const PORT = Number(process.env.PORT || 3000);
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";
const OUTPUT_FPS = Number(process.env.OUTPUT_FPS || 30);

const JOB_TTL_MIN = Number(process.env.JOB_TTL_MIN || 60);
const JOB_CLEANUP_EVERY_SEC = Number(process.env.JOB_CLEANUP_EVERY_SEC || 60);

const MIN_SEC = 6;
const MAX_SEC = 30;

// Ускорение рендера
const RENDER_CONCURRENCY = Number(process.env.RENDER_CONCURRENCY || 2);
const OFFTHREAD_CACHE_MB = Number(process.env.OFFTHREAD_CACHE_MB || 512);

// Шаг 2: минимальная конвертация “для Chromium”
const ENABLE_CHROMIUM_FIX = (process.env.ENABLE_CHROMIUM_FIX ?? "1") !== "0";

// -------------------- helpers --------------------
function nowIso() {
  return new Date().toISOString();
}

function safeStr(x) {
  return typeof x === "string" ? x : "";
}

function newJobId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString("hex");
}

// Один-единственный runner для команд (ffmpeg/ffprobe)
function runCmd(cmd, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    const timer =
      timeoutMs != null
        ? setTimeout(() => {
            p.kill("SIGKILL");
            reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
          }, timeoutMs)
        : null;

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });

    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} exited ${code}\n${(err || out).slice(-4000)}`));
    });
  });
}

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

// Range support
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

// -------------------- STEP 2: Minimal “fix for Chromium” --------------------
async function probeVideo(filePath) {
  const { out } = await runCmd("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  return JSON.parse(out);
}

function isChromiumFriendly(info) {
  const streams = info?.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const fmt = info?.format?.format_name || "";

  // контейнер
  const containerOk =
    fmt.includes("mp4") || fmt.includes("mov,mp4,m4a,3gp,3g2,mj2");

  // видео кодек
  const vCodecOk = v?.codec_name === "h264";

  // ключевое: пикс формат (айфон любит yuv422p / yuv444p => микрофризы/ошибки)
  const pixOk = (v?.pix_fmt || "").includes("yuv420p");

  // аудио ок (если есть)
  const aOk = !a || a.codec_name === "aac" || a.codec_name === "mp3";

  return containerOk && vCodecOk && pixOk && aOk;
}

/**
 * ШАГ 2: трогаем файл только если НЕ chromium-friendly.
 * Конвертируем быстро (veryfast), делаем yuv420p + faststart.
 */
async function ensureVideoForChromium(inputPath, jobId) {
  if (!ENABLE_CHROMIUM_FIX) return inputPath;

  let info = null;
  try {
    info = await probeVideo(inputPath);
  } catch (e) {
    console.log(
      `[job ${jobId}] ffprobe failed, will convert anyway:`,
      String(e?.message || e)
    );
  }

  if (info && isChromiumFriendly(info)) {
    console.log(`[job ${jobId}] video already chromium-friendly, skip convert`);
    return inputPath;
  }

  const outPath = inputPath.replace(/\.[^.]+$/, "") + `-chromium.mp4`;

  console.log(`[job ${jobId}] converting video for chromium -> ${path.basename(outPath)}`);

  await runCmd(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,

      // делаем предсказуемый CFR под FPS проекта
      "-vf",
      `fps=${OUTPUT_FPS}`,
      "-r",
      String(OUTPUT_FPS),
      "-vsync",
      "cfr",

      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "23",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",

      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "48000",

      outPath,
    ],
    { timeoutMs: 10 * 60 * 1000 }
  );

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) throw new Error("Converted mp4 is too small");

  return outPath;
}

// -------------------- JOB QUEUE (in-memory) --------------------
const JOBS = new Map(); // jobId -> job

async function cleanupOldJobs() {
  const ttlMs = JOB_TTL_MIN * 60 * 1000;
  const now = Date.now();

  for (const [id, job] of JOBS.entries()) {
    const age = now - job.createdAt;
    const canDelete = age > ttlMs && (job.status === "done" || job.status === "error");
    if (!canDelete) continue;

    try {
      if (job.assetToken) cleanupToken(job.assetToken);
      if (job.outPath) await fsp.unlink(job.outPath).catch(() => {});
      if (job.localVideo) await fsp.unlink(job.localVideo).catch(() => {});
      if (job.localVideoFixed && job.localVideoFixed !== job.localVideo) {
        await fsp.unlink(job.localVideoFixed).catch(() => {});
      }
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

  try {
    const serve = await getBundle();

    // 1) download sources (важно: даём норм расширение)
    const localVideoPath = path.join(os.tmpdir(), `job-${jobId}-video-source.mp4`);
    await downloadFromDrive(job.payload.videoFileId, localVideoPath);

    let localMusic = null;
    if (job.payload.musicFileId) {
      localMusic = path.join(os.tmpdir(), `job-${jobId}-music.mp3`);
      await downloadFromDrive(job.payload.musicFileId, localMusic);
    }

    job.localVideo = localVideoPath;
    job.localMusic = localMusic;

    // 2) STEP 2: minimal chromium fix (конвертация только если нужно)
    const localVideoFixed = await ensureVideoForChromium(localVideoPath, jobId);
    job.localVideoFixed = localVideoFixed;

    // 3) register assets
    const assetToken = registerAssets({
      videoPath: localVideoFixed,
      musicPath: localMusic,
    });
    job.assetToken = assetToken;

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${assetToken}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${assetToken}/music` : "";

    // 4) inputProps
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

      videoVolume: job.payload.videoVolume,
      musicVolume: job.payload.musicVolume,
    };

    // 5) select composition
    const composition = await selectComposition({
      serveUrl: serve,
      id: COMPOSITION_ID,
      inputProps,
    });

    // 6) output
    const outPath = path.join(os.tmpdir(), `job-${jobId}-out.mp4`);
    job.outPath = outPath;

    const durationInFrames = Math.round(job.payload.durationSec * OUTPUT_FPS);

    // 7) render
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

      chromiumOptions: {
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-zygote",
        ],
      },

      // скорость
      concurrency: Math.max(1, Math.min(RENDER_CONCURRENCY, os.cpus().length)),
      offthreadVideoCacheSizeInBytes: OFFTHREAD_CACHE_MB * 1024 * 1024,

      timeoutInMilliseconds: 30 * 60 * 1000,
      delayRenderTimeoutInMilliseconds: 10 * 60 * 1000,

      onProgress: (p) => {
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
  }
}

// -------------------- Routes --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

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

      payload: {
        hook: safeStr(body.hook),
        description: safeStr(body.description),
        durationSec: duration,

        videoFileId: String(videoFileId),
        musicFileId: musicFileId ? String(musicFileId) : "",

        videoVolume: typeof body.videoVolume === "number" ? body.videoVolume : 1,
        musicVolume: typeof body.musicVolume === "number" ? body.musicVolume : 0.35,
      },

      startedAt: null,
      finishedAt: null,
      outPath: null,
      localVideo: null,
      localVideoFixed: null,
      localMusic: null,
      assetToken: null,
    });

    setImmediate(() => processJob(jobId));

    return res.json({ ok: true, jobId });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

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

app.get("/download/:jobId", (req, res) => {
  const job = JOBS.get(req.params.jobId);
  if (!job) return res.status(404).send("Job not found");

  if (job.status !== "done" || !job.outPath) {
    return res.status(409).send("Not ready");
  }

  if (!fs.existsSync(job.outPath)) {
    return res.status(410).send("File missing");
  }

  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", `attachment; filename="short-${job.id}.mp4"`);
  fs.createReadStream(job.outPath).pipe(res);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer async running on ${PORT}`);
  console.log(`COMPOSITION_ID=${COMPOSITION_ID}, OUTPUT_FPS=${OUTPUT_FPS}`);
  console.log(`RENDER_CONCURRENCY=${RENDER_CONCURRENCY}, OFFTHREAD_CACHE_MB=${OFFTHREAD_CACHE_MB}`);
  console.log(`ENABLE_CHROMIUM_FIX=${ENABLE_CHROMIUM_FIX}`);
});
