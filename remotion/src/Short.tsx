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
  const description = props.description ?? "";

  const videoSrc = props.videoUrl ?? props.videoSrc ?? props.videoPath ?? "";
  const musicSrc = props.musicUrl ?? props.musicSrc ?? props.musicPath ?? "";

  if (!videoSrc) {
    throw new Error("Short.tsx: video src is undefined. Check server inputProps.");
  }

  const videoVolume =
    typeof props.videoVolume === "number" ? props.videoVolume : 1;
  const musicVolumeBase =
    typeof props.musicVolume === "number" ? props.musicVolume : 0.35;

  // Лёгкий fade музыки (чтобы не рубило по ушам, и избегаем резких артефактов)
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
        // Montserrat теперь берется из Root.tsx (локальный @font-face)
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
            objectFit: "contain", // no stretch
          }}
        />
      </AbsoluteFill>

      {/* DIM OVERLAY */}
      <AbsoluteFill
        style={{
          backgroundColor: "rgba(0,0,0,0.25)",
        }}
      />

      {/* MUSIC */}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume} /> : null}

      {/* HOOK BOX */}
      {hook ? (
        <AbsoluteFill
          style={{
            justifyContent: "center",
            alignItems: "center",
            padding: 64,
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              background: "rgba(170, 92, 40, 0.72)",
              borderRadius: 22,
              padding: "26px 34px",
              maxWidth: "92%",
              color: "rgba(255,255,255,0.92)",
              fontSize: 56,
              lineHeight: 1.15,
              fontWeight: 600,
              letterSpacing: 0.2,
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
            }}
          >
            {hook}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
