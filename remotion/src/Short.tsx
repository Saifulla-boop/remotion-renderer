import React from "react";
import { AbsoluteFill, Audio, useCurrentFrame, interpolate } from "remotion";
import { OffthreadVideo } from "remotion";

export const Short: React.FC<any> = ({
  hook,
  videoUrl,
  musicUrl,
}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 15], [0, 1]);

  return (
    <AbsoluteFill>
      <OffthreadVideo src={videoUrl} />

      <div
        style={{
          position: "absolute",
          top: 60,
          left: 60,
          right: 60,
          color: "white",
          fontSize: 72,
          fontWeight: 800,
          lineHeight: 1.1,
          opacity,
          textShadow: "0 8px 24px rgba(0,0,0,0.6)",
        }}
      >
        {hook}
      </div>

      {musicUrl && <Audio src={musicUrl} volume={0.12} />}
    </AbsoluteFill>
  );
};
