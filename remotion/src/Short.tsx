import { AbsoluteFill, Video, useVideoConfig } from "remotion";

type Props = {
  videoSrc?: string;
  videoUrl?: string;
  videoPath?: string;
};

export const Short: React.FC<Props> = (props) => {
  const { width, height } = useVideoConfig();
  const src = props.videoSrc ?? props.videoUrl ?? props.videoPath;

  if (!src) throw new Error("Missing video src");

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Video
        src={src}
        style={{
          width,
          height,
          objectFit: "contain", // без растяжения
        }}
      />
    </AbsoluteFill>
  );
};
