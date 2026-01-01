import React, {useMemo} from "react";
import {AbsoluteFill, Audio, Video, useVideoConfig} from "remotion";

type Props = {
  hook: string;
  videoPath: string;
  musicPath: string;
};

const ORANGE = "rgba(164, 86, 22, 0.78)"; // полупрозрачная оранжевая плашка (как на рефе)
const DIM = "rgba(0,0,0,0.20)";           // лёгкое затемнение всего видео

// ВАЖНО: именно здесь правишь положение/размер как просил
const CARD_Y = 0.63;     // 0..1 — вертикальная позиция плашки (0.63 ≈ ниже середины, как на фото 1)
const CARD_MAX_W = 0.86; // ширина плашки относительно кадра
const CARD_PAD_Y = 28;
const CARD_PAD_X = 34;
const CARD_RADIUS = 18;

function normalizeHook(text: string) {
  // Чистим лишние пробелы + мягко ограничиваем переносы
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

export const Short: React.FC<Props> = ({hook, videoPath, musicPath}) => {
  const {width, height} = useVideoConfig();

  const clean = useMemo(() => normalizeHook(hook), [hook]);

  /**
   * СТИЛЬ КАК В РЕФЕ:
   * - тонкий шрифт
   * - белый цвет
   * - немного трекинга
   */
  const fontFamily =
    'Inter, "SF Pro Display", -apple-system, system-ui, Segoe UI, Roboto, Arial, sans-serif';

  return (
    <AbsoluteFill style={{backgroundColor: "black"}}>
      {/* Видео: без растяжения — contain по центру + чёрные поля если горизонталь */}
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Video
          src={videoPath}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
          }}
          muted
        />
      </AbsoluteFill>

      {/* Лёгкое затемнение всего видео */}
      <AbsoluteFill style={{backgroundColor: DIM}} />

      {/* Плашка + текст */}
      <AbsoluteFill
        style={{
          justifyContent: "flex-start",
          alignItems: "center",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: `${CARD_Y * height}px`,
            left: "50%",
            transform: "translateX(-50%)",
            width: `${CARD_MAX_W * width}px`,
            backgroundColor: ORANGE,
            borderRadius: CARD_RADIUS,
            padding: `${CARD_PAD_Y}px ${CARD_PAD_X}px`,
            boxSizing: "border-box",
          }}
        >
          <div
            style={{
              fontFamily,
              fontWeight: 300,
              fontSize: 54,          // если надо тоньше/меньше — снижай
              lineHeight: 1.15,
              letterSpacing: 0.5,
              color: "rgba(255,255,255,0.95)",
              textAlign: "center",
              textShadow: "0 1px 2px rgba(0,0,0,0.25)",
              wordBreak: "break-word",
              whiteSpace: "pre-wrap",
            }}
          >
            {clean}
          </div>
        </div>
      </AbsoluteFill>

      {/* Музыка */}
      <Audio src={musicPath} />
    </AbsoluteFill>
  );
};
