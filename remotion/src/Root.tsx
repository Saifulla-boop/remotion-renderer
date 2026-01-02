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
          // важно: названия должны совпадать с тем,
          // что ты используешь в Short.tsx и что приходит с сервера
          hook: "",
          description: "",
          durationSec: 12,
          videoPath: "",
          musicPath: "",
        }}
      />
    </>
  );
};
