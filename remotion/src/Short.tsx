import { AbsoluteFill, Video, Audio, useVideoConfig } from "remotion";

type Props = {
  hook?: string;
  description?: string;
  durationSec?: number;

  // поддерживаем все варианты
  videoUrl?: string;
  videoPath?: string;
  videoSrc?: string;

  musicUrl?: string;
  musicPath?: string;
  musicSrc?: string;

  // опционально, если захочешь управлять
  musicVolume?: number; // 0..1
  videoVolume?: number; // 0..1
};

export const Short: React.FC<Props> = (props) => {
  const { width, height } = useVideoConfig();

  const hook = props.hook ?? "";
  const description = props.description ?? "";

  // Берём первый валидный src
  const videoSrc = props.videoUrl ?? props.videoSrc ?? props.videoPath ?? "";
  const musicSrc = props.musicUrl ?? props.musicSrc ?? props.musicPath ?? "";

  if (!videoSrc) {
    throw new Error("Short.tsx: video src is undefined. Check server inputProps.");
  }

  // Громкости (чтобы голос не утопить в музыке)
  const videoVolume = typeof props.videoVolume === "number" ? props.videoVolume : 1;
  const musicVolume = typeof props.musicVolume === "number" ? props.musicVolume : 0.35;

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* ВИДЕО + ОРИГИНАЛЬНЫЙ ЗВУК */}
      <Video
        src={videoSrc}
        // важно: включаем звук видео
        muted={false}
        volume={videoVolume}
        // чтобы не было растяжения/деформации
        style={{
          width,
          height,
          objectFit: "cover", // или "contain" если хочешь черные поля вместо кропа
        }}
      />

      {/* МУЗЫКА поверх (тише, чтобы не убить голос) */}
      {musicSrc ? <Audio src={musicSrc} volume={musicVolume} /> : null}

      {/* ТЕКСТ */}
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
