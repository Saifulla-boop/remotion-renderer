import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch"; // если у тебя реально установлен node-fetch - ок. Если нет, скажи, дам версию без него.
import { fileURLToPath } from "url";
import { Readable } from "stream";

import { bundle, getCompositions, renderMedia } from "@remotion/renderer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "2mb" }));

/**
 * ============ CONFIG ============
 * 1) Путь к Remotion проекту
 */
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");

/**
 * 2) Название композиции (compositionId) в Remotion
 */
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

/**
 * 3) Google Drive
 */
const driveDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
    fileId
  )}`;

/**
 * Чистим случайные символы типа "=" в fileId
 */
const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

/**
 * Скачиваем файл во временную папку
 * Node 18: fetch возвращает Web ReadableStream -> его нельзя pipe() напрямую.
 * Конвертим через Readable.fromWeb().
 */
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const url = driveDownloadUrl(safeId);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Drive download failed (${res.status}): ${url}`);
  }
  if (!res.body) {
    throw new Error("Drive download failed: response has no body");
  }

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  // ВАЖНО: Node 18 fetch -> WebStream, конвертим в Node stream
  const nodeStream = Readable.fromWeb(res.body);

  await new Promise((resolve, reject) => {
    nodeStream.pipe(fileStream);
    nodeStream.on("error", reject);
    fileStream.on("error", reject);
    fileStream.on("finish", resolve);
  });

  // минимальная проверка размера
  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). Probably Drive returned an HTML page (not a file). fileId=${safeId}`
    );
  }

  return tmpPath;
}

let bundleLocation = null;
let compositionsCache = null;

/**
 * Бандлим Remotion один раз при старте
 */
async function prepareRemotion() {
  console.log("[remotion] bundling...");
  bundleLocation = await bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => config,
  });
  console.log("[remotion] bundle ready:", bundleLocation);

  compositionsCache = await getCompositions(bundleLocation, {
    inputProps: {},
  });
  console.log(
    "[remotion] compositions:",
    compositionsCache.map((c) => c.id)
  );
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/**
 * Рендер
 */
app.post("/render", async (req, res) => {
  try {
    const { hook, description, videoFileId, musicFileId, durationSec } =
      req.body || {};

    // ---- Жёсткая валидация (чтобы не было "src undefined")
    if (!hook || typeof hook !== "string") {
      throw new Error("hook is missing (string required)");
    }
    if (typeof description !== "string") {
      throw new Error("description is missing (string required)");
    }
    if (!videoFileId || typeof videoFileId !== "string") {
      throw new Error("videoFileId is missing (string required)");
    }
    if (!musicFileId || typeof musicFileId !== "string") {
      throw new Error("musicFileId is missing (string required)");
    }

    const dur = Number(durationSec ?? 12);
    if (!Number.isFinite(dur) || dur <= 0) {
      throw new Error("durationSec must be a positive number");
    }

    console.log("[render] input:", {
      hook,
      descriptionLen: description.length,
      videoFileId: cleanId(videoFileId),
      musicFileId: cleanId(musicFileId),
      durationSec: dur,
    });

    // ---- Скачиваем исходники
    const videoPath = await downloadToTmp({ fileId: videoFileId, ext: "mp4" });
    const musicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

    if (!videoPath || typeof videoPath !== "string") {
      throw new Error("videoPath is missing after download");
    }
    if (!musicPath || typeof musicPath !== "string") {
      throw new Error("musicPath is missing after download");
    }

    // ---- Ищем композицию
    const comps =
      compositionsCache ||
      (await getCompositions(bundleLocation, { inputProps: {} }));

    const comp = comps.find((c) => c.id === COMPOSITION_ID);

    if (!comp) {
      throw new Error(
        `Composition "${COMPOSITION_ID}" not found. Available: ${comps
          .map((c) => c.id)
          .join(", ")}`
      );
    }

    const outPath = path.join(os.tmpdir(), `render-${Date.now()}.mp4`);

    // ---- inputProps, которые должны использоваться в Short.tsx
    const inputProps = {
      hook,
      description,
      durationSec: dur,
      videoPath,
      musicPath,
    };

    console.log("[render] inputProps:", {
      hook: inputProps.hook,
      descriptionLen: inputProps.description.length,
      durationSec: inputProps.durationSec,
      videoPath: inputProps.videoPath,
      musicPath: inputProps.musicPath,
    });

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
    //  inputProps MUST be passed:
      inputProps,
      // crf: 18,
      // preset: "medium",
    });

    // ---- Отдаём файл бинарём
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", () => {
      // чистим мусор
      try {
        fs.unlinkSync(outPath);
      } catch {}
      try {
        fs.unlinkSync(videoPath);
      } catch {}
      try {
        fs.unlinkSync(musicPath);
      } catch {}
    });
  } catch (e) {
    console.error("[render] error:", e);
    res.status(400).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// старт
const port = process.env.PORT || 3000;

prepareRemotion()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on :${port}`);
    });
  })
  .catch((e) => {
    console.error("Failed to start Remotion server:", e);
    process.exit(1);
  });
