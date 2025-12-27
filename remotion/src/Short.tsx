import React, { useMemo } from "react";
import { AbsoluteFill, Audio } from "remotion";
import { OffthreadVideo } from "remotion";

type Props = {
  hook: string;
  videoUrl: string;
  musicUrl: string;
  durationSec: number;

  fitMode?: "contain" | "cover"; // приходит из server.mjs
};

const normalize = (t: string) => (t || "").replace(/\s+/g, " ").trim();

const autoFontSizeTop = (text: string) => {
  const len = normalize(text).length;
  // Шапка: чем длиннее текст, тем меньше шрифт (как в рефе)
  if (len <= 32) return 54;
  if (len <= 55) return 46;
  if (len <= 80) return 40;
  if (len <= 110) return 36;
  return 32;
};

export const Short: React.FC<Props> = ({
  hook,
  videoUrl,
  musicUrl,
  fitMode = "cover",
}) => {
  const cleanHook = useMemo(() => normalize(hook).toUpperCase(), [hook]);
  const fontSize = useMemo(() => autoFontSizeTop(cleanHook), [cleanHook]);

  // Общее притемнение оставляем (у тебя зашло)
  const dimOpacity = 0.18;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* ВИДЕО */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <OffthreadVideo
          src={videoUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: fitMode, // contain для горизонтальных, cover для вертикальных
            objectPosition: "center",
          }}
        />

        {/* мягкое общее затемнение */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "black",
            opacity: dimOpacity,
            pointerEvents: "none",
          }}
        />

        {/* ЧЁРНАЯ "ШАПКА" как в рефе (градиент вниз) */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "34%", // можно 30–38% под вкус
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.92), rgba(0,0,0,0.40), rgba(0,0,0,0))",
            pointerEvents: "none",
          }}
        />
      </AbsoluteFill>

      {/* ТЕКСТ СВЕРХУ (без плашки, без анимации) */}
      <div
        style={{
          position: "absolute",
          top: 90, // отступ как в рефе; можно 70–120
          left: "50%",
          transform: "translateX(-50%)",
          width: "92%",
          maxWidth: 980,
          textAlign: "center",
          padding: "0 24px",
        }}
      >
        <div
          style={{
            fontFamily:
              'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
            fontWeight: 900,
            fontSize,
            lineHeight: 1.12,
            letterSpacing: "-0.01em",
            color: "#FFFFFF",
            textShadow: "0 8px 22px rgba(0,0,0,0.55)",
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}
        >
          {cleanHook}
        </div>
      </div>

      {musicUrl ? <Audio src={musicUrl} volume={0.1} /> : null}
    </AbsoluteFill>
  );
};
