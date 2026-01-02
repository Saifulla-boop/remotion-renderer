import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

import { bundle } from "@remotion/bundler";
import { getCompositions, renderMedia } from "@remotion/renderer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "5mb" }));

/**
 * ================= CONFIG =================
 */

// папка с Remotion-проектом
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");

// ID композиции
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

// порт
const PORT = process.env.PORT || 3000;

/**
 * =============== HELPERS ==================
 */

const driveDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const url = driveDownloadUrl(safeId);
  const res = await fetch(url, { redirect: "follow" });

  if (!res.ok) {
    throw new Error(`Drive download failed (${res.status})`);
  }

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error("Downloaded file is too small (likely HTML, not media)");
  }

  return tmpPath;
}

/**
 * =============== REMOTION INIT ==================
 */

let bundleLocation = null;
let compositionsCache = null;

async function prepareRemotion() {
  console.log("[remotion] bundling...");
  bundleLocation = await bundle({
    entryPoint: REMOTION_ENTRY,
    webpackOverride: (config) => config,
  });

  compositionsCache = await getCompositions(bundleLocation, {
    inputProps: {},
  });

  console.log(
    "[remotion] compositions:",
    compositionsCache.map((c) => c.id)
  );
}

/**
 * ================= ROUTES ==================
 */

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  try {
    // ===== ВОТ ТО, ЧТО ТЫ ПРОСИЛ ДОБАВИТЬ =====
    const body = req.body || {};

    const hook = body.hook;
    const description = body.description;
    const durationSec = Number(body.durationSec ?? 12);

    // 🔥 поддержка обоих вариантов
    const videoFileId = body.videoFileId ?? body.videoFieldId;
    const musicFileId = body.musicFileId ?? body.musicFieldId;
    // =========================================

    // ---- Валидация
    if (!hook || typeof hook !== "string") {
      throw new Error("hook is missing or not a string");
    }
    if (typeof description !== "string") {
      throw new Error("description is missing or not a string");
    }
    if (!videoFileId) {
      throw new Error("videoFileId / videoFieldId missing");
    }
    if (!musicFileId) {
      throw new Error("musicFileId / musicFieldId missing");
    }
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      throw new Error("durationSec invalid");
    }

    console.log("[render] request:", {
      hook,
      descriptionLen: description.length,
      videoFileId,
      musicFileId,
      durationSec,
    });

    // ---- Скачиваем медиа
    const videoPath = await downloadToTmp({
      fileId: videoFileId,
      ext: "mp4",
    });

    const musicPath = await downloadToTmp({
      fileId: musicFileId,
      ext: "mp3",
    });

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

    const inputProps = {
      hook,
      description,
      durationSec,
      videoPath,
      musicPath,
    };

    console.log("[render] inputProps OK");

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="short.mp4"'
    );

    fs.createReadStream(outPath).pipe(res);

    res.on("finish", () => {
      try {
        fs.unlinkSync(outPath);
        fs.unlinkSync(videoPath);
        fs.unlinkSync(musicPath);
      } catch {}
    });
  } catch (e) {
    console.error("[render] error:", e);
    res.status(400).json({
      ok: false,
      error: String(e.message || e),
    });
  }
});

/**
 * ================= START ==================
 */

prepareRemotion()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Server listening on :${PORT}`);
    });
  })
  .catch((e) => {
    console.error("Failed to start Remotion server:", e);
    process.exit(1);
  });
