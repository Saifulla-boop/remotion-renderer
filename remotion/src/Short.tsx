import React from "react";
import { AbsoluteFill, Audio, Video } from "remotion";

type Props = {
  hook: string;
  description?: string;
  durationSec?: number;

  // поддержка всех вариантов
  videoUrl?: string;
  musicUrl?: string;
  videoPath?: string;
  musicPath?: string;
  videoSrc?: string;
  musicSrc?: string;

  fitMode?: "cover" | "contain";
};

export const Short: React.FC<Props> = (props) => {
  const video =
    props.videoPath || props.videoUrl || props.videoSrc || "";
  const music =
    props.musicPath || props.musicUrl || props.musicSrc || "";

  if (!video) throw new Error("No src passed (video is empty)");

  const fit = props.fitMode ?? "cover";

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill>
        <Video
          src={video}
          // 🔊 звук исходника (оставь 0.6 / сделай 0 если не нужен)
          volume={0.6}
          style={{ width: "100%", height: "100%", objectFit: fit }}
        />
      </AbsoluteFill>

      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.35)" }} />

      {music ? (
        <Audio
          src={music}
          // 🔊 музыка тише
          volume={0.8}
        />
      ) : null}

      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: 260,
        }}
      >
        <div
          style={{
            backgroundColor: "rgba(176, 92, 30, 0.80)",
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
            {props.hook}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
