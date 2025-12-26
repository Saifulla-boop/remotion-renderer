// server.mjs (NO Google Drive upload; returns mp4 as response)
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
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// -------------------- Google Drive (Service Account) --------------------
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

// -------------------- Remotion bundle cache --------------------
let serveUrl = null;

async function getBundle() {
  if (serveUrl) return serveUrl;
  serveUrl = await bundle({
    entryPoint: path.join(process.cwd(), "remotion", "src", "index.ts"),
  });
  return serveUrl;
}

// -------------------- Temporary asset registry (token -> file paths) --------------------
const ASSETS = new Map(); // token -> { videoPath, musicPath?, expiresAt }

function createToken() {
  return crypto.randomBytes(16).toString("hex");
}

function registerAssets({ videoPath, musicPath }) {
  const token = createToken();
  ASSETS.set(token, {
    videoPath,
    musicPath,
    expiresAt: Date.now() + 15 * 60 * 1000, // 15 minutes
  });
  return token;
}

function cleanupToken(token) {
  ASSETS.delete(token);
}

// cleanup expired tokens
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of ASSETS.entries()) {
    if (entry.expiresAt < now) ASSETS.delete(token);
  }
}, 2 * 60 * 1000);

// Serve local temp files over HTTP so OffthreadVideo can read them
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

// -------------------- Routes --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /render
 * Body:
 * {
 *   "hook": "Почему нет продаж?",
 *   "videoFileId": "...",   // required
 *   "musicFileId": "...",   // optional
 *   "durationSec": 12
 * }
 *
 * Response: mp4 binary (video/mp4)
 */
app.post("/render", async (req, res) => {
  let localVideo = null;
  let localMusic = null;
  let outPath = null;
  let token = null;

  try {
    const { hook, videoFileId, musicFileId, durationSec } = req.body || {};
    if (!videoFileId) return res.status(400).json({ error: "videoFileId required" });

    const duration = Number.isFinite(Number(durationSec))
      ? Math.min(Math.max(Number(durationSec), 6), 20)
      : 12;

    const serve = await getBundle();

    // 1) Download inputs to /tmp
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}.mp4`);
    await downloadFromDrive(videoFileId, localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 2) Register temp assets and build local HTTP URLs
    token = registerAssets({ videoPath: localVideo, musicPath: localMusic });

    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    const inputProps = {
      hook: String(hook ?? ""),
      videoUrl,
      musicUrl,
      durationSec: duration,
    };

    await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps,
    });

    // 3) Render mp4 to /tmp
    outPath = path.join(os.tmpdir(), `out-${Date.now()}.mp4`);

    await renderMedia({
      composition: {
        id: "Short",
        width: 1080,
        height: 1920,
        fps: 30,
        durationInFrames: Math.round(duration * 30),
        defaultProps: inputProps,
        props: inputProps,
      },
      serveUrl: serve,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    // 4) Return mp4 as binary response
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    // когда отдали — почистим файлы
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
    // cleanup if failed before streaming
    if (token) cleanupToken(token);
    if (outPath) await fsp.unlink(outPath).catch(() => {});
    if (localVideo) await fsp.unlink(localVideo).catch(() => {});
    if (localMusic) await fsp.unlink(localMusic).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
