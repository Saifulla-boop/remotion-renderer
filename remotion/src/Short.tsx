import React from "react";
import { AbsoluteFill, Audio } from "remotion";
import { OffthreadVideo } from "remotion";
import { PremiumBusinessText } from "./PremiumBusinessText";

export const Short: React.FC<{
  hook: string;
  videoUrl: string;
  musicUrl: string;
  durationSec: number;
  style?: string;
  emphasis?: string[];
}> = ({ hook, videoUrl, musicUrl, style, emphasis }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill>
        <OffthreadVideo src={videoUrl} />
      </AbsoluteFill>

      {/* Премиум-стиль (пока один) */}
      {style === "premium_business" || !style ? (
        <PremiumBusinessText hook={hook} emphasis={emphasis} />
      ) : (
        <PremiumBusinessText hook={hook} emphasis={emphasis} />
      )}

      {musicUrl ? <Audio src={musicUrl} volume={0.1} /> : null}
    </AbsoluteFill>
  );
};
