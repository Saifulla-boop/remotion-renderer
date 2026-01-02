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

/**
 * Google Drive:
 * 1) первый запрос часто возвращает HTML (virus scan / confirm download)
 * 2) тогда нужно повторить запрос с confirm токеном
 */
const driveBaseUrl = (fileId) =>
  `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;

// Пытаемся вытащить confirm токен из HTML
function extractConfirmToken(html) {
  if (!html || typeof html !== "string") return null;

  // варианты встречаются разные
  // confirm=XXXX
  const m1 = html.match(/confirm=([0-9A-Za-z_]+)&/);
  if (m1?.[1]) return m1[1];

  const m2 = html.match(/confirm=([0-9A-Za-z_]+)/);
  if (m2?.[1]) return m2[1];

  return null;
}

// Проверка: это похоже на HTML, а не на файл
function looksLikeHtml(res, firstChunkText) {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) return true;
  if (!firstChunkText) return false;

  const t = firstChunkText.trim().toLowerCase();
  return t.startsWith("<!doctype html") || t.startsWith("<html");
}

// Делаем запрос к Drive и возвращаем Response + (опционально) первые символы текста, если это HTML
async function fetchDriveFile(url) {
  const res = await fetch(url, {
    redirect: "follow",
    // чтобы drive не пытался “умничать”
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept": "*/*",
    },
  });

  // если даже статус не ок — сразу ошибка
  if (!res.ok) {
    const ct = res.headers.get("content-type") || "";
    throw new Error(`Drive download failed (${res.status}). content-type=${ct}`);
  }

  // Часто надо “приглушить” чтение тела, чтобы понять HTML/не HTML
  // Но если это реальный бинарь — читать текст нельзя.
  // Поэтому делаем так: если content-type = text/html → читаем текст.
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) {
    const html = await res.text();
    return { res, html };
  }

  // Иногда Drive всё равно шлёт html без content-type text/html (редко),
  // тогда осторожно пробуем прочитать маленький кусок:
  // Но fetch в Node не даёт легко “peek” в stream.
  // Поэтому — доверяем content-type, а дополнительную проверку делаем на size после сохранения.
  return { res, html: null };
}

/**
 * Скачиваем файл во временную папку
 * ✅ поддержка “confirm download” страницы Google Drive
 */
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  // 1) первая попытка
  const url1 = driveBaseUrl(safeId);
  let { res, html } = await fetchDriveFile(url1);

  // 2) если пришёл HTML — пытаемся вытащить confirm и скачать ещё раз
  if (html) {
    const token = extractConfirmToken(html);
    if (!token) {
      // покажем первые 200 символов, чтобы было понятно, что вернуло
      throw new Error(
        `Drive returned HTML instead of media and confirm token not found. fileId=${safeId}. HTML head: ${html
          .slice(0, 200)
          .replace(/\s+/g, " ")}`
      );
    }

    const url2 = `${url1}&confirm=${encodeURIComponent(token)}`;
    ({ res, html } = await fetchDriveFile(url2));

    if (html) {
      // даже после confirm снова html — значит всё ещё не файл
      throw new Error(
        `Drive still returned HTML after confirm. fileId=${safeId}. HTML head: ${html
          .slice(0, 200)
          .replace(/\s+/g, " ")}`
      );
    }
  }

  if (!res.body) throw new Error("Download failed: empty body");

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);
  const fileStream = fs.createWriteStream(tmpPath);

  // Node18 fetch body = WebStream → конвертим корректно
  await pipeline(Readable.fromWeb(res.body), fileStream);

  // Проверяем размер: если tiny — почти наверняка опять HTML/ошибка
  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 50 * 1024) {
    // попробуем прочитать и показать первые символы — чтобы понять, что реально скачалось
    let head = "";
    try {
      head = fs.readFileSync(tmpPath, "utf8").slice(0, 200).replace(/\s+/g, " ");
    } catch {
      head = "<binary or unreadable>";
    }
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). Probably not media. fileId=${safeId}. Head: ${head}`
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

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/render", async (req, res) => {
  try {
    const body = req.body || {};

    const hook = body.hook;
    const description = body.description ?? "";
    const durationSec = body.durationSec;

    // ✅ поддерживаем оба варианта имен
    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

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

    // ---- Скачиваем исходники
    const videoPath = await downloadToTmp({ fileId: videoFileId, ext: "mp4" });
    const musicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

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

    console.log("[render] inputProps:", {
      durationSec: inputProps.durationSec,
      videoPath: inputProps.videoPath,
      musicPath: inputProps.musicPath,
    });

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
