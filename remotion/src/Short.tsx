import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

type Props = {
  hook: string;
  description: string;
  durationSec: number;
  videoPath: string;   // <-- КЛЮЧЕВО
  musicPath: string;   // <-- КЛЮЧЕВО
};

export const Short: React.FC<Props> = ({
  hook,
  description,
  durationSec,
  videoPath,
  musicPath,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!videoPath) {
    throw new Error("No src passed (videoPath is empty)");
  }

  // лёгкий fade-in
  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateRight: "clamp" });

  return (
    <AbsoluteFill>
      <OffthreadVideo src={videoPath} />

      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.15)" }} />

      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div
          style={{
            opacity,
            maxWidth: 900,
            padding: "28px 34px",
            borderRadius: 18,
            background: "rgba(0,0,0,0.45)",
            color: "white",
            fontSize: 64,
            fontWeight: 600,
            lineHeight: 1.15,
            textAlign: "center",
            fontFamily: "Arial",
            whiteSpace: "pre-wrap",
          }}
        >
          {hook}
        </div>
      </AbsoluteFill>

      {musicPath ? <Audio src={musicPath} /> : null}
    </AbsoluteFill>
  );
};
