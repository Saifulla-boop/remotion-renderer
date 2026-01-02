import express from "express";
import os from "os";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import crypto from "crypto";
import { spawn } from "child_process";

import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = Number(process.env.PORT || 3000);

// ===================== Google Drive (Service Account, READONLY) =====================
function getDrive() {
  const email = process.env.GOOGLE_CLIENT_EMAIL;
  const keyRaw = process.env.GOOGLE_PRIVATE_KEY;

  if (!email || !keyRaw) {
    throw new Error("Missing GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY env vars.");
  }

  const key = keyRaw.replace(/\\n/g, "\n");

  const auth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

async function downloadFromDrive(fileId, outPath) {
  const drive = getDrive();

  const res = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  await new Promise((resolve, reject) => {
    const dest = fs.createWriteStream(outPath);
    res.data.on("end", resolve).on("error", reject).pipe(dest);
  });

  const stat = fs.statSync(outPath);
  if (!stat.size || stat.size < 1024) {
    throw new Error(`Downloaded file too small (${stat.size}). fileId=${fileId}`);
  }

  return outPath;
}

// ===================== Local assets served via HTTP (Chromium reads these) =====================
// token -> { videoPath, musicPath?, expiresAt }
const ASSETS = new Map();

function createToken() {
  return crypto.randomBytes(16).toString("hex");
}

function registerAssets({ videoPath, musicPath }) {
  const token = createToken();
  ASSETS.set(token, {
    videoPath,
    musicPath,
    expiresAt: Date.now() + 15 * 60 * 1000, // 15 минут
  });
  return token;
}

function cleanupToken(token) {
  ASSETS.delete(token);
}

// периодическая уборка
setInterval(() => {
  const now = Date.now();
  for (const [token, v] of ASSETS.entries()) {
    if (v.expiresAt < now) ASSETS.delete(token);
  }
}, 2 * 60 * 1000);

// -------------------- IMPORTANT: Range support (fixes delayRender timeout) --------------------
function streamWithRange(req, res, filePath, contentType) {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);

  const range = req.headers.range;

  // если браузер НЕ запросил range — отдаем целиком
  if (!range) {
    res.setHeader("Content-Length", fileSize);
    return fs.createReadStream(filePath).pipe(res);
  }

  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) {
    return res.status(416).send("Malformed Range header");
  }

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (start >= fileSize || end >= fileSize) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).end();
  }

  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

  return fs.createReadStream(filePath, { start, end }).pipe(res);
}

app.get("/asset/:token/video", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.videoPath) return res.status(404).send("Not found");
  return streamWithRange(req, res, entry.videoPath, "video/mp4");
});

app.get("/asset/:token/music", (req, res) => {
  const entry = ASSETS.get(req.params.token);
  if (!entry?.musicPath) return res.status(404).send("Not found");
  return streamWithRange(req, res, entry.musicPath, "audio/mpeg");
});

// ===================== ffprobe helpers (orientation) =====================
function run(cmd, args, { timeoutMs = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });

    let out = "";
    let err = "";

    const t = setTimeout(() => {
      p.kill("SIGKILL");
      reject(new Error(`${cmd} timeout`));
    }, timeoutMs);

    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));

    p.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) return resolve({ out, err });
      reject(new Error(`${cmd} failed (${code})\n${err || out}`));
    });
  });
}

async function getVideoDims(filePath) {
  const { out } = await run("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=s=x:p=0",
    filePath,
  ]);

  const [w, h] = out.trim().split("x").map(Number);
  if (!w || !h) throw new Error("ffprobe could not read video dimensions");
  return { w, h };
}

// ===================== Remotion bundle cache =====================
let serveUrl = null;

async function getBundle() {
  if (serveUrl) return serveUrl;

  // важно: в docker/railway process.cwd() == /app, remotion лежит /app/remotion/...
  serveUrl = await bundle({
    entryPoint: path.join(process.cwd(), "remotion", "src", "index.ts"),
  });

  console.log("[remotion] bundle ready:", serveUrl);
  return serveUrl;
}

// ===================== Routes =====================
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  let localVideo = null;
  let localMusic = null;
  let outPath = null;
  let token = null;

  try {
    const body = req.body || {};

    // входные поля (поддержка разных имен)
    const hook = String(body.hook ?? "");
    const description = String(body.description ?? "");
    const durationSec = body.durationSec;

    const videoFileId =
      body.videoFileId ?? body.videoFieldId ?? body.videoFileid ?? body.videoFieldid;

    const musicFileId =
      body.musicFileId ?? body.musicFieldId ?? body.musicFileid ?? body.musicFieldid;

    if (!videoFileId) {
      return res.status(400).json({ error: "videoFileId required" });
    }

    const duration = Number.isFinite(Number(durationSec))
      ? Math.min(Math.max(Number(durationSec), 6), 30)
      : 12;

    const serve = await getBundle();

    // 1) download sources to /tmp
    localVideo = path.join(os.tmpdir(), `in-video-${Date.now()}.mp4`);
    await downloadFromDrive(String(videoFileId), localVideo);

    if (musicFileId) {
      localMusic = path.join(os.tmpdir(), `in-music-${Date.now()}.mp3`);
      await downloadFromDrive(String(musicFileId), localMusic);
    }

    // 2) detect orientation -> fitMode
    const { w, h } = await getVideoDims(localVideo);
    const isHorizontal = w > h;
    const fitMode = isHorizontal ? "contain" : "cover";

    console.log("[render] VIDEO_DIMS:", { w, h, isHorizontal, fitMode });

    // 3) serve local assets via HTTP (Chromium MUST access by URL)
    token = registerAssets({ videoPath: localVideo, musicPath: localMusic });

    // ВАЖНО: Chromium, который запускает Remotion, находится в этом же контейнере.
    // Поэтому 127.0.0.1:PORT – правильно.
    const baseUrl = `http://127.0.0.1:${PORT}`;
    const videoUrl = `${baseUrl}/asset/${token}/video`;
    const musicUrl = localMusic ? `${baseUrl}/asset/${token}/music` : "";

    // 4) inputProps: пробрасываем все варианты названий
    const inputProps = {
      hook,
      description,
      durationSec: duration,
      fitMode,

      // исторические имена
      videoUrl,
      musicUrl,

      // новые/альтернативные
      videoPath: videoUrl,
      musicPath: musicUrl,

      videoSrc: videoUrl,
      musicSrc: musicUrl,
    };

    // selectComposition берёт актуальную длительность/props
    const composition = await selectComposition({
      serveUrl: serve,
      id: "Short",
      inputProps,
    });

    outPath = path.join(os.tmpdir(), `out-${Date.now()}.mp4`);

    await renderMedia({
      composition: {
        ...composition,
        fps: 30,
        durationInFrames: Math.round(duration * 30),
      },
      serveUrl: serve,
      codec: "h264",
      outputLocation: outPath,
      inputProps,
      timeoutInMilliseconds: 180000, // 3 минуты (страховка)
    });

    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", `attachment; filename="short.mp4"`);

    fs.createReadStream(outPath).pipe(res);

    res.on("close", async () => {
      try {
        if (token) cleanupToken(token);
        if (outPath) await fsp.unlink(outPath).catch(() => {});
        if (localVideo) await fsp.unlink(localVideo).catch(() => {});
        if (localMusic) await fsp.unlink(localMusic).catch(() => {});
      } catch {}
    });
  } catch (e) {
    console.error("[render] ERROR:", e);

    if (!res.headersSent) {
      res.status(500).json({ error: e?.message || "Render failed" });
    }

    try {
      if (token) cleanupToken(token);
      if (outPath) await fsp.unlink(outPath).catch(() => {});
      if (localVideo) await fsp.unlink(localVideo).catch(() => {});
      if (localMusic) await fsp.unlink(localMusic).catch(() => {});
    } catch {}
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Remotion renderer running on ${PORT}`);
});
