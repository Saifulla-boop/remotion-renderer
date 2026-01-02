import { AbsoluteFill, Video, Audio, useVideoConfig } from "remotion";
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

  const videoSrc = props.videoUrl ?? props.videoSrc ?? props.videoPath ?? "";
  const musicSrc = props.musicUrl ?? props.musicSrc ?? props.musicPath ?? "";

  if (!videoSrc) {
    throw new Error("Short.tsx: video src is undefined. Check server inputProps.");
  }

  const videoVolume = typeof props.videoVolume === "number" ? props.videoVolume : 1;
  const musicVolume = typeof props.musicVolume === "number" ? props.musicVolume : 0.35;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* Видео по центру, без растяжения */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <Video
          src={videoSrc}
          muted={false}
          volume={videoVolume}
          style={{
            width,
            height,
            objectFit: "contain",
            backgroundColor: "black",
          }}
        />
      </AbsoluteFill>

      {/* Музыка поверх */}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume} /> : null}

      {/* Текст */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: 40,
          textAlign: "center",
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            fontFamily,
            fontWeight: 500,
            background: "rgba(176, 95, 36, 0.72)", // приблизим под референс (потом подгоним 1:1)
            color: "white",
            padding: "22px 32px",
            borderRadius: 18,
            fontSize: 54,
            lineHeight: 1.2,
            maxWidth: "90%",
          }}
        >
          {hook}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
