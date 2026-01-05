import React, { useMemo } from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  useVideoConfig,
  interpolate,
  useCurrentFrame,
} from "remotion";

type Props = {
  hook?: string;
  description?: string;
  durationSec?: number;

  videoUrl?: string;
  videoPath?: string;
  videoSrc?: string;

  musicUrl?: string;
  musicPath?: string;
  musicSrc?: string;

  musicVolume?: number; // 0..1
  videoVolume?: number; // 0..1
};

export const Short: React.FC<Props> = (props) => {
  const { width, height, fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  const hook = props.hook ?? "";

  const videoSrc = props.videoUrl ?? props.videoSrc ?? props.videoPath ?? "";
  const musicSrc = props.musicUrl ?? props.musicSrc ?? props.musicPath ?? "";

  if (!videoSrc) {
    throw new Error("Short.tsx: video src is undefined. Check server inputProps.");
  }

  const videoVolume = typeof props.videoVolume === "number" ? props.videoVolume : 1;
  const musicVolumeBase = typeof props.musicVolume === "number" ? props.musicVolume : 0.35;

  const musicVolume = useMemo(() => {
    const fadeIn = interpolate(frame, [0, Math.round(fps * 0.35)], [0, 1], {
      extrapolateRight: "clamp",
    });
    const fadeOut = interpolate(
      frame,
      [durationInFrames - Math.round(fps * 0.5), durationInFrames],
      [1, 0],
      { extrapolateLeft: "clamp" }
    );
    return musicVolumeBase * fadeIn * fadeOut;
  }, [frame, fps, durationInFrames, musicVolumeBase]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: "black",
        fontFamily: "Montserrat, Arial, sans-serif",
      }}
    >
      {/* VIDEO */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <OffthreadVideo
          src={videoSrc}
          volume={videoVolume}
          style={{
            width,
            height,
            objectFit: "contain",
          }}
        />
      </AbsoluteFill>

      {/* DIM OVERLAY (30–40%) */}
      <AbsoluteFill
        style={{
          backgroundColor: "rgba(0,0,0,0.4)", // 0.30–0.40 как просила
        }}
      />

      {/* MUSIC */}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume} /> : null}

      {/* HOOK (без плашки) */}
      {hook ? (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            padding: 80,
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              maxWidth: "92%",
              color: "rgba(255,255,255,0.88)",
              fontSize: 54,
              lineHeight: 1.12,
              fontWeight: 300, // будет работать ТОЛЬКО если подключен Montserrat Light (300)
              letterSpacing: 0.2,
              textShadow: "0 10px 30px rgba(0,0,0,0.55)",
              whiteSpace: "pre-wrap",
              WebkitFontSmoothing: "antialiased",
            }}
          >
            {hook}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
