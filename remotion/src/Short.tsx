import React from "react";
import { AbsoluteFill, Audio, useCurrentFrame, interpolate } from "remotion";
import { OffthreadVideo } from "remotion";

type Props = {
  hook: string;
  videoUrl: string;
  musicUrl: string;
  durationSec: number;
  textPosition?: "top" | "center"; // <-- ВАЖНО: никаких bottom
};

export const Short: React.FC<Props> = ({
  hook,
  videoUrl,
  musicUrl,
  textPosition = "top",
}) => {
  const frame = useCurrentFrame();

  // мягкое появление текста
  const opacity = interpolate(frame, [6, 18], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [6, 18], [10, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const topValue = textPosition === "top" ? "10%" : "38%";

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* 1) ВИДЕО: всегда center-crop в 9:16 */}
      <AbsoluteFill style={{ overflow: "hidden" }}>
        <OffthreadVideo
          src={videoUrl}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",       // <-- ключ
            objectPosition: "center", // <-- ключ
          }}
        />

        {/* Лёгкий затемняющий градиент сверху, чтобы текст читался */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: "45%",
            background:
              "linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0))",
            pointerEvents: "none",
          }}
        />
      </AbsoluteFill>

      {/* 2) ТЕКСТ: строго по центру по X, только top или center */}
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
              fontSize: 44,
              lineHeight: 1.08,
              letterSpacing: "-0.01em",
              color: "#0B0B0B",
              textAlign: "center",
              textTransform: "uppercase",
              wordBreak: "break-word",
              overflowWrap: "anywhere",
            }}
          >
            {hook}
          </div>
        </div>
      </div>

      {/* 3) МУЗЫКА */}
      {musicUrl ? <Audio src={musicUrl} volume={0.1} /> : null}
    </AbsoluteFill>
  );
};
