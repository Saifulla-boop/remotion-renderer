import { AbsoluteFill, Video, Audio } from "remotion";

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
};

export const Short: React.FC<Props> = (props) => {
  const {
    hook = "",
    description = "",
  } = props;

  // 🔥 выбираем первый валидный src
  const videoSrc =
    props.videoSrc ??
    props.videoUrl ??
    props.videoPath;

  const musicSrc =
    props.musicSrc ??
    props.musicUrl ??
    props.musicPath;

  if (!videoSrc) {
    throw new Error(
      "Short.tsx: video src is undefined. Check server inputProps."
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* ВИДЕО — БЕЗ трансформаций */}
      <Video
        src={videoSrc}
        startFrom={0}
        endAt={undefined}
      />

      {/* МУЗЫКА — опционально */}
      {musicSrc ? <Audio src={musicSrc} /> : null}

      {/* ТЕКСТ */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
          padding: 40,
          textAlign: "center",
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
