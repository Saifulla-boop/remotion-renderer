import React, { useMemo } from "react";
import { AbsoluteFill, Audio, interpolate, useCurrentFrame } from "remotion";
import { OffthreadVideo } from "remotion";

type Props = {
  hook: string;
  videoUrl: string;
  musicUrl: string;
  durationSec: number;
  textPosition?: "top" | "center" | "auto";

  // НОВОЕ: если хочешь принудительно “дожать” кроп (когда в исходнике уже есть черные поля)
  // Можно не передавать — будет auto по длине.
  forceZoom?: number; // например 1.0..2.2
};

const normalize = (t: string) => (t || "").replace(/\s+/g, " ").trim();

const autoTextPosition = (text: string): "top" | "center" => {
  const t = normalize(text);
  const len = t.length;
  const words = t.split(" ").filter(Boolean).length;
  if (len <= 38 && words <= 6) return "center";
  return "top";
};

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

export const Short: React.FC<Props> = ({
  hook,
  videoUrl,
  musicUrl,
  textPosition = "auto",
  forceZoom,
}) => {
  const frame = useCurrentFrame();
  const cleanHook = useMemo(() => normalize(hook), [hook]);

  const pos = useMemo(() => {
    if (textPosition === "top" || textPosition === "center") return textPosition;
    return autoTextPosition(cleanHook);
  }, [textPosition, cleanHook]);

  const fontSize = useMemo(() => autoFontSize(cleanHook), [cleanHook]);

  // ВАЖНО:
  // 1) cover + center
  // 2) плюс масштаб (zoom), чтобы убрать “запеченные” черные поля, если они есть
  // Если не знаем — держим 1.0, но ты можешь поднимать forceZoom до ~1.6–2.0
  const zoom = forceZoom ?? 1.0;

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
      {/* ВИДЕО СЛОЙ: гарантированный центр-кроп */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        {/* Центруем как “слой” и кропаем */}
        <div
          style={{
            position: "absolute",
            inset: 0,
            overflow: "hidden",
          }}
        >
          <OffthreadVideo
            src={videoUrl}
            // КЛЮЧ: позиционируем и масштабируем сами (это надежнее, чем надеяться на fit)
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: "100%",
              height: "100%",
              transform: `translate(-50%, -50%) scale(${zoom})`,
              objectFit: "cover",
              objectPosition: "center",
            }}
          />
        </div>

        {/* лёгкий градиент сверху для читаемости текста */}
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

      {/* ТЕКСТ: только top/center, по центру X */}
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
            padding: "18px 22px",
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

      {musicUrl ? <Audio src={musicUrl} volume={0.1} /> : null}
    </AbsoluteFill>
  );
};
