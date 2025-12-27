import React from "react";
import { AbsoluteFill, Audio } from "remotion";
import { OffthreadVideo } from "remotion";
import { CaptionWhiteBox } from "./CaptionWhiteBox";

export const Short: React.FC<{
  hook: string;
  videoUrl: string;
  musicUrl: string;
  durationSec: number;
  style?: string;
}> = ({ hook, videoUrl, musicUrl, style }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <AbsoluteFill>
        <OffthreadVideo src={videoUrl} />
      </AbsoluteFill>

      {/* стиль как в фото 2 */}
      {style === "caption_white_box" ? (
        <CaptionWhiteBox hook={hook} />
      ) : (
        <CaptionWhiteBox hook={hook} /> // временно по умолчанию тоже так
      )}

      {musicUrl ? <Audio src={musicUrl} volume={0.1} /> : null}
    </AbsoluteFill>
  );
};
