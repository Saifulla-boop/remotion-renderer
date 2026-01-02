import React from "react";
import { AbsoluteFill, Audio, Video, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Montserrat";

const { fontFamily } = loadFont();

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
  const { width, height } = useVideoConfig();

  const hook = props.hook ?? "";
  const description = props.description ?? "";

  const videoSrc = props.videoUrl ?? props.videoSrc ?? props.videoPath ?? "";
  const musicSrc = props.musicUrl ?? props.musicSrc ?? props.musicPath ?? "";

  if (!videoSrc) {
    throw new Error("Short.tsx: video src is undefined. Check server inputProps.");
  }

  const videoVolume = typeof props.videoVolume === "number" ? props.videoVolume : 1;
  const musicVolume = typeof props.musicVolume === "number" ? props.musicVolume : 0.35;

  return (
    <AbsoluteFill style={{ backgroundColor: "black", fontFamily }}>
      {/* VIDEO */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <Video
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
          backgroundColor: "rgba(0,0,0,0.25)", // притемнение как в рефе
        }}
      />

      {/* MUSIC */}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume} /> : null}

      {/* HOOK BOX (как референс: оранжевая полупрозрачная плашка) */}
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
              background: "rgba(170, 92, 40, 0.72)", // близко к рефу
              borderRadius: 22,
              padding: "26px 34px",
              maxWidth: "92%",
              color: "rgba(255,255,255,0.92)",
              fontSize: 56,
              lineHeight: 1.15,
              fontWeight: 500,
              letterSpacing: 0.2,
              // лёгкое “стекло”, если браузер поддержит
              backdropFilter: "blur(6px)",
              WebkitBackdropFilter: "blur(6px)",
            }}
          >
            {hook}
          </div>
        </AbsoluteFill>
      ) : null}

      {/* DESCRIPTION (низом, аккуратно) */}
      {description ? (
        <AbsoluteFill
          style={{
            justifyContent: "flex-end",
            alignItems: "center",
            padding: 64,
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          <div
            style={{
              maxWidth: "92%",
              color: "rgba(255,255,255,0.85)",
              fontSize: 30,
              lineHeight: 1.35,
              fontWeight: 400,
              textShadow: "0 2px 16px rgba(0,0,0,0.6)",
              whiteSpace: "pre-wrap",
            }}
          >
            {description}
          </div>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};
