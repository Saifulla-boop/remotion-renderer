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

// ===== FPS =====
// По умолчанию 30 (быстрее и стабильнее на Railway). Для 60: OUTPUT_FPS=60
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

// -------------------- run ffmpeg/ffprobe --------------------
function run(cmd, args, { timeoutMs = 180000 } = {}) {
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

// ✅ Нормализация айфон-видео: VFR -> CFR + faststart (чтобы metadata была сразу)
async function normalizeVideoToCfr(inputPath, fps = OUTPUT_FPS) {
  const outPath = path.join(os.tmpdir(), `cfr-${Date.now()}.mp4`);

  await run(
    "ffmpeg",
    [
      "-y",
      "-i",
      inputPath,

      // делаем ровный FPS
      "-vf",
      `fps=${fps}`,
      "-r",
      String(fps),

      // стабильный декод в Chromium
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

      // звук выкидываем (музыка отдельной дорожкой)
      "-an",
      outPath,
    ],
    { timeoutMs: 240000 }
  );

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(`normalizeVideoToCfr produced too small file (${stat.size})`);
  }

  return outPath;
}

// -------------------- Local assets served via HTTP (Chromium needs RANGE) --------------------
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

// ✅ Range helper (главное исправление)
function serveWithRange(req, res, filePath, contentType) {
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

  // bytes=start-end
  const match = String(range).match(/bytes=(\d+)-(\d*)/);
  if (!match) {
    res.status(416).end();
    return;
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize || start > end) {
    res.status(416).end();
    return;
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

  fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get("/asset/:token/video", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.videoPath) return res.status(404).send("Not found");
  serveWithRange(req, res, entry.videoPath, "video/mp4");
});

app.get("/asset/:token/music", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.musicPath) return res.status(404).send("Not found");
  serveWithRange(req, res, entry.musicPath, "audio/mpeg");
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
  let localMusic = null;
  let normalizedVideo = null;
  let outPath = null;
  let token = null;

  try {
    const body = req.body || {};

    const hook = String(body.hook ?? "");
    const description = String(body.description ?? "");
    const durationSecRaw = body.durationSec;

    const durationSec = Number.isFinite(Number(durationSecRaw))
      ? Math.min(Math.max(Number(durationSecRaw), MIN_SEC), MAX_SEC)
      : 12;

    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;

    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    if (!videoFileId) return res.status(400).json({ error: "videoFileId required" });

    const serve = await getBundle();

    // 1) скачиваем
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}.mp4`);
    await downloadFromDrive(videoFileId, localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 2) нормализуем (VFR -> CFR)
    normalizedVideo = await normalizeVideoToCfr(localVideo, OUTPUT_FPS);

    // 3) orientation
    const { w, h } = await getVideoDims(normalizedVideo);
    const isHorizontal = w > h;
    const fitMode = isHorizontal ? "contain" : "cover";

    console.log("VIDEO:", { w, h, isHorizontal, fitMode, OUTPUT_FPS });

    // 4) ассеты по HTTP с Range
    token = registerAssets({ videoPath: normalizedVideo, musicPath: localMusic });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    // 5) props под любые варианты Short.tsx
    const inputProps = {
      hook,
      description,
      durationSec,
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
        durationInFrames: Math.round(durationSec * OUTPUT_FPS),
      },
      serveUrl: serve,
      codec: "h264",
      outputLocation: outPath,
      inputProps,

      // таймаут увеличили, но теперь не должен упираться в delayRender
      timeoutInMilliseconds: 240000,
    });

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
  console.log(`Remotion renderer running on ${PORT}, OUTPUT_FPS=${OUTPUT_FPS}`);
});
