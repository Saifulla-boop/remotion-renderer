import React from "react";
import {
  AbsoluteFill,
  Audio,
  Video,
} from "remotion";

type Props = {
  hook: string;
  description?: string;
  durationSec?: number;
  videoPath: string; // важно: именно videoPath
  musicPath: string; // важно: именно musicPath
};

export const Short: React.FC<Props> = ({
  hook,
  videoPath,
  musicPath,
}) => {
  // Явная, понятная ошибка (чтобы сразу видеть, что именно пустое)
  if (!videoPath || typeof videoPath !== "string") {
    throw new Error("No src passed (videoPath is empty)");
  }
  if (!musicPath || typeof musicPath !== "string") {
    throw new Error("No src passed (musicPath is empty)");
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* Видео */}
      <AbsoluteFill>
        <Video
          src={videoPath}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      {/* Притемнение как в рефе */}
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.35)" }} />

      {/* Музыка */}
      <Audio src={musicPath} />

      {/* Подложка + текст (нижняя треть, по центру) */}
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: 260, // можно чуть двигать вверх/вниз под реф
        }}
      >
        <div
          style={{
            backgroundColor: "rgba(176, 92, 30, 0.80)", // оранжевый как на рефе
            borderRadius: 28,
            padding: "28px 34px",
            maxWidth: 920,
            width: "calc(100% - 180px)",
          }}
        >
          <div
            style={{
              color: "rgba(255,255,255,0.92)",
              fontSize: 58,
              lineHeight: 1.1,
              fontWeight: 300,
              letterSpacing: 0.2,
              textAlign: "center",
              fontFamily:
                "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif",
            }}
          >
            {hook}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
