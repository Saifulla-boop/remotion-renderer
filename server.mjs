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

const PORT = process.env.PORT || 3000;
const OUTPUT_FPS = Number(process.env.OUTPUT_FPS || 30);
const MIN_SEC = 6;
const MAX_SEC = 30;

// -------------------- Google Drive (Service Account, READONLY) --------------------
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

// -------------------- spawn helper --------------------
function run(cmd, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timeout`));
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} failed (${code})\n${err || out}`));
    });
  });
}

// -------------------- MINIMAL normalize to MP4 (H.264) --------------------
// Делает видео "съедобным" для Chromium в Docker:
// - mp4 контейнер
// - H.264
// - yuv420p
// - +faststart
// - сохраняет (если есть) исходный звук, чтобы голос не пропадал
async function normalizeToMp4H264(inPath, outPath) {
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inPath,

    // видео: H.264 + yuv420p + чётные размеры
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-level",
    "4.2",
    "-preset",
    "fast",
    "-crf",
    "20",

    // аудио: оставляем, если есть (0:a?) и делаем совместимое AAC
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",

    "-movflags",
    "+faststart",
    outPath,
  ]);

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(`Normalized file too small (${stat.size})`);
  }
  return outPath;
}

// -------------------- Local assets served via HTTP (Chromium needs HTTP) --------------------
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
}, 2 * 60 * 1000);

// Range support — важно для стабильного чтения медиа Chromium’ом
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

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

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
  serveUrl = await bundle({
    entryPoint: path.join(process.cwd(), "remotion", "src", "index.ts"),
  });
  return serveUrl;
}

// -------------------- Routes --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  let localVideoIn = null;
  let localVideoMp4 = null;
  let localMusic = null;
  let outPath = null;
  let token = null;

  try {
    const body = req.body || {};

    const hook = body.hook ?? "";
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    // поддержка разных имен входных полей (Unisender/твои узлы)
    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    if (!videoFileId) return res.status(400).json({ error: "videoFileId required" });

    const duration = Number.isFinite(Number(durationSec))
      ? Math.min(Math.max(Number(durationSec), MIN_SEC), MAX_SEC)
      : 12;

    const serve = await getBundle();

    // 1) download video + music from Drive
    localVideoIn = path.join(os.tmpdir(), `in-video-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bin`);
    await downloadFromDrive(videoFileId, localVideoIn);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 2) minimal normalize video to mp4/h264 for Chromium
    localVideoMp4 = path.join(os.tmpdir(), `in-video-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`);
    await normalizeToMp4H264(localVideoIn, localVideoMp4);

    // 3) serve sources via HTTP
    token = registerAssets({ videoPath: localVideoMp4, musicPath: localMusic });
    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    // 4) inputProps (и для старого, и для нового названия пропсов)
    const inputProps = {
      hook: String(hook),
      description: String(description),
      durationSec: duration,

      // most common
      videoUrl,
      musicUrl,

      // fallbacks for different implementations in Short.tsx
      videoSrc: videoUrl,
      musicSrc: musicUrl,
      videoPath: videoUrl,
      musicPath: musicUrl,
    };

    const composition = await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps,
    });

    outPath = path.join(os.tmpdir(), `out-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.mp4`);

    await renderMedia({
      composition: {
        ...composition,
        fps: OUTPUT_FPS,
        durationInFrames: Math.round(duration * OUTPUT_FPS),
      },
      serveUrl: serve,
      codec: "h264",
      pixelFormat: "yuv420p",
      outputLocation: outPath,
      inputProps,

      // стабильность в Docker
      chromiumOptions: {
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      },

      // чтобы не рвало CPU и не было "дёрганья" от нехватки ресурсов
      concurrency: 1,

      // таймауты
      timeoutInMilliseconds: 10 * 60 * 1000,
      delayRenderTimeoutInMilliseconds: 5 * 60 * 1000,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);
    fs.createReadStream(outPath).pipe(res);

    res.on("close", async () => {
      try {
        if (token) cleanupToken(token);
        if (outPath) await fsp.unlink(outPath).catch(() => {});
        if (localVideoIn) await fsp.unlink(localVideoIn).catch(() => {});
        if (localVideoMp4) await fsp.unlink(localVideoMp4).catch(() => {});
        if (localMusic) await fsp.unlink(localMusic).catch(() => {});
      } catch {}
    });
  } catch (e) {
    console.error("[render] error:", e);
    if (!res.headersSent) res.status(500).json({ error: e?.message || "Render failed" });

    try {
      if (token) cleanupToken(token);
      if (outPath) await fsp.unlink(outPath).catch(() => {});
      if (localVideoIn) await fsp.unlink(localVideoIn).catch(() => {});
      if (localVideoMp4) await fsp.unlink(localVideoMp4).catch(() => {});
      if (localMusic) await fsp.unlink(localMusic).catch(() => {});
    } catch {}
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer running on ${PORT} (OUTPUT_FPS=${OUTPUT_FPS})`);
});
