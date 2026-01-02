import React from "react";
import { AbsoluteFill, Video, Audio, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Montserrat";

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

  // ✅ Montserrat
  const { fontFamily } = loadFont();

  const hook = (props.hook ?? "").trim();

  const videoSrc = props.videoUrl ?? props.videoSrc ?? props.videoPath ?? "";
  const musicSrc = props.musicUrl ?? props.musicSrc ?? props.musicPath ?? "";

  if (!videoSrc) {
    throw new Error("Short.tsx: video src is undefined. Check server inputProps.");
  }

  const videoVolume = typeof props.videoVolume === "number" ? props.videoVolume : 1;
  const musicVolume = typeof props.musicVolume === "number" ? props.musicVolume : 0.35;

  // База под 1080x1920
  const base = Math.min(width, height); // при 1080x1920 = 1080

  // ✅ подложка как в рефе: ширина/отступы/радиус
  const padY = Math.round(base * 0.020); // ~22
  const padX = Math.round(base * 0.055); // ~59
  const radius = Math.round(base * 0.030); // ~32
  const fontSize = Math.round(base * 0.050); // ~54
  const lineHeight = 1.15;

  // ✅ позиция блока: нижняя треть (как в рефе)
  const bottomOffset = Math.round(height * 0.33);

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* ВИДЕО — без растяжений */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <Video
          src={videoSrc}
          muted={false}
          volume={videoVolume}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            objectPosition: "center",
          }}
        />
      </AbsoluteFill>

      {/* ✅ Лёгкое притемнение фона как в рефе */}
      <AbsoluteFill style={{ backgroundColor: "rgba(0,0,0,0.18)" }} />

      {/* Музыка поверх */}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume} /> : null}

      {/* ТЕКСТ-БЛОК */}
      <AbsoluteFill style={{ pointerEvents: "none" }}>
        <div
          style={{
            position: "absolute",
            left: "50%",
            transform: "translateX(-50%)",
            bottom: bottomOffset,

            width: "86%", // как по ощущению в рефе
            maxWidth: 980,

            background: "rgba(170, 85, 20, 0.78)", // оранжевый + прозрачность
            borderRadius: radius,

            padding: `${padY}px ${padX}px`,
            textAlign: "center",

            // лёгкая глубина (в рефе почти нет, но приятнее)
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",

            // если хочешь прям “стекло”, включи:
            // backdropFilter: "blur(6px)",
            // WebkitBackdropFilter: "blur(6px)",
          }}
        >
          <div
            style={{
              fontFamily,
              fontWeight: 400, // в рефе выглядит тонко, можно 300 если надо ещё легче
              fontSize,
              lineHeight,
              color: "rgba(255,255,255,0.96)",

              // чуть “воздуха” как в рефе
              letterSpacing: "0.2px",
            }}
          >
            {hook}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
