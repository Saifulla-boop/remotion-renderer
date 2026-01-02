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

const PORT = process.env.PORT || 3000;
const FPS = 30;
const MIN_SEC = 6;
const MAX_SEC = 30;

/* ===================== GOOGLE DRIVE ===================== */
function getDrive() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const keyRaw = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !keyRaw) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY");
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
    res.data.pipe(dest);
    res.data.on("end", resolve);
    res.data.on("error", reject);
  });

  return outPath;
}

/* ===================== LOCAL ASSETS ===================== */
const ASSETS = new Map();

function createToken() {
  return crypto.randomBytes(16).toString("hex");
}

function registerAssets(videoPath, musicPath) {
  const token = createToken();
  ASSETS.set(token, {
    videoPath,
    musicPath,
    expiresAt: Date.now() + 15 * 60 * 1000,
  });
  return token;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ASSETS.entries()) {
    if (v.expiresAt < now) ASSETS.delete(k);
  }
}, 60_000);

app.get("/asset/:token/video", (req, res) => {
  const a = ASSETS.get(req.params.token);
  if (!a?.videoPath) return res.sendStatus(404);
  res.setHeader("Content-Type", "video/mp4");
  fs.createReadStream(a.videoPath).pipe(res);
});

app.get("/asset/:token/music", (req, res) => {
  const a = ASSETS.get(req.params.token);
  if (!a?.musicPath) return res.sendStatus(404);
  res.setHeader("Content-Type", "audio/mpeg");
  fs.createReadStream(a.musicPath).pipe(res);
});

/* ===================== REMOTION ===================== */
let serveUrl = null;

async function getBundle() {
  if (serveUrl) return serveUrl;
  serveUrl = await bundle({
    entryPoint: path.join(process.cwd(), "remotion", "src", "index.ts"),
  });
  return serveUrl;
}

/* ===================== ROUTES ===================== */
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  let videoFile = null;
  let musicFile = null;
  let outFile = null;
  let token = null;

  try {
    const body = req.body || {};

    const hook = String(body.hook ?? "");
    const description = String(body.description ?? "");
    const duration = Math.min(
      Math.max(Number(body.durationSec) || 12, MIN_SEC),
      MAX_SEC
    );

    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid;

    if (!videoFileId) {
      return res.status(400).json({ error: "videoFileId required" });
    }

    const serve = await getBundle();

    /* 1) download files */
    videoFile = path.join(os.tmpdir(), `video-${Date.now()}.mp4`);
    await downloadFromDrive(videoFileId, videoFile);

    if (musicFileId) {
      musicFile = path.join(os.tmpdir(), `music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, musicFile);
    }

    /* 2) serve via HTTP */
    token = registerAssets(videoFile, musicFile);
    const base = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${base}/asset/${token}/video`;
    const musicUrl = musicFile ? `${base}/asset/${token}/music` : "";

    const inputProps = {
      hook,
      description,
      durationSec: duration,

      videoUrl,
      musicUrl,

      videoPath: videoUrl,
      musicPath: musicUrl,
    };

    const composition = await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps,
    });

    outFile = path.join(os.tmpdir(), `out-${Date.now()}.mp4`);

    await renderMedia({
      serveUrl: serve,
      composition: {
        ...composition,
        fps: FPS,
        durationInFrames: Math.round(duration * FPS),
      },
      codec: "h264",
      outputLocation: outFile,
      inputProps,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);
    fs.createReadStream(outFile).pipe(res);

    res.on("close", async () => {
      try {
        if (token) ASSETS.delete(token);
        if (videoFile) await fsp.unlink(videoFile).catch(() => {});
        if (musicFile) await fsp.unlink(musicFile).catch(() => {});
        if (outFile) await fsp.unlink(outFile).catch(() => {});
      } catch {}
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) {
      res.status(500).json({ error: e.message || "Render failed" });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
