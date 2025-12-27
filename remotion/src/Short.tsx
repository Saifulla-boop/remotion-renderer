import React, { useMemo } from "react";
import { AbsoluteFill, Audio, useCurrentFrame, interpolate } from "remotion";
import { OffthreadVideo } from "remotion";

type Props = {
  hook: string;
  videoUrl: string;
  musicUrl: string;
  durationSec: number;

  // можно передать принудительно, но если не передал — будет auto
  textPosition?: "top" | "center" | "auto";
};

// нормализация текста
const normalize = (t: string) => (t || "").replace(/\s+/g, " ").trim();

// авто-позиция: короткое — в центр, длинное — наверх
const autoTextPosition = (text: string): "top" | "center" => {
  const t = normalize(text);
  const len = t.length;
  const words = t.split(" ").filter(Boolean).length;

  // 1 строка / коротко — центр
  if (len <= 38 && words <= 6) return "center";

  // среднее — верх
  if (len <= 85) return "top";

  // очень длинное — верх (и мы уменьшим шрифт)
  return "top";
};

// авто-размер шрифта под длину (капсом текст визуально “раздувается”)
const autoFontSize = (text: string) => {
  const len = normalize(text).length;

  if (len <= 26) return 60;
  if (len <= 38) return 54;
  if (len <= 52) return 46;
  if (len <= 70) return 40;
  if (len <= 90) return 36;
  if (len <= 115) return 32;
  return 28;
};

// авто-padding плашки под длину (чтобы длинные не выглядели “зажатыми”)
const autoBoxPadding = (text: string) => {
  const len = normalize(text).length;
  if (len <= 40) return "18px 22px";
  if (len <= 80) return "18px 22px";
  return "16px 18px";
};

export const Short: React.FC<Props> = ({
  hook,
  videoUrl,
  musicUrl,
  textPosition = "auto",
}) => {
  const frame = useCurrentFrame();

  const cleanHook = useMemo(() => normalize(hook), [hook]);

  // Позиция текста (auto -> top/center)
  const pos = useMemo(() => {
    if (textPosition === "top" || textPosition === "center") return textPosition;
    return autoTextPosition(cleanHook);
  }, [textPosition, cleanHook]);

  // Стиль текста
  const fontSize = useMemo(() => autoFontSize(cleanHook), [cleanHook]);
  const boxPadding = useMemo(() => autoBoxPadding(cleanHook), [cleanHook]);

  // Анимация: премиум-спокойно
  const opacity = interpolate(frame, [6, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [6, 18], [10, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const topValue = pos === "top" ? "10%" : "38%";

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* 1) ВИДЕО: center-crop под 9:16 */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <OffthreadVideo
          src={videoUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
          }}
        />

        {/* градиент сверху — чтобы текст всегда читался */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "48%",
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0))",
            pointerEvents: "none",
          }}
        />
      </AbsoluteFill>

      {/* 2) ТЕКСТ: top/center (auto), строго по центру по X */}
      <div
        style={{
          position: "absolute",
          top: topValue,
          left: "50%",
          transform: `translate(-50%, ${y}px)`,
          opacity,
          width: "92%",
          maxWidth: 980,
          display: "flex",
          justifyContent: "center",
          padding: "0 24px",
        }}
      >
        <div
          style={{
            width: "100%",
            background: "rgba(255,255,255,0.96)",
            borderRadius: 18,
            padding: boxPadding,
            boxShadow: "0 18px 40px rgba(0,0,0,0.22)",
            border: "1px solid rgba(0,0,0,0.06)",
          }}
        >
          <div
            style={{
              fontFamily:
                'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
              fontWeight: 900,
              fontSize,
              lineHeight: 1.08,
              letterSpacing: "-0.01em",
              color: "#0B0B0B",
              textAlign: "center",
              textTransform: "uppercase",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
            }}
          >
            {cleanHook.toUpperCase()}
          </div>
        </div>
      </div>

      {/* 3) МУЗЫКА */}
      {musicUrl ? <Audio src={musicUrl} volume={0.1} /> : null}
    </AbsoluteFill>
  );
};
