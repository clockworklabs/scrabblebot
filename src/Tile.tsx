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
