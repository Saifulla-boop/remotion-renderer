import React from "react";
import { Composition, staticFile } from "remotion";
import { Short } from "./Short";

const fontCss = `
@font-face {
  font-family: "Montserrat";
  src: url("${staticFile("fonts/Montserrat-Regular.ttf")}") format("truetype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Montserrat";
  src: url("${staticFile("fonts/Montserrat-SemiBold.ttf")}") format("truetype");
  font-weight: 600;
  font-style: normal;
  font-display: swap;
}
`;

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* ВАЖНО: никаких сетевых загрузок шрифта */}
      <style dangerouslySetInnerHTML={{ __html: fontCss }} />

      <Composition
        id="Short"
        component={Short}
        width={1080}
        height={1920}
        fps={60}
        durationInFrames={60 * 10}
        defaultProps={{
          hook: "Почему нет продаж?",
          description: "",
          videoUrl: "",
          musicUrl: "",
          durationSec: 10,
          textPosition: "top",
          musicVolume: 0.35,
          videoVolume: 1,
        }}
      />
    </>
  );
};
