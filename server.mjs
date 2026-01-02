import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

import { getCompositions, renderMedia } from "@remotion/renderer";
import { bundle } from "@remotion/bundler";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Можно увеличить лимит, чтобы длинные описания не резало
app.use(express.json({ limit: "10mb" }));

/**
 * ============ CONFIG ============
 */
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

/**
 * Google Drive download URL
 */
const driveDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

/**
 * Download file to tmp
 */
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const url = driveDownloadUrl(safeId);

  // Node 18+ имеет глобальный fetch
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Drive download failed (${res.status}): ${url}`);

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). Drive returned HTML/not-file. fileId=${safeId}`
    );
  }

  return tmpPath;
}

/**
 * ========= Remotion lazy init =========
 * Не блокируем старт сервера. Railway должен увидеть открытый порт сразу.
 */
let bundleLocation = null;
let compositionsCache = null;
let initPromise = null;

async function ensureRemotionReady() {
  if (bundleLocation && compositionsCache) return;

  if (!initPromise) {
    initPromise = (async () => {
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
    })().catch((e) => {
      // если инициализация упала — обнуляем, чтобы можно было попробовать снова
      initPromise = null;
      throw e;
    });
  }

  await initPromise;
}

/**
 * Health
 */
app.get("/health", (req, res) => {
  res.json({ ok: true, status: "alive" });
});

app.get("/render", (req, res) => {
  res
    .status(200)
    .send("OK. Use POST /render with JSON body: {hook, description, videoFileId, musicFileId, durationSec}");
});

/**
 * Render endpoint
 */
app.post("/render", async (req, res) => {
  let outPath = null;
  let videoPath = null;
  let musicPath = null;

  try {
    const { hook, description, videoFileId, musicFileId, durationSec } = req.body || {};

    // ---- Валидация
    if (!hook || typeof hook !== "string") throw new Error("hook is missing (string required)");
    if (typeof description !== "string") throw new Error("description is missing (string required)");
    if (!videoFileId || typeof videoFileId !== "string") throw new Error("videoFileId is missing (string required)");
    if (!musicFileId || typeof musicFileId !== "string") throw new Error("musicFileId is missing (string required)");

    const dur = Number(durationSec ?? 12);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("durationSec must be a positive number");

    console.log("[render] input:", {
      hook,
      descriptionLen: description.length,
      videoFileId: cleanId(videoFileId),
      musicFileId: cleanId(musicFileId),
      durationSec: dur,
    });

    // ---- Remotion init (лениво)
    await ensureRemotionReady();

    // ---- Скачиваем исходники
    videoPath = await downloadToTmp({ fileId: videoFileId, ext: "mp4" });
    musicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

    // ---- Композиция
    const comps = compositionsCache || (await getCompositions(bundleLocation, { inputProps: {} }));
    const comp = comps.find((c) => c.id === COMPOSITION_ID);
    if (!comp) {
      throw new Error(
        `Composition "${COMPOSITION_ID}" not found. Available: ${comps.map((c) => c.id).join(", ")}`
      );
    }

    outPath = path.join(os.tmpdir(), `render-${Date.now()}.mp4`);

    const inputProps = {
      hook,
      description,
      durationSec: dur,
      videoPath,
      musicPath,
    };

    console.log("[render] start renderMedia...", {
      comp: comp.id,
      durationSec: inputProps.durationSec,
    });

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
      // Можно ускорять/качество:
      // crf: 18,
      // preset: "medium",
    });

    // ---- Отдаём mp4
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    // чистка по закрытию соединения/окончанию
    res.on("close", () => {
      try { if (outPath) fs.unlinkSync(outPath); } catch {}
      try { if (videoPath) fs.unlinkSync(videoPath); } catch {}
      try { if (musicPath) fs.unlinkSync(musicPath); } catch {}
    });
  } catch (e) {
    console.error("[render] error:", e);
    res.status(400).json({ ok: false, error: String(e?.message || e) });

    // чистим мусор и при ошибке
    try { if (outPath) fs.unlinkSync(outPath); } catch {}
    try { if (videoPath) fs.unlinkSync(videoPath); } catch {}
    try { if (musicPath) fs.unlinkSync(musicPath); } catch {}
  }
});

/**
 * START: важно для Railway
 */
const port = process.env.PORT || 3000;

// Сразу открываем порт → Railway видит сервис живым
app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on ${port}`);
  // можно прогреть remotion на фоне (не обязательно)
  // ensureRemotionReady().catch((e) => console.error("[remotion] warmup failed:", e));
});
