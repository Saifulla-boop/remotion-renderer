import React from "react";
import { Composition } from "remotion";
import { Short } from "./Short";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Short"
        component={Short}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={30 * 12}
        defaultProps={{
          hook: "Почему нет продаж?",
          videoUrl: "",
          musicUrl: "",
          durationSec: 12,

          // === НОВОЕ ===
          // Позиция текста: "top" или "center"
          textPosition: "top",
        }}
      />
    </>
  );
};
