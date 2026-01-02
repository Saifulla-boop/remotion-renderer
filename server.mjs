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
app.use(express.json({ limit: "10mb" }));

// ========= CONFIG =========
const REMOTION_ROOT = path.join(__dirname, "remotion");
const REMOTION_ENTRY = path.join(REMOTION_ROOT, "src", "index.ts");
const COMPOSITION_ID = process.env.COMPOSITION_ID || "Short";

const cleanId = (s) => String(s || "").replace(/^=+/, "").trim();

// --- Drive uc URL (с confirm)
const driveUcUrl = (fileId, confirm) => {
  const base = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
    fileId
  )}`;
  return confirm ? `${base}&confirm=${encodeURIComponent(confirm)}` : base;
};

// download_warning токен из cookie
function extractDownloadWarningTokenFromCookies(res) {
  const getSetCookie = res.headers.getSetCookie?.bind(res.headers);
  const cookies = getSetCookie ? getSetCookie() : [];
  const fallback = res.headers.get("set-cookie");
  if (fallback) cookies.push(fallback);

  for (const c of cookies) {
    const m = String(c).match(/download_warning[^=]*=([^;]+)/);
    if (m) return m[1];
  }
  return null;
}

// confirm токен из HTML
function extractConfirmTokenFromHtml(html) {
  const s = String(html || "");

  let m = s.match(/confirm=([0-9A-Za-z_]+)&amp;id=/);
  if (m) return m[1];

  m = s.match(/confirm=([0-9A-Za-z_]+)&id=/);
  if (m) return m[1];

  m = s.match(/name="confirm"\s+value="([0-9A-Za-z_]+)"/);
  if (m) return m[1];

  if (s.includes("Virus scan warning")) return "t";

  return null;
}

// Одна попытка скачать по URL
async function downloadDriveFileTo(tmpPath, url, cookieHeader) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });

  const ct = res.headers.get("content-type") || "";

  // HTML -> вернём html, чтобы достать confirm
  if (ct.toLowerCase().includes("text/html")) {
    const html = await res.text();
    return { ok: false, html, res };
  }

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Drive download failed (${res.status}). ${t.slice(0, 200)}`);
  }

  if (!res.body) throw new Error("Download failed: empty body");

  const fileStream = fs.createWriteStream(tmpPath);
  await pipeline(Readable.fromWeb(res.body), fileStream);

  return { ok: true, res };
}

// ✅ Downloader, который обходит confirm/virus scan
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);

  // 1) первая попытка
  const first = await downloadDriveFileTo(tmpPath, driveUcUrl(safeId));
  if (first.ok) {
    const stat = fs.statSync(tmpPath);
    if (!stat.size || stat.size < 1024) {
      throw new Error(`Downloaded file too small (size=${stat.size}). fileId=${safeId}`);
    }
    return tmpPath;
  }

  // HTML -> пытаемся извлечь confirm
  const html = first.html || "";
  const cookieToken = extractDownloadWarningTokenFromCookies(first.res);
  const htmlToken = extractConfirmTokenFromHtml(html);
  const confirm = htmlToken || cookieToken;

  if (!confirm) {
    const head = html.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `Drive returned HTML instead of media and confirm token not found. fileId=${safeId}. HTML head: ${head}`
    );
  }

  const cookieHeader = cookieToken ? `download_warning=${cookieToken}` : undefined;

  // 2) повторная попытка с confirm
  try { fs.unlinkSync(tmpPath); } catch {}

  const second = await downloadDriveFileTo(tmpPath, driveUcUrl(safeId, confirm), cookieHeader);
  if (!second.ok) {
    const head = String(second.html || "").slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `Drive returned HTML again (confirm=${confirm}). fileId=${safeId}. HTML head: ${head}`
    );
  }

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(`Downloaded file looks wrong (size=${stat.size}). fileId=${safeId}`);
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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  try {
    const body = req.body || {};

    const hook = body.hook;
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    // ✅ поддержка разных названий полей
    const videoFileId =
      body.videoFileId ??
      body.videoFieldId ??
      body.videoFileid ??
      body.videoFieldid;

    const musicFileId =
      body.musicFileId ??
      body.musicFieldId ??
      body.musicFileid ??
      body.musicFieldid;

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
    const videoPath = await downloadToTmp({ fileId: videoFileId, ext: "mp4" });
    const musicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

    if (!videoPath) throw new Error("SERVER: videoPath is empty after download");
    if (!musicPath) throw new Error("SERVER: musicPath is empty after download");

    // ---- Находим композицию
    const comps =
      compositionsCache || (await getCompositions(bundleLocation, { inputProps: {} }));

    const comp = comps.find((c) => c.id === COMPOSITION_ID);
    if (!comp) {
      throw new Error(
        `Composition "${COMPOSITION_ID}" not found. Available: ${comps.map((c) => c.id).join(", ")}`
      );
    }

    const outPath = path.join(os.tmpdir(), `render-${Date.now()}.mp4`);

    // ✅ ВАЖНО: передаём ОБА варианта пропсов
    const inputProps = {
      hook,
      description,
      durationSec: dur,

      videoPath,
      musicPath,

      // совместимость со старым
      videoSrc: videoPath,
      musicSrc: musicPath,
    };

    console.log("[render] inputProps:", {
      durationSec: inputProps.durationSec,
      videoPath: inputProps.videoPath,
      musicPath: inputProps.musicPath,
      videoSrc: inputProps.videoSrc,
      musicSrc: inputProps.musicSrc,
    });

    await renderMedia({
      composition: comp,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
    });

    // ---- Отдаём видео
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
  .then(() => {
    app.listen(port, () => console.log(`Server listening on :${port}`));
  })
  .catch((e) => {
    console.error("Failed to start Remotion server:", e);
    process.exit(1);
  });
