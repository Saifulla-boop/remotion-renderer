// server.mjs
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
    scopes: ["https://www.googleapis.com/auth/drive"],
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

async function uploadMp4ToDrive(localPath) {
  const drive = getDrive();
  const folderId = process.env.DRIVE_FOLDER_ID;

  if (!folderId) throw new Error("Missing DRIVE_FOLDER_ID env var.");

  const fileName = `short-${Date.now()}.mp4`;

  const createRes = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
      mimeType: "video/mp4",
    },
    media: {
      mimeType: "video/mp4",
      body: fs.createReadStream(localPath),
    },
    fields: "id",
  });

  const fileId = createRes.data.id;
  if (!fileId) throw new Error("Drive upload failed: no fileId returned.");

  await drive.permissions.create({
    fileId,
    requestBody: { type: "anyone", role: "reader" },
  });

  const mp4Url = `https://drive.google.com/uc?export=download&id=${fileId}`;
  return { mp4Url, fileId };
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
/**
 * token -> { videoPath: string, musicPath?: string, expiresAt: number }
 */
const ASSETS = new Map();

function createToken() {
  return crypto.randomBytes(16).toString("hex");
}

function registerAssets({ videoPath, musicPath }) {
  const token = createToken();
  // TTL 15 minutes
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

// clean expired tokens every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, v] of ASSETS.entries()) {
    if (v.expiresAt < now) ASSETS.delete(token);
  }
}, 2 * 60 * 1000);

// Serve local temp files over HTTP so OffthreadVideo can read them
app.get("/asset/:token/video", (req, res) => {
  const token = req.params.token;
  const entry = ASSETS.get(token);
  if (!entry?.videoPath) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(entry.videoPath).pipe(res);
});

app.get("/asset/:token/music", (req, res) => {
  const token = req.params.token;
  const entry = ASSETS.get(token);
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

    const composition = await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps,
    });

    // 3) Render mp4 to /tmp
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

    // 4) Upload output to Drive
    const { mp4Url, fileId } = await uploadMp4ToDrive(outPath);

    return res.json({ mp4_url: mp4Url, file_id: fileId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Render failed" });
  } finally {
    // 5) cleanup registry + files
    if (token) cleanupToken(token);
    if (outPath) await fsp.unlink(outPath).catch(() => {});
    if (localVideo) await fsp.unlink(localVideo).catch(() => {});
    if (localMusic) await fsp.unlink(localMusic).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
