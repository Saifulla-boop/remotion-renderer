import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { spawn } from "child_process";

import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia } from "@remotion/renderer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "10mb" }));

// ========= CONFIG =========
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

// Google Drive public download URL
const driveDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

/**
 * Скачиваем файл во временную папку (Node18 fetch -> WebStream)
 */
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const url = driveDownloadUrl(safeId);
  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) throw new Error(`Drive download failed (${res.status})`);
  if (!res.body) throw new Error("Download failed: empty body");

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  await pipeline(Readable.fromWeb(res.body), fileStream);

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). Drive probably returned HTML instead of a file. fileId=${safeId}`
    );
  }

  return tmpPath;
}

/**
 * Запуск ffmpeg командой. Remotion всё равно требует ffmpeg для renderMedia,
 * поэтому в Railway он должен быть доступен. Если нет — покажет ошибку в логах.
 */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit" });
    p.on("error", reject);
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * Приводим видео к формату, который 100% ест Chromium:
 * MP4 + H264 + AAC + yuv420p + faststart
 */
async function ensureBrowserMp4(inputPath) {
  const outPath = path.join(os.tmpdir(), `vid-ok-${Date.now()}.mp4`);

  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vf",
    "format=yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-movflags",
    "+faststart",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    outPath,
  ]);

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error("FFmpeg produced empty output video");
  }

  return outPath;
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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  // Важно: тут НЕ меняй — это твоя совместимость videoFileId / videoFieldId
  try {
    const body = req.body || {};

    const hook = body.hook;
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid;

    // ---- Валидация
    if (!hook || typeof hook !== "string")
      throw new Error("hook is missing (string required)");
    if (typeof description !== "string")
      throw new Error("description must be a string");

    if (!videoFileId || typeof videoFileId !== "string") {
      throw new Error("videoFileId (or videoFieldId) is missing (string required)");
    }
    if (!musicFileId || typeof musicFileId !== "string") {
      throw new Error("musicFileId (or musicFieldId) is missing (string required)");
    }

    const dur = Number(durationSec ?? 12);
    if (!Number.isFinite(dur) || dur <= 0)
      throw new Error("durationSec must be a positive number");

    console.log("[render] incoming:", {
      hookLen: hook.length,
      descriptionLen: description.length,
      videoFileId: cleanId(videoFileId),
      musicFileId: cleanId(musicFileId),
      durationSec: dur,
    });

    // ---- Скачиваем исходники (видео может быть .MOV/HEVC — это ок)
    const rawVideoPath = await downloadToTmp({ fileId: videoFileId, ext: "mov" });
    const rawMusicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

    // ---- Конвертируем видео в mp4/h264 чтобы Remotion/Chromium не падал
    console.log("[render] ffmpeg convert to browser mp4...");
    const videoPath = await ensureBrowserMp4(rawVideoPath);
    const musicPath = rawMusicPath;

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

    // ---- Рендерим
    const outPath = path.join(os.tmpdir(), `render-${Date.now()}.mp4`);

    const inputProps = {
      hook,
      description,
      durationSec: dur,
      videoPath,
      musicPath,
    };

    console.log("[render] inputProps:", inputProps);

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    // ---- Отдаем видео
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", () => {
      // cleanup
      for (const p of [outPath, rawVideoPath, videoPath, rawMusicPath]) {
        try { fs.unlinkSync(p); } catch {}
      }
    });
  } catch (e) {
    console.error("[render] error:", e);
    res.status(400).json({ ok: false, error: String(e?.message || e) });
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
