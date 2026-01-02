import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";
import { Readable } from "stream";

import { bundle, getCompositions, renderMedia } from "@remotion/renderer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "20mb" })); // можно увеличить, но обычно хватает

/**
 * ============ CONFIG ============
 */
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

const driveDownloadUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

/**
 * Скачиваем файл во временную папку
 * Node 18: global fetch -> res.body это WebStream
 * Конвертим WebStream в Node stream: Readable.fromWeb()
 */
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const url = driveDownloadUrl(safeId);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Drive download failed (${res.status}): ${url}`);
  if (!res.body) throw new Error("Drive download failed: response has no body");

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  const nodeStream = Readable.fromWeb(res.body);

  await new Promise((resolve, reject) => {
    nodeStream.pipe(fileStream);
    nodeStream.on("error", reject);
    fileStream.on("error", reject);
    fileStream.on("finish", resolve);
  });

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). Probably Drive returned HTML, not file. fileId=${safeId}`
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
    compositionsCache.map((c) => c.id)
  );
}

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  const cleanup = (paths) => {
    for (const p of paths) {
      if (!p) continue;
      try {
        fs.unlinkSync(p);
      } catch {}
    }
  };

  try {
    const { hook, description, videoFileId, musicFileId, durationSec } =
      req.body || {};

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

    const videoPath = await downloadToTmp({ fileId: videoFileId, ext: "mp4" });
    const musicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

    const comps =
      compositionsCache ||
      (await getCompositions(bundleLocation, { inputProps: {} }));
    const comp = comps.find((c) => c.id === COMPOSITION_ID);

    if (!comp) {
      cleanup([videoPath, musicPath]);
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
      durationSec: dur,
      videoPath,
      musicPath,
    };

    console.log("[render] starting renderMedia...");

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    console.log("[render] done:", outPath);

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    const stream = fs.createReadStream(outPath);
    stream.pipe(res);

    stream.on("close", () => cleanup([outPath, videoPath, musicPath]));
    stream.on("error", () => cleanup([outPath, videoPath, musicPath]));
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
