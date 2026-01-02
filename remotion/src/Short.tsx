import { AbsoluteFill, Video, Audio, useVideoConfig } from "remotion";

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
      {/* Центрируем видео, не растягиваем — будут черные поля для горизонтальных */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Video
          src={videoSrc}
          muted={false}
          volume={videoVolume}
          style={{
            width,
            height,
            objectFit: "contain", // ключ: без растяжения
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
            background: "rgba(0,0,0,0.6)",
            color: "white",
            padding: "24px 32px",
            borderRadius: 16,
            fontSize: 48,
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
