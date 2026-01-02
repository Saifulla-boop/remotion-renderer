import React from "react";
import {
  AbsoluteFill,
  Audio,
  Video,
  useVideoConfig,
} from "remotion";

type Props = {
  hook: string;
  description: string;
  durationSec?: number;
  videoPath: string; // <-- важно
  musicPath: string; // <-- важно
};

export const Short: React.FC<Props> = (props) => {
  const { hook, description, videoPath, musicPath } = props;
  const { width, height } = useVideoConfig();

  if (!videoPath || typeof videoPath !== "string") {
    throw new Error(`No src passed (videoPath is empty)`);
  }
  if (!musicPath || typeof musicPath !== "string") {
    throw new Error(`No src passed (musicPath is empty)`);
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* Видео */}
      <Video
        src={videoPath}
        style={{ width, height, objectFit: "cover" }}
      />

      {/* Музыка */}
      <Audio src={musicPath} />

      {/* Текст — пока базово, позже доведем до референса */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: 80,
        }}
      >
        <div
          style={{
            maxWidth: 900,
            fontSize: 54,
            lineHeight: 1.15,
            color: "white",
            fontWeight: 600,
            textAlign: "center",
            background: "rgba(0,0,0,0.35)",
            padding: "22px 28px",
            borderRadius: 18,
          }}
        >
          {hook}
        </div>

        <div
          style={{
            marginTop: 22,
            maxWidth: 980,
            fontSize: 34,
            lineHeight: 1.25,
            color: "rgba(255,255,255,0.9)",
            textAlign: "center",
            textShadow: "0 2px 10px rgba(0,0,0,0.4)",
          }}
        >
          {description}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
