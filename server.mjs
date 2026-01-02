import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// На всякий случай: n8n иногда шлёт не строго JSON
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// ========= CONFIG =========
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

// Google Drive public download URL
const driveDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

/**
 * Скачивание файла по fileId в /tmp и возврат абсолютного пути.
 * Это и есть downloadToTmp(): просто хелпер, чтобы Remotion мог читать локальный файл.
 */
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const url = driveDownloadUrl(safeId);
  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  if (!res.body) throw new Error("Download failed: empty body");

  // Node18 fetch() -> res.body = WebStream. Переводим в Node stream корректно:
  await pipeline(Readable.fromWeb(res.body), fileStream);

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). Drive probably returned HTML instead of a file. fileId=${safeId}`
    );
  }

  return tmpPath;
}

let serveUrl = null;

async function prepareRemotion() {
  console.log("[remotion] bundling...");
  serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => config,
  });
  console.log("[remotion] bundle ready:", serveUrl);
}

app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  let videoPath = null;
  let musicPath = null;
  let outPath = null;

  try {
    const body = req.body || {};

    const hook = body.hook;
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    // ✅ поддержка обоих вариантов имён
    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    // ---- Валидация
    if (!hook || typeof hook !== "string") throw new Error("hook is missing (string required)");
    if (typeof description !== "string") throw new Error("description must be a string");

    if (!videoFileId || typeof videoFileId !== "string") {
      throw new Error("videoFileId (or videoFieldId) is missing (string required)");
    }
    if (!musicFileId || typeof musicFileId !== "string") {
      throw new Error("musicFileId (or musicFieldId) is missing (string required)");
    }

    const dur = Number(durationSec ?? 12);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("durationSec must be a positive number");

    console.log("[render] incoming:", {
      hookLen: hook.length,
      descriptionLen: description.length,
      videoFileId: cleanId(videoFileId),
      musicFileId: cleanId(musicFileId),
      durationSec: dur,
    });

    // ---- Скачиваем исходники
    videoPath = await downloadToTmp({ fileId: videoFileId, ext: "mp4" });
    musicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

    console.log("[render] downloaded sizes:", {
      videoSize: fs.statSync(videoPath).size,
      musicSize: fs.statSync(musicPath).size,
    });

    // ---- props для Remotion
    const inputProps = {
      hook,
      description,
      durationSec: dur,
      videoPath,
      musicPath,
    };

    console.log("[render] inputProps (will be applied):", {
      durationSec: inputProps.durationSec,
      videoPath: inputProps.videoPath,
      musicPath: inputProps.musicPath,
    });

    // ✅ КЛЮЧЕВОЙ ФИКС: selectComposition гарантированно применяет inputProps
    const comp = await selectComposition({
      serveUrl,
      id: COMPOSITION_ID,
      inputProps,
    });

    // (опционально) если хочешь реально менять длительность — можно так:
    // comp.durationInFrames = Math.round(comp.fps * dur);

    outPath = path.join(os.tmpdir(), `render-${Date.now()}.mp4`);

    await renderMedia({
      composition: comp,
      serveUrl,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", () => {
      try { if (outPath) fs.unlinkSync(outPath); } catch {}
      try { if (videoPath) fs.unlinkSync(videoPath); } catch {}
      try { if (musicPath) fs.unlinkSync(musicPath); } catch {}
    });
  } catch (e) {
    console.error("[render] error:", e);
    res.status(400).json({ ok: false, error: String(e?.message || e) });

    // cleanup на ошибке тоже
    try { if (outPath && fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch {}
    try { if (videoPath && fs.existsSync(videoPath)) fs.unlinkSync(videoPath); } catch {}
    try { if (musicPath && fs.existsSync(musicPath)) fs.unlinkSync(musicPath); } catch {}
  }
});

const port = process.env.PORT || 3000;

prepareRemotion()
  .then(() => {
    app.listen(port, () => console.log(`Server listening on :${port}`));
  })
  .catch((e) => {
    console.error("Failed to start Remotion server:", e);
    process.exit(1);
  });
