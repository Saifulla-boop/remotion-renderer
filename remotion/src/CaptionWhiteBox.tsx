import React, { useMemo } from "react";
import { interpolate, useCurrentFrame } from "remotion";

type Props = {
  hook: string;
};

function normalize(text: string) {
  return (text || "")
    .replace(/\s+/g, " ")
    .trim();
}

// Простой автоскейл по длине: чем больше символов — тем меньше шрифт.
// Это не идеально как типографический движок, но даёт “как в рефе” стабильно.
function fontSizeByLength(len: number) {
  if (len <= 45) return 52;
  if (len <= 70) return 44;
  if (len <= 95) return 38;
  if (len <= 125) return 34;
  return 30;
}

export const CaptionWhiteBox: React.FC<Props> = ({ hook }) => {
  const frame = useCurrentFrame();

  const text = useMemo(() => {
    // как в референсе: КАПС + без лишней пунктуации
    const t = normalize(hook).toUpperCase();
    return t;
  }, [hook]);

  const opacity = interpolate(frame, [6, 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const y = interpolate(frame, [6, 16], [10, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const fs = fontSizeByLength(text.length);

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // нижняя зона: чтобы не залезать на кнопки/описание в Reels
        bottom: 260,
        display: "flex",
        justifyContent: "center",
        transform: `translateY(${y}px)`,
        opacity,
        paddingLeft: 44,
        paddingRight: 44,
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 980,
          background: "rgba(255,255,255,0.98)",
          borderRadius: 18,
          padding: "22px 26px",
          boxShadow: "0 18px 40px rgba(0,0,0,0.22)",
          border: "1px solid rgba(0,0,0,0.06)",
        }}
      >
        <div
          style={{
            fontFamily:
              'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
            fontWeight: 900,
            fontSize: fs,
            lineHeight: 1.08,
            letterSpacing: "-0.01em",
            color: "#0B0B0B",
            textAlign: "center",
            // переносы как в IG
            wordBreak: "break-word",
            overflowWrap: "anywhere",
          }}
        >
          {text}
        </div>
      </div>
    </div>
  );
};
