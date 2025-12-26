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

// ---------- Google Drive ----------
function getDrive() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!email || !key) {
    throw new Error("Google Drive credentials missing");
  }

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

async function uploadToDrive(filePath) {
  const drive = getDrive();
  const folderId = process.env.DRIVE_FOLDER_ID;

  const res = await drive.files.create({
    requestBody: {
      name: `short-${Date.now()}.mp4`,
      parents: [folderId],
      mimeType: "video/mp4",
    },
    media: {
      mimeType: "video/mp4",
      body: fs.createReadStream(filePath),
    },
    fields: "id",
  });

  const fileId = res.data.id;

  await drive.permissions.create({
    fileId,
    requestBody: { type: "anyone", role: "reader" },
  });

  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

// ---------- Remotion ----------
let serveUrl;

async function getBundle() {
  if (!serveUrl) {
    serveUrl = await bundle({
      entryPoint: path.join(process.cwd(), "remotion", "src", "index.ts"),
    });
  }
  return serveUrl;
}

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  try {
    const { hook, videoUrl, musicUrl, durationSec = 12 } = req.body;

    const serve = await getBundle();

    const composition = await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps: { hook, videoUrl, musicUrl, durationSec },
    });

    const outPath = path.join(os.tmpdir(), `out-${Date.now()}.mp4`);

    await renderMedia({
      composition: {
        ...composition,
        durationInFrames: durationSec * 30,
        fps: 30,
      },
      serveUrl: serve,
      codec: "h264",
      outputLocation: outPath,
      inputProps: { hook, videoUrl, musicUrl, durationSec },
    });

    const mp4Url = await uploadToDrive(outPath);
    await fsp.unlink(outPath);

    res.json({ mp4_url: mp4Url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`Remotion renderer running on ${PORT}`)
);
