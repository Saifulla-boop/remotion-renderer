import React from "react";
import { Composition } from "remotion";
import { Short } from "./Short";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Short"
    component={Short}
    width={1080}
    height={1920}
    fps={30}
    durationInFrames={30 * 12}
    defaultProps={{
      hook: "Почему бизнес не масштабируется",
      videoUrl: "",
      musicUrl: "",
      durationSec: 12,
      style: "premium_business",
      emphasis: ["не масштабируется"],
    }}
  />
);
