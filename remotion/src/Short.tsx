import React from "react";
import { AbsoluteFill, Audio, Video } from "remotion";

type Props = {
  hook: string;
  description?: string;
  durationSec?: number;

  // новые
  videoPath?: string;
  musicPath?: string;

  // старые
  videoSrc?: string;
  musicSrc?: string;
};

export const Short: React.FC<Props> = (props) => {
  const hook = props.hook ?? "";

  // ✅ берём сначала новые, если их нет — старые
  const video = props.videoPath ?? props.videoSrc ?? "";
  const music = props.musicPath ?? props.musicSrc ?? "";

  if (!video || typeof video !== "string") {
    throw new Error("No src passed (videoPath is empty)");
  }
  if (!music || typeof music !== "string") {
    throw new Error("No src passed (musicPath is empty)");
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill>
        <Video
          src={video}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      </AbsoluteFill>

      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.35)" }} />

      <Audio src={music} />

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
            {hook}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
