import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia } from "@remotion/renderer";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "10mb" }));

// ========= CONFIG =========
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getDriveClient() {
  const clientEmail = requireEnv("GOOGLE_CLIENT_EMAIL");
  let privateKey = requireEnv("GOOGLE_PRIVATE_KEY");
  privateKey = privateKey.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

const drive = getDriveClient();

// ✅ скачивание файла через Drive API (alt=media)
async function downloadToTmpViaApi({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);

  // stream download
  const res = await drive.files.get(
    { fileId: safeId, alt: "media" },
    { responseType: "stream" }
  );

  const fileStream = fs.createWriteStream(tmpPath);
  await pipeline(res.data, fileStream);

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file too small (size=${stat.size}). Check access/share for fileId=${safeId}`
    );
  }

  return tmpPath;
}

let bundleLocation = null;
let compositionsCache = null;

async function prepareRemotion() {
  console.log("[remotion] bundling...");
  bundleLocation = await bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => config,
  });

  console.log("[remotion] bundle ready:", bundleLocation);

  compositionsCache = await getCompositions(bundleLocation, { inputProps: {} });
  console.log(
    "[remotion] compositions:",
    compositionsCache.map((c) => c.id).join(", ")
  );
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  try {
    const body = req.body || {};

    const hook = body.hook;
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    if (!hook || typeof hook !== "string") throw new Error("hook is missing (string required)");
    if (typeof description !== "string") throw new Error("description must be a string");
    if (!videoFileId || typeof videoFileId !== "string")
      throw new Error("videoFileId (or videoFieldId) is missing (string required)");
    if (!musicFileId || typeof musicFileId !== "string")
      throw new Error("musicFileId (or musicFieldId) is missing (string required)");

    const dur = Number(durationSec ?? 12);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("durationSec must be a positive number");

    console.log("[render] incoming:", {
      hookLen: hook.length,
      descriptionLen: description.length,
      videoFileId: cleanId(videoFileId),
      musicFileId: cleanId(musicFileId),
      durationSec: dur,
    });

    // ✅ качаем через Drive API (без confirm/virus страниц)
    const videoPath = await downloadToTmpViaApi({ fileId: videoFileId, ext: "mp4" });
    const musicPath = await downloadToTmpViaApi({ fileId: musicFileId, ext: "mp3" });

    const comps =
      compositionsCache || (await getCompositions(bundleLocation, { inputProps: {} }));

    const comp = comps.find((c) => c.id === COMPOSITION_ID);
    if (!comp) {
      throw new Error(
        `Composition "${COMPOSITION_ID}" not found. Available: ${comps.map((c) => c.id).join(", ")}`
      );
    }

    const outPath = path.join(os.tmpdir(), `render-${Date.now()}.mp4`);

    // ✅ передаем оба варианта пропсов для совместимости
    const inputProps = {
      hook,
      description,
      durationSec: dur,

      videoPath,
      musicPath,

      videoSrc: videoPath,
      musicSrc: musicPath,
    };

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", () => {
      try { fs.unlinkSync(outPath); } catch {}
      try { fs.unlinkSync(videoPath); } catch {}
      try { fs.unlinkSync(musicPath); } catch {}
    });
  } catch (e) {
    console.error("[render] error:", e);
    res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

const port = process.env.PORT || 3000;

prepareRemotion()
  .then(() => app.listen(port, () => console.log(`Server listening on :${port}`)))
  .catch((e) => {
    console.error("Failed to start Remotion server:", e);
    process.exit(1);
  });
