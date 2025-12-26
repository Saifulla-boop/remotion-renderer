// server.mjs
import express from "express";
import os from "os";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
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

  // Railway часто хранит многострочный ключ с \n — восстанавливаем переносы
  const key = keyRaw.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

/**
 * Скачивает файл из Google Drive по fileId во временный путь.
 * ВАЖНО: файл/папка должны быть расшарены на сервисный аккаунт (Editor/Viewer достаточно на чтение).
 */
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

/**
 * Загружает mp4 в папку DRIVE_FOLDER_ID и делает файл публичным.
 */
async function uploadMp4ToDrive(localPath) {
  const drive = getDrive();
  const folderId = process.env.DRIVE_FOLDER_ID;

  if (!folderId) {
    throw new Error("Missing DRIVE_FOLDER_ID env var.");
  }

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
  if (!fileId) {
    throw new Error("Drive upload failed: no fileId returned.");
  }

  // Make public
  await drive.permissions.create({
    fileId,
    requestBody: { type: "anyone", role: "reader" },
  });

  // Direct download URL
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

// -------------------- Routes --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /render
 * Body:
 * {
 *   "hook": "Почему нет продаж?",
 *   "videoFileId": "....",     // Google Drive fileId
 *   "musicFileId": "....",     // Google Drive fileId (optional)
 *   "durationSec": 12
 * }
 */
app.post("/render", async (req, res) => {
  let localVideo = null;
  let localMusic = null;
  let outPath = null;

  try {
    const { hook, videoFileId, musicFileId, durationSec } = req.body || {};

    if (!videoFileId) {
      return res.status(400).json({ error: "videoFileId required" });
    }

    const duration = Number.isFinite(Number(durationSec))
      ? Math.min(Math.max(Number(durationSec), 6), 20)
      : 12;

    // 1) Bundle Remotion once
    const serve = await getBundle();

    // 2) Download assets from Drive to local temp files
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}.mp4`);
    await downloadFromDrive(videoFileId, localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(musicFileId, localMusic);
    }

    // 3) Render using local file:// URLs (stable, no HTML/redirect issues)
    const inputProps = {
      hook: String(hook ?? ""),
      videoUrl: `file://${localVideo}`,
      musicUrl: localMusic ? `file://${localMusic}` : "",
      durationSec: duration,
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

    // 4) Upload result to Drive (shorts_renders folder)
    const { mp4Url, fileId } = await uploadMp4ToDrive(outPath);

    return res.json({ mp4_url: mp4Url, file_id: fileId });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e?.message || "Render failed" });
  } finally {
    // cleanup temp files
    if (outPath) await fsp.unlink(outPath).catch(() => {});
    if (localVideo) await fsp.unlink(localVideo).catch(() => {});
    if (localMusic) await fsp.unlink(localMusic).catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
