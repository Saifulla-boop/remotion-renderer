import React, {useMemo} from "react";
import {
  AbsoluteFill,
  Audio,
  Img,
  staticFile,
  useVideoConfig,
  Video,
} from "remotion";

type ShortProps = {
  videoSrc: string;      // ссылка на видео (у тебя формируется из videoFileId)
  musicSrc: string;      // ссылка на музыку (у тебя формируется из musicFileId)
  hook: string;          // заголовок/хук
  // description можно не рендерить на видео, оно уходит в подпись в телеге
};

const clampLines = (text: string) => (text || "").trim();

export const Short: React.FC<ShortProps> = ({videoSrc, musicSrc, hook}) => {
  const {width, height} = useVideoConfig();

  // Позиция блока (ниже, как на референсе)
  const boxBottom = Math.round(height * 0.34); // чем больше — тем ВЫШЕ, чем меньше — тем НИЖЕ
  const boxMaxWidth = Math.round(width * 0.86);

  const safeHook = useMemo(() => clampLines(hook), [hook]);

  return (
    <AbsoluteFill style={{backgroundColor: "black"}}>
      {/* Видео */}
      <AbsoluteFill>
        <Video
          src={videoSrc}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
          }}
        />
      </AbsoluteFill>

      {/* Притемнение (как на референсе) */}
      <AbsoluteFill
        style={{
          backgroundColor: "rgba(0,0,0,0.25)", // усиливай/ослабляй тут
        }}
      />

      {/* Блок с хуком */}
      <AbsoluteFill
        style={{
          justifyContent: "flex-end",
          alignItems: "center",
          paddingBottom: boxBottom,
        }}
      >
        <div
          style={{
            width: boxMaxWidth,
            backgroundColor: "rgba(175, 92, 30, 0.68)", // оранжевая подложка
            borderRadius: 26,
            padding: "22px 28px",
            boxShadow: "0 14px 40px rgba(0,0,0,0.30)",
          }}
        >
          <div
            style={{
              color: "rgba(255,255,255,0.92)",
              fontFamily:
                '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Inter", "Segoe UI", Roboto, Arial, sans-serif',
              fontWeight: 400,            // тонко, как в рефе
              fontSize: 54,               // под 1080x1920
              lineHeight: 1.12,
              letterSpacing: -0.4,
              textAlign: "center",
              whiteSpace: "pre-wrap",
            }}
          >
            {safeHook}
          </div>
        </div>
      </AbsoluteFill>

      {/* Музыка */}
      {!!musicSrc && <Audio src={musicSrc} volume={0.9} />}
    </AbsoluteFill>
  );
};
