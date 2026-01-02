import { AbsoluteFill, Audio, Video, useVideoConfig } from "remotion";

export const Short: React.FC<{
  hook: string;
  description?: string;
  videoSrc: string;
  musicSrc?: string;
}> = ({ hook, description, videoSrc, musicSrc }) => {
  const { width, height } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* ВИДЕО — БЕЗ SCALE */}
      <Video
        src={videoSrc}
        startFrom={0}
        style={{
          width,
          height,
        }}
      />

      {/* МУЗЫКА */}
      {musicSrc && <Audio src={musicSrc} volume={0.8} />}

      {/* ТЕКСТ */}
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: 120,
          pointerEvents: "none",
        }}
      >
        <div
          style={{
            background: "rgba(0,0,0,0.55)",
            color: "white",
            padding: "24px 32px",
            borderRadius: 24,
            fontSize: 42,
            maxWidth: "90%",
            textAlign: "center",
            lineHeight: 1.2,
          }}
        >
          {hook}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
