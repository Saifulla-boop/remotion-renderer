// server.mjs
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
app.use(express.json({ limit: "5mb" }));

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

  return outPath;
}

// -------------------- Local assets served via HTTP (for OffthreadVideo) --------------------
/**
 * token -> { videoPath: string, musicPath?: string, expiresAt: number }
 */
const ASSETS = new Map();

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

// -------------------- ffmpeg helpers (auto-zoom) --------------------
function run(cmd, args, { timeoutMs = 30000 } = {}) {
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

function parseLastCrop(ffmpegStderr) {
  const matches = [...ffmpegStderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  if (!matches.length) return null;
  const m = matches[matches.length - 1];
  return {
    cw: Number(m[1]),
    ch: Number(m[2]),
    cx: Number(m[3]),
    cy: Number(m[4]),
  };
}

function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/**
 * detectAutoZoom:
 * - if video has "baked-in" black bars, cropdetect finds smaller useful area
 * - zoom = max(W/cropW, H/cropH)
 * - we sample multiple timestamps to avoid false detections
 */
async function detectAutoZoom(filePath) {
  const { w, h } = await getVideoDims(filePath);

  const sampleTimes = ["0.2", "1.0", "1.8"]; // seconds
  const zooms = [];

  for (const ss of sampleTimes) {
    try {
      const { err } = await run("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "info",
        "-ss",
        ss,
        "-t",
        "0.6",
        "-i",
        filePath,
        "-vf",
        "cropdetect=24:16:0",
        "-f",
        "null",
        "-",
      ]);

      const crop = parseLastCrop(err);
      if (!crop?.cw || !crop?.ch) continue;

      const sameW = crop.cw / w > 0.97;
      const sameH = crop.ch / h > 0.97;

      if (sameW && sameH) {
        zooms.push(1.0);
        continue;
      }

      let z = Math.max(w / crop.cw, h / crop.ch);
      z = Math.max(1.0, Math.min(2.3, z));
      zooms.push(z);
    } catch {
      // ignore this sample
    }
  }

  if (!zooms.length) {
    return { forceZoom: 1.0, meta: { w, h, zooms: [] } };
  }

  // берём медиану — стабильнее
  const forceZoom = Math.max(1.0, Math.min(2.3, median(zooms)));
  return { forceZoom, meta: { w, h, zooms } };
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

/**
 * POST /render
 * Body:
 * {
 *   "hook": "Почему нет продаж?",
 *   "videoFileId": "...",
 *   "musicFileId": "...",   // optional
 *   "durationSec": 12,
 *   "textPosition": "auto" | "top" | "center" // optional
 * }
 *
 * Response: mp4 binary
 */
app.post("/render", async (req, res) => {
  let localVideo = null;
  let localMusic = null;
  let outPath = null;
  let token = null;

  try {
    const { hook, videoFileId, musicFileId, durationSec, textPosition } =
      req.body || {};

    if (!videoFileId) {
      return res.status(400).json({ error: "videoFileId required" });
    }

    const duration = Number.isFinite(Number(durationSec))
      ? Math.min(Math.max(Number(durationSec), 6), 30)
      : 12;

    const serve = await getBundle();

    // 1) download sources to /tmp
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}.mp4`);
    await downloadFromDrive(videoFileId, localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 2) compute auto-zoom (fix baked black bars)
    const { forceZoom, meta } = await detectAutoZoom(localVideo);
    console.log("AUTOZOOM:", forceZoom, meta);

    // 3) register local assets for OffthreadVideo via HTTP
    token = registerAssets({ videoPath: localVideo, musicPath: localMusic });
    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    const inputProps = {
      hook: String(hook ?? ""),
      videoUrl,
      musicUrl,
      durationSec: duration,
      textPosition: textPosition || "auto",
      forceZoom,
    };

    // 4) select composition
    const composition = await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps,
    });

    // 5) render mp4
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

    // 6) send binary mp4
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", async () => {
      try {
        if (token) cleanupToken(token);
        if (outPath) await fsp.unlink(outPath).catch(() => {});
        if (localVideo) await fsp.unlink(localVideo).catch(() => {});
        if (localMusic) await fsp.unlink(localMusic).catch(() => {});
      } catch {}
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || "Render failed" });
    }
    if (token) cleanupToken(token);
    if (outPath) await fsp.unlink(outPath).catch(() => {});
    if (localVideo) await fsp.unlink(localVideo).catch(() => {});
    if (localMusic) await fsp.unlink(localMusic).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
