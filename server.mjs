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

// -------------------- ffmpeg/ffprobe helpers --------------------
function run(cmd, args, { timeoutMs = 25000 } = {}) {
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

// ✅ ВАЖНО: перекод в H.264 MP4 (Chromium на Linux стабильно это ест)
async function transcodeToH264Mp4(inPath, outPath) {
  // 10 минут на перекод (на случай больших файлов)
  await run(
    "ffmpeg",
    [
      "-y",
      "-i",
      inPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-movflags",
      "+faststart",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      outPath,
    ],
    { timeoutMs: 10 * 60 * 1000 }
  );

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(`Transcoded file too small (${stat.size}).`);
  }

  return outPath;
}

async function ensurePlayableVideo(inputPath) {
  // Самый надёжный режим: всегда перегоняем в H.264 MP4
  // (потому что MOV/HEVC валит Chromium => delayRender timeout)
  const outPath = path.join(os.tmpdir(), `playable-${Date.now()}.mp4`);
  await transcodeToH264Mp4(inputPath, outPath);
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
  let localVideo = null;      // исходник с диска
  let playableVideo = null;   // перекодированный mp4
  let localMusic = null;
  let outPath = null;
  let token = null;

  try {
    const body = req.body || {};

    // ✅ поддержка разных имен входных полей
    const hook = body.hook ?? "";
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;

    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    if (!videoFileId) return res.status(400).json({ error: "videoFileId required" });

    const duration = Number.isFinite(Number(durationSec))
      ? Math.min(Math.max(Number(durationSec), 6), 30)
      : 12;

    const serve = await getBundle();

    // 1) download sources to /tmp
    //    (НЕ привязываемся к расширению — с Drive может прилететь MOV)
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}`);
    await downloadFromDrive(videoFileId, localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 2) ✅ делаем видео гарантированно декодируемым (H.264 MP4)
    playableVideo = await ensurePlayableVideo(localVideo);
    // исходник больше не нужен
    await fsp.unlink(localVideo).catch(() => {});
    localVideo = null;

    // 3) detect orientation уже по playable mp4
    const { w, h } = await getVideoDims(playableVideo);
    const isHorizontal = w > h;
    const fitMode = isHorizontal ? "contain" : "cover";

    console.log("VIDEO_DIMS:", { w, h, isHorizontal, fitMode });

    // 4) serve local assets via HTTP
    token = registerAssets({ videoPath: playableVideo, musicPath: localMusic });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    // ✅ КЛЮЧЕВОЕ: передаем сразу ВСЕ варианты названий пропсов
    const inputProps = {
      hook: String(hook ?? ""),
      description: String(description ?? ""),
      durationSec: duration,
      fitMode,

      // старый вариант
      videoUrl,
      musicUrl,

      // новые варианты (на будущее)
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
        fps: 30,
        durationInFrames: Math.round(duration * 30),
      },
      serveUrl: serve,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", async () => {
      try {
        if (token) cleanupToken(token);
        if (outPath) await fsp.unlink(outPath).catch(() => {});
        if (playableVideo) await fsp.unlink(playableVideo).catch(() => {});
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
      if (playableVideo) await fsp.unlink(playableVideo).catch(() => {});
      if (localMusic) await fsp.unlink(localMusic).catch(() => {});
    } catch {}
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
