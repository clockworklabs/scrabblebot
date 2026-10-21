import type { CSSProperties } from "react";
import { letterValue } from "./util";

type Size = "xs" | "sm" | "md" | "lg" | "xl";

export function Tile({
  letter,
  size = "md",
  style,
}: {
  letter: string;
  size?: Size;
  style?: CSSProperties;
}) {
  const value = letterValue(letter);
  return (
    <span className={`tile tile-${size}`} style={style} aria-label={letter}>
      <span className="tile-letter">{letter.toUpperCase()}</span>
      {value > 0 && <span className="tile-value">{value}</span>}
    </span>
  );
}

export function TileWord({ word, size = "xs" }: { word: string; size?: Size }) {
  return (
    <span className="tile-word" aria-label={word}>
      {[...word].map((c, i) => (
        <Tile key={i} letter={c} size={size} />
      ))}
    </span>
  );
}

// A tile we know is on a rack but can't see: one of the starting tiles,
// which are dealt privately.
export function HiddenTile({ size = "xs" }: { size?: Size }) {
  return (
    <span
      className={`tile tile-${size} tile-back`}
      aria-label="hidden tile"
      title="Dealt face-down at the start"
    >
      {/* A closed eye: the letter is there, we just can't see it. */}
      <svg className="tile-eye" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3.5 9.5 Q12 17 20.5 9.5" />
        <path d="M6.6 12.6 L5 15.2 M12 14.3 V17.4 M17.4 12.6 L19 15.2" />
      </svg>
    </span>
  );
}

// The SpacetimeDB logo, sized to fill a tile.
export function SpacetimeLogo() {
  return (
    <svg className="tile-logo" viewBox="0 0 1024 1024" aria-hidden="true">
      <path d="M801.285 494.626C794.969 347.477 822.529 262.47 960 105L685.182 382.538C750.957 467.617 745.091 590.845 667.583 669.119C590.074 747.394 468.054 753.319 383.808 686.893L332.908 738.296L333.096 738.455L252.233 820.711C313.289 784.997 407.572 795.245 464.448 801.426C480.202 803.138 493.085 804.539 501.598 804.564C579.51 808.434 658.69 780.323 718.193 720.231C779.429 658.389 807.126 575.504 801.285 494.626Z" />
      <path d="M522.402 219.436C530.915 219.461 543.799 220.862 559.552 222.574C616.428 228.755 710.711 239.003 771.767 203.289L690.904 285.545L691.093 285.704L640.192 337.107C555.946 270.681 433.926 276.606 356.418 354.881C278.909 433.155 273.043 556.383 338.818 641.463L64 919C201.471 761.53 229.031 676.523 222.715 529.374C216.874 448.496 244.571 365.611 305.807 303.769C365.31 243.677 444.49 215.566 522.402 219.436Z" />
      <path
        fillRule="evenodd"
        d="M697.564 511.999C697.564 615.497 614.484 699.399 512 699.399C409.516 699.399 326.436 615.497 326.436 511.999C326.436 408.501 409.516 324.6 512 324.6C614.484 324.6 697.564 408.501 697.564 511.999ZM512 654.45C590.726 654.45 654.545 590.673 654.545 512C654.545 433.327 590.726 369.55 512 369.55C433.274 369.55 369.455 433.327 369.455 512C369.455 590.673 433.274 654.45 512 654.45Z"
      />
    </svg>
  );
}

export function Rack({
  letters,
  hidden,
  size = "xs",
  className,
}: {
  letters: string[];
  hidden: number;
  size?: Size;
  className?: string;
}) {
  if (letters.length === 0 && hidden === 0) return null;
  return (
    <span className={className} aria-label="Rack">
      {letters.map((t, i) => (
        <Tile key={i} letter={t} size={size} />
      ))}
      {Array.from({ length: hidden }, (_, i) => (
        <HiddenTile key={`h${i}`} size={size} />
      ))}
    </span>
  );
}
