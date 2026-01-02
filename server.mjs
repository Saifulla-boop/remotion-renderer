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

// ====== FPS CONFIG (айфон 60fps) ======
const TARGET_FPS = 60;             // делаем 60, чтобы было максимально плавно
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

app.get("/asset/:token/video", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.videoPath) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(entry.videoPath).pipe(res);
});

app.get("/asset/:token/music", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.musicPath) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "audio/mpeg");
  fs.createReadStream(entry.musicPath).pipe(res);
});

// -------------------- helpers: run ffmpeg/ffprobe --------------------
function run(cmd, args, { timeoutMs = 120000 } = {}) {
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

// ✅ Нормализация айфон-видео (VFR -> CFR), + приводим к H.264/yuv420p
async function normalizeVideoToCfr(inputPath, fps = TARGET_FPS) {
  const outPath = path.join(os.tmpdir(), `cfr-${Date.now()}.mp4`);

  await run(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,

      // делаем ровные кадры
      "-vf",
      `fps=${fps}`,
      "-r",
      String(fps),

      // кодек для стабильного декода в Chromium
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",

      // звук выкидываем — у тебя отдельная музыка
      "-an",
      outPath,
    ],
    { timeoutMs: 180000 }
  );

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(`normalizeVideoToCfr produced too small file (${stat.size})`);
  }

  return outPath;
}

// (опционально) финализация рендера — если захочешь сделать идеально “инстаграмно”
// сейчас НЕ используем, потому что рендерим сразу 60fps
async function finalizeOutputSmooth(inputPath, fps = TARGET_FPS) {
  const outPath = path.join(os.tmpdir(), `final-${Date.now()}.mp4`);

  await run(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,
      "-vf",
      `fps=${fps}`,
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outPath,
    ],
    { timeoutMs: 240000 }
  );

  return outPath;
}

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
  let localMusic = null;
  let normalizedVideo = null;
  let outPath = null;
  let token = null;

  try {
    const body = req.body || {};

    // вход
    const hook = String(body.hook ?? "");
    const description = String(body.description ?? "");

    const durationSecRaw = body.durationSec;
    const durationSec = Number.isFinite(Number(durationSecRaw))
      ? Math.min(Math.max(Number(durationSecRaw), MIN_SEC), MAX_SEC)
      : 12;

    // поддержка разных имён полей
    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    if (!videoFileId) return res.status(400).json({ error: "videoFileId required" });

    const serve = await getBundle();

    // 1) download sources
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}.mp4`);
    await downloadFromDrive(videoFileId, localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 2) нормализуем видео (айфон VFR -> CFR 60fps) ✅
    normalizedVideo = await normalizeVideoToCfr(localVideo, TARGET_FPS);

    // 3) orientation -> fitMode
    const { w, h } = await getVideoDims(normalizedVideo);
    const isHorizontal = w > h;
    const fitMode = isHorizontal ? "contain" : "cover";

    console.log("VIDEO_DIMS:", { w, h, isHorizontal, fitMode, fps: TARGET_FPS });

    // 4) раздаём локальные ассеты (Chromium должен брать по HTTP)
    token = registerAssets({ videoPath: normalizedVideo, musicPath: localMusic });

    // Внутри контейнера Chromium стучится в этот же сервис — 127.0.0.1 работает
    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    // 5) ВАЖНО: отдаём ВСЕ варианты названий, чтобы Short не ломался при смене полей
    const inputProps = {
      hook,
      description,
      durationSec,
      fitMode,

      // варианты под разные Short.tsx
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
        fps: TARGET_FPS,
        durationInFrames: Math.round(durationSec * TARGET_FPS),
      },
      serveUrl: serve,
      codec: "h264",
      outputLocation: outPath,
      inputProps,

      // чтобы не падало на медленном старте видео
      timeoutInMilliseconds: 240000,
    });

    // Если захочешь финализировать (обычно не надо, но можно):
    // outPath = await finalizeOutputSmooth(outPath, TARGET_FPS);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", async () => {
      try {
        if (token) cleanupToken(token);
        if (outPath) await fsp.unlink(outPath).catch(() => {});
        if (localVideo) await fsp.unlink(localVideo).catch(() => {});
        if (normalizedVideo) await fsp.unlink(normalizedVideo).catch(() => {});
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
      if (normalizedVideo) await fsp.unlink(normalizedVideo).catch(() => {});
      if (localMusic) await fsp.unlink(localMusic).catch(() => {});
    } catch {}
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
