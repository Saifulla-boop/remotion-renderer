import React from "react";
import {Composition} from "remotion";
import {Short} from "./Short";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Short"
        component={Short}
        width={1080}
        height={1920}
        fps={30}
        durationInFrames={30 * 12} // дефолт 12 сек (можешь перезаписывать с сервера)
        defaultProps={{
          videoSrc: "",
          musicSrc: "",
          hook: "",
        }}
      />
    </>
  );
};
