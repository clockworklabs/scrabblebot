// A bot's rating over time: the rating after each match as a line and its ±
// as a band, with a crosshair that reads off the nearest match.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { signed } from "./util";

export type RatingPoint = {
  at: number; // ms since the epoch
  rating: number;
  spread: number;
  matchId: bigint;
};

const HEIGHT = 260;
const MARGIN = { top: 16, right: 56, bottom: 40, left: 48 };
// Clean steps for the gridlines, in rating points.
const Y_STEPS = [25, 50, 100, 200, 250, 500, 1000];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const X_STEPS = [
  [1, 2, 5, 10, 15, 30].map((m) => m * MINUTE),
  [1, 2, 3, 6, 12].map((h) => h * HOUR),
  [1, 2, 7, 14, 30].map((d) => d * DAY),
].flat();

export function RatingChart({ points }: { points: RatingPoint[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const width = useWidth(wrap);
  const [active, setActive] = useState<number | null>(null);
  const last = points.length - 1;

  const innerW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  // A lone match gets an hour either side, so it isn't drawn on an edge.
  const end = points[last];
  const t0 = points[0].at;
  const t1 = points[last].at;
  const [x0, x1] = t0 === t1 ? [t0 - HOUR, t1 + HOUR] : [t0, t1];
  const x = (t: number) => MARGIN.left + ((t - x0) / (x1 - x0)) * innerW;

  const lo = Math.min(...points.map((p) => p.rating - p.spread));
  const hi = Math.max(...points.map((p) => p.rating + p.spread));
  const yStep = Y_STEPS.find((s) => (hi - lo) / s <= 5) ?? 1000;
  const y0 = Math.floor(lo / yStep) * yStep;
  const y1 = Math.max(Math.ceil(hi / yStep) * yStep, y0 + yStep);
  const y = (r: number) => MARGIN.top + (1 - (r - y0) / (y1 - y0)) * innerH;
  const yTicks: number[] = [];
  for (let r = y0; r <= y1; r += yStep) yTicks.push(r);

  const xTicks = timeTicks(x0, x1, Math.max(2, Math.floor(innerW / 90)));

  const line = points
    .map((p, i) => `${i ? "L" : "M"}${x(p.at)},${y(p.rating)}`)
    .join("");
  // A lone match's ± is drawn as a short bar, since a band needs a width.
  const band =
    last === 0
      ? `M${x(t0) - 4},${y(end.rating + end.spread)}h8V${y(end.rating - end.spread)}h-8Z`
      : points
          .map((p, i) => `${i ? "L" : "M"}${x(p.at)},${y(p.rating + p.spread)}`)
          .join("") +
        [...points]
          .reverse()
          .map((p) => `L${x(p.at)},${y(p.rating - p.spread)}`)
          .join("") +
        "Z";

  const nearest = (px: number) => {
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(x(p.at) - px) < Math.abs(x(points[best].at) - px)) {
        best = i;
      }
    });
    return best;
  };
  const onPointerMove = (e: PointerEvent<SVGSVGElement>) =>
    setActive(
      nearest(e.clientX - e.currentTarget.getBoundingClientRect().left),
    );
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const at = active ?? last;
    const next =
      e.key === "ArrowLeft"
        ? Math.max(0, at - 1)
        : e.key === "ArrowRight"
          ? Math.min(last, at + 1)
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : undefined;
    if (e.key === "Escape") setActive(null);
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const shown = active === null ? null : points[active];

  return (
    <div className="rating-chart" ref={wrap}>
      {width > 0 && (
        <svg
          width={width}
          height={HEIGHT}
          tabIndex={0}
          role="img"
          aria-label={`Rating over ${points.length} matches, from ${points[0].rating} to ${end.rating}. Use the arrow keys to step through matches.`}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setActive(null)}
          onFocus={() => setActive((a) => a ?? last)}
          onBlur={() => setActive(null)}
          onKeyDown={onKeyDown}
        >
          <g className="grid">
            {yTicks.map((r) => (
              <g key={r}>
                <line
                  x1={MARGIN.left}
                  x2={MARGIN.left + innerW}
                  y1={y(r)}
                  y2={y(r)}
                />
                <text x={MARGIN.left - 8} y={y(r)} className="tick y">
                  {r}
                </text>
              </g>
            ))}
            {xTicks.map(({ t, time, date }) => (
              <text key={t} x={x(t)} y={HEIGHT - MARGIN.bottom + 18}>
                {time && (
                  <tspan className="tick" x={x(t)}>
                    {time}
                  </tspan>
                )}
                {date && (
                  <tspan className="tick" x={x(t)} dy={time ? 14 : 0}>
                    {date}
                  </tspan>
                )}
              </text>
            ))}
          </g>
          <path className="band" d={band} />
          <path className="line" d={line} />
          <circle className="dot" cx={x(end.at)} cy={y(end.rating)} r={4} />
          <text className="end-label" x={x(end.at) + 10} y={y(end.rating)}>
            {end.rating}
          </text>
          {shown && (
            <>
              <line
                className="crosshair"
                x1={x(shown.at)}
                x2={x(shown.at)}
                y1={MARGIN.top}
                y2={HEIGHT - MARGIN.bottom}
              />
              <circle
                className="dot"
                cx={x(shown.at)}
                cy={y(shown.rating)}
                r={4}
              />
            </>
          )}
        </svg>
      )}
      {shown && active !== null && (
        <ChartTip
          point={shown}
          previous={active > 0 ? points[active - 1] : null}
          left={x(shown.at)}
          flip={x(shown.at) > width / 2}
        />
      )}
    </div>
  );
}

function ChartTip({
  point,
  previous,
  left,
  flip,
}: {
  point: RatingPoint;
  previous: RatingPoint | null;
  left: number;
  flip: boolean;
}) {
  const change = previous && point.rating - previous.rating;
  return (
    <div
      className="chart-tip"
      style={{
        left,
        top: MARGIN.top,
        transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)",
      }}
    >
      <strong>
        {point.rating} <span className="pm">±{point.spread}</span>
      </strong>
      <span>
        {change === null
          ? "First rated match"
          : `${signed(change)} from the match before`}
      </span>
      <span className="muted">
        Match #{String(point.matchId)} ·{" "}
        {new Date(point.at).toLocaleString([], {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
      </span>
    </div>
  );
}

// Ticks on clean local-time boundaries, at most `max` of them. Each shows
// the time of day, and the date where the day changes; ticks a day or more
// apart show only the date.
function timeTicks(from: number, to: number, max: number) {
  const step = X_STEPS.find((s) => (to - from) / s <= max) ?? DAY * 30;
  const offset = new Date(from).getTimezoneOffset() * MINUTE;
  const ticks: { t: number; time: string | null; date: string | null }[] = [];
  let lastDay = "";
  for (
    let t = Math.ceil((from - offset) / step) * step + offset;
    t <= to;
    t += step
  ) {
    const d = new Date(t);
    const day = d.toLocaleDateString([], { month: "short", day: "numeric" });
    ticks.push({
      t,
      time:
        step < DAY
          ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
          : null,
      date: step >= DAY || day !== lastDay ? day : null,
    });
    lastDay = day;
  }
  return ticks;
}

function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
