import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { pipeline } from "stream/promises";

import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia } from "@remotion/renderer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "20mb" }));

// ========= CONFIG =========
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

const driveDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

/**
 * downloadToTmp()
 * Скачивает файл из Google Drive по публичному fileId в /tmp и возвращает путь.
 * Важно: Drive иногда отдаёт HTML вместо файла (если нет публичного доступа).
 * Мы это детектим и кидаем понятную ошибку.
 */
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const url = driveDownloadUrl(safeId);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) {
    throw new Error(`Drive download failed (${res.status}). fileId=${safeId}`);
  }
  if (!res.body) {
    throw new Error(`Drive download failed: empty body. fileId=${safeId}`);
  }

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  // Node18 fetch -> WebStream -> convert:
  await pipeline(Readable.fromWeb(res.body), fileStream);

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). Probably Drive returned HTML. fileId=${safeId}`
    );
  }

  // 🔥 Жёсткая проверка: не HTML ли это
  const headBuf = fs.readFileSync(tmpPath);
  const headText = headBuf.slice(0, 800).toString("utf8").toLowerCase();
  if (headText.includes("<html") || headText.includes("<!doctype")) {
    throw new Error(
      `Drive returned HTML instead of media. Make file public ("Anyone with link"). fileId=${safeId}`
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
  let videoPath = null;
  let musicPath = null;
  let outPath = null;

  try {
    const body = req.body || {};

    const hook = body.hook;
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    // ✅ поддержка обоих вариантов
    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    // (опционально) имена, чтобы правильно выбрать расширение
    const videoName = body.videoName ?? "";
    const musicName = body.musicName ?? "";

    // ---- Валидация
    if (!hook || typeof hook !== "string") {
      throw new Error("hook is missing (string required)");
    }
    if (typeof description !== "string") {
      throw new Error("description must be a string");
    }
    if (!videoFileId || typeof videoFileId !== "string") {
      throw new Error("videoFileId (or videoFieldId) is missing (string required)");
    }
    if (!musicFileId || typeof musicFileId !== "string") {
      throw new Error("musicFileId (or musicFieldId) is missing (string required)");
    }

    const dur = Number(durationSec ?? 12);
    if (!Number.isFinite(dur) || dur <= 0) {
      throw new Error("durationSec must be a positive number");
    }

    // ---- Расширения (если пришли имена)
    const videoExtFromName = path.extname(videoName).replace(".", "").toLowerCase();
    const musicExtFromName = path.extname(musicName).replace(".", "").toLowerCase();

    const videoExt = videoExtFromName || "mp4";
    const musicExt = musicExtFromName || "mp3";

    console.log("[render] incoming:", {
      hookLen: hook.length,
      descriptionLen: description.length,
      durationSec: dur,
      videoFileId: cleanId(videoFileId),
      musicFileId: cleanId(musicFileId),
      videoName,
      musicName,
      videoExt,
      musicExt,
    });

    // ---- Скачиваем исходники
    videoPath = await downloadToTmp({ fileId: videoFileId, ext: videoExt });
    musicPath = await downloadToTmp({ fileId: musicFileId, ext: musicExt });

    // ---- Находим композицию
    const comps =
      compositionsCache || (await getCompositions(bundleLocation, { inputProps: {} }));

    const comp = comps.find((c) => c.id === COMPOSITION_ID);
    if (!comp) {
      throw new Error(
        `Composition "${COMPOSITION_ID}" not found. Available: ${comps
          .map((c) => c.id)
          .join(", ")}`
      );
    }

    outPath = path.join(os.tmpdir(), `render-${Date.now()}.mp4`);

    // ---- inputProps для Short.tsx
    const inputProps = {
      hook,
      description,
      durationSec: dur,
      videoPath,
      musicPath,
    };

    console.log("[render] inputProps:", {
      durationSec: inputProps.durationSec,
      videoPath: inputProps.videoPath,
      musicPath: inputProps.musicPath,
    });

    const chromiumPath =
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      process.env.CHROME_BIN ||
      "/usr/bin/chromium";

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
      chromiumOptions: {
        executablePath: chromiumPath,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--autoplay-policy=no-user-gesture-required",
          "--disable-web-security",
          "--allow-file-access-from-files",
        ],
      },
    });

    // ---- Отдаем видео бинарём
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    fs.createReadStream(outPath).pipe(res);

    res.on("close", () => {
      try { if (outPath) fs.unlinkSync(outPath); } catch {}
      try { if (videoPath) fs.unlinkSync(videoPath); } catch {}
      try { if (musicPath) fs.unlinkSync(musicPath); } catch {}
    });
  } catch (e) {
    console.error("[render] error:", e);
    try {
      if (outPath) fs.unlinkSync(outPath);
    } catch {}
    try {
      if (videoPath) fs.unlinkSync(videoPath);
    } catch {}
    try {
      if (musicPath) fs.unlinkSync(musicPath);
    } catch {}

    res.status(400).json({
      ok: false,
      error: String(e?.message || e),
    });
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
