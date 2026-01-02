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

// ВАЖНО: Node 18+ имеет глобальный fetch (undici).
// Если у тебя где-то подключен node-fetch — УДАЛИ его импорт, он тут не нужен.

const driveUcUrl = (fileId, confirm) => {
  const base = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(
    fileId
  )}`;
  return confirm ? `${base}&confirm=${encodeURIComponent(confirm)}` : base;
};

// Вытаскиваем cookie download_warning=TOKEN
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

// Вытаскиваем confirm токен из HTML (разные варианты разметки у Drive)
function extractConfirmTokenFromHtml(html) {
  const s = String(html || "");

  // иногда в ссылке: confirm=XXXX&id=...
  let m = s.match(/confirm=([0-9A-Za-z_]+)&amp;id=/);
  if (m) return m[1];

  m = s.match(/confirm=([0-9A-Za-z_]+)&id=/);
  if (m) return m[1];

  // иногда hidden input: name="confirm" value="XXXX"
  m = s.match(/name="confirm"\s+value="([0-9A-Za-z_]+)"/);
  if (m) return m[1];

  // иногда просто “confirm=t” (на вирус-странице часто так)
  if (s.includes("Virus scan warning")) return "t";

  return null;
}

function looksLikeHtml(contentType, bufOrText) {
  const ct = (contentType || "").toLowerCase();
  if (ct.includes("text/html")) return true;
  const head = typeof bufOrText === "string" ? bufOrText.slice(0, 400) : "";
  return head.includes("<!doctype") || head.includes("<html");
}

async function downloadDriveFileTo(tmpPath, url, cookieHeader) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: cookieHeader ? { cookie: cookieHeader } : undefined,
  });

  const ct = res.headers.get("content-type") || "";

  // Если это HTML — читаем текст, чтобы распарсить confirm
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

// ✅ НОРМАЛЬНЫЙ ДРАЙВ-ДАУНЛОАДЕР (обходит confirm/virus scan)
async function downloadToTmp({ fileId, ext }) {
  const safeId = cleanId(fileId);
  if (!safeId) throw new Error("downloadToTmp: fileId is empty");

  const tmpPath = path.join(os.tmpdir(), `${Date.now()}-${safeId}.${ext}`);

  // 1) первая попытка
  const firstUrl = driveUcUrl(safeId);
  const first = await downloadDriveFileTo(tmpPath, firstUrl);

  if (first.ok) {
    const stat = fs.statSync(tmpPath);
    if (!stat.size || stat.size < 1024) {
      throw new Error(
        `Downloaded file too small (size=${stat.size}). fileId=${safeId}`
      );
    }
    return tmpPath;
  }

  // сюда попали, если пришёл HTML
  const html = first.html || "";
  const cookieToken = extractDownloadWarningTokenFromCookies(first.res);
  const htmlToken = extractConfirmTokenFromHtml(html);

  const confirm = htmlToken || cookieToken;

  if (!confirm) {
    // покажем кусок HTML заголовка, чтобы ты видел, что реально пришло
    const head = html.slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `Drive returned HTML instead of media and confirm token not found. fileId=${safeId}. HTML head: ${head}`
    );
  }

  // cookie для второго запроса (если token пришёл из cookie)
  // если token из HTML — cookie обычно не обязателен, но не мешает
  const cookieHeader = cookieToken ? `download_warning=${cookieToken}` : undefined;

  // 2) вторая попытка с confirm
  const secondUrl = driveUcUrl(safeId, confirm);

  // удалим если успел записаться html/мусор
  try { fs.unlinkSync(tmpPath); } catch {}

  const second = await downloadDriveFileTo(tmpPath, secondUrl, cookieHeader);
  if (!second.ok) {
    const head = String(second.html || "").slice(0, 300).replace(/\s+/g, " ");
    throw new Error(
      `Drive returned HTML again (confirm=${confirm}). fileId=${safeId}. HTML head: ${head}`
    );
  }

  const stat = fs.statSync(tmpPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(
      `Downloaded file looks wrong (size=${stat.size}). fileId=${safeId}`
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

    // ✅ поддержка обоих вариантов имен (fileId vs fieldId)
    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;
    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

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

    // ---- Скачиваем исходники (тут была проблема)
    const videoPath = await downloadToTmp({ fileId: videoFileId, ext: "mp4" });
    const musicPath = await downloadToTmp({ fileId: musicFileId, ext: "mp3" });

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
