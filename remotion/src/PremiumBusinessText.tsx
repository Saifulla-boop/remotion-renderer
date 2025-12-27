import React, { useMemo } from "react";
import { interpolate, useCurrentFrame } from "remotion";

type Props = {
  hook: string;
  emphasis?: string[]; // 1–2 слова/фразы для подсветки
};

const clampWords = (text: string, maxWords: number) => {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text.trim();
  return words.slice(0, maxWords).join(" ").trim();
};

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export const PremiumBusinessText: React.FC<Props> = ({ hook, emphasis }) => {
  const frame = useCurrentFrame();

  // Премиум-правило: коротко. Если LLM прислал длинно — подрежем без боли.
  const safeHook = useMemo(() => clampWords(hook || "", 9), [hook]);

  // Плавный “дорогой” вход: задержка + micro-slide
  const opacity = interpolate(frame, [10, 26], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(frame, [10, 26], [10, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  // Размечаем акценты (подсветка золотом)
  const parts = useMemo(() => {
    if (!emphasis?.length) return [{ t: safeHook, accent: false }];

    // Берём максимум 2 акцента
    const em = emphasis
      .filter(Boolean)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .slice(0, 2);

    if (!em.length) return [{ t: safeHook, accent: false }];

    // Делаем один regex на “поймать” любую из фраз
    const pattern = em.map(escapeRegExp).join("|");
    const re = new RegExp(`(${pattern})`, "gi");

    const raw = safeHook.split(re);
    return raw
      .filter((t) => t.length > 0)
      .map((t) => ({
        t,
        accent: em.some((e) => t.toLowerCase() === e.toLowerCase()),
      }));
  }, [safeHook, emphasis]);

  return (
    <div
      style={{
        position: "absolute",
        top: "20%",
        left: 0,
        right: 0,
        paddingLeft: 72,
        paddingRight: 72,
        transform: `translateY(${y}px)`,
        opacity,
      }}
    >
      {/* Подложка-градиент сверху (чтобы текст читался и выглядел “дорого”) */}
      <div
        style={{
          position: "absolute",
          top: -120,
          left: 0,
          right: 0,
          height: 320,
          background:
            "linear-gradient(to bottom, rgba(0,0,0,0.68), rgba(0,0,0,0))",
          pointerEvents: "none",
        }}
      />

      {/* Карточка-плашка (очень мягкая, без “сторис-стикеров”) */}
      <div
        style={{
          display: "inline-block",
          maxWidth: "88%",
          padding: "26px 30px",
          borderRadius: 22,
          background: "rgba(0,0,0,0.46)",
          backdropFilter: "blur(10px)",
          WebkitBackdropFilter: "blur(10px)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 18px 40px rgba(0,0,0,0.35)",
        }}
      >
        {/* “Золотая” линия как премиум-акцент */}
        <div
          style={{
            width: 56,
            height: 3,
            borderRadius: 999,
            background: "#C9A24D",
            marginBottom: 14,
            opacity: 0.95,
          }}
        />

        <div
          style={{
            fontFamily:
              'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
            fontSize: 64,
            fontWeight: 750,
            letterSpacing: "-0.01em",
            lineHeight: 1.08,
            color: "#FFFFFF",
            textShadow: "0 10px 26px rgba(0,0,0,0.40)",
          }}
        >
          {parts.map((p, i) => (
            <span
              key={i}
              style={{
                color: p.accent ? "#C9A24D" : "#FFFFFF",
              }}
            >
              {p.t}
            </span>
          ))}
        </div>

        {/* маленькая подпись “брендовая”, можно убрать */}
        <div
          style={{
            marginTop: 14,
            fontFamily:
              'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial',
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: "0.02em",
            color: "rgba(255,255,255,0.72)",
          }}
        >
          business notes
        </div>
      </div>
    </div>
  );
};
