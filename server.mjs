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

// -------------------- helpers --------------------
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

async function getVideoDims(filePath) {
  const { out } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    filePath,
  ]);

  const [w, h] = out.trim().split("x").map(Number);
  if (!w || !h) throw new Error("ffprobe could not read video dimensions");
  return { w, h };
}

// ✅ Нормализация БЕЗ ПРИНУДИТЕЛЬНОГО fps!
// Только совместимость: H264 + yuv420p + чётные размеры.
// Это лечит чёрные моргания и не ломает плавность.
async function normalizeVideoNoFps(inPath, outPath) {
  await run("ffmpeg", [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    inPath,

    // НЕ fps=30! только scale-even + pixel format
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",

    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "high",
    "-preset",
    "veryfast",
    "-crf",
    "18",

    // сохраняем звук исходника (если есть)
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

// -------------------- Local assets served via HTTP (for Remotion/Chromium) --------------------
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

// ✅ Range support — снижает таймауты/фризы при чтении Chromium
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
  let localVideo = null;
  let localVideoNorm = null;
  let localMusic = null;
  let outPath = null;
  let token = null;

  try {
    const body = req.body || {};

    const hook = body.hook ?? "";
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;

    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    if (!videoFileId) return res.status(400).json({ error: "videoFileId required" });

    const duration = Number.isFinite(Number(durationSec))
      ? Math.min(Math.max(Number(durationSec), MIN_SEC), MAX_SEC)
      : 12;

    const serve = await getBundle();

    // 1) download
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}.mp4`);
    await downloadFromDrive(videoFileId, localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 2) normalize (БЕЗ fps)
    localVideoNorm = path.join(os.tmpdir(), `in-video-norm-${Date.now()}.mp4`);
    await normalizeVideoNoFps(localVideo, localVideoNorm);

    // 3) orientation
    const { w, h } = await getVideoDims(localVideoNorm);
    const fitMode = w > h ? "contain" : "cover";

    // 4) serve via HTTP
    token = registerAssets({ videoPath: localVideoNorm, musicPath: localMusic });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    // ✅ Передаем сразу все варианты
    const inputProps = {
      hook: String(hook ?? ""),
      description: String(description ?? ""),
      durationSec: duration,
      fitMode,

      videoUrl,
      musicUrl,

      videoPath: videoUrl,
      musicPath: musicUrl,

      videoSrc: videoUrl,
      musicSrc: musicUrl,
    };

    const composition = await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps,
    });

    outPath = path.join(os.tmpdir(), `out-${Date.now()}.mp4`);

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
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);
    fs.createReadStream(outPath).pipe(res);

    res.on("close", async () => {
      try {
        if (token) cleanupToken(token);
        if (outPath) await fsp.unlink(outPath).catch(() => {});
        if (localVideo) await fsp.unlink(localVideo).catch(() => {});
        if (localVideoNorm) await fsp.unlink(localVideoNorm).catch(() => {});
        if (localMusic) await fsp.unlink(localMusic).catch(() => {});
      } catch {}
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: e?.message || "Render failed" });

    try {
      if (token) cleanupToken(token);
      if (outPath) await fsp.unlink(outPath).catch(() => {});
      if (localVideo) await fsp.unlink(localVideo).catch(() => {});
      if (localVideoNorm) await fsp.unlink(localVideoNorm).catch(() => {});
      if (localMusic) await fsp.unlink(localMusic).catch(() => {});
    } catch {}
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer running on ${PORT} (OUTPUT_FPS=${OUTPUT_FPS})`);
});
