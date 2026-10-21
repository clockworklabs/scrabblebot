// Where every bot in a match stands: rank, rack, points and balance, with
// each freshly played word shown briefly under its player's score.
import { useLayoutEffect, useRef } from "react";
import type { MatchParticipant, WordPlay } from "./module_bindings/types";
import type { BotNames } from "./data";
import {
  competitionRank,
  fmtTimestamp,
  rackTiles,
  type PublicRack,
} from "./util";
import { Rack, TileWord } from "./Tile";

// How long a freshly played word lingers under its player's score.
const WORD_FADE_MS = 4000;
// Words older than this by the server's clock were already history when the
// page loaded, so they don't get the fresh-word treatment.
const WORD_STALE_MS = 10000;

export function Standings({
  participants,
  racks,
  plays,
  botName,
  now,
  limit,
  startingRackSize,
}: {
  // Highest score first.
  participants: MatchParticipant[];
  racks: Map<bigint, PublicRack>;
  // How many face-down tiles each bot was dealt (the match's own setting).
  startingRackSize: number;
  plays: WordPlay[];
  botName: BotNames;
  now: number;
  // Show only this many places.
  limit?: number;
}) {
  const fresh = useFreshWords(plays, now);
  // Bots level on points share a rank, so a tie for first shows as a tie.
  const rankOf = competitionRank(participants, (p) => p.score);
  const topScore = participants[0]?.score;
  const shown = participants.slice(0, limit);
  const listRef = useSmoothRows(shown.map((p) => String(p.id)));

  return (
    <ol className="standings" ref={listRef}>
      {shown.map((p) => {
        const word = fresh.get(p.botId);
        const leading = p.score === topScore && p.score > 0n;
        return (
          <li
            key={String(p.id)}
            data-key={String(p.id)}
            className={leading ? "leading" : undefined}
            onTransitionEnd={(e) => {
              if (e.target === e.currentTarget) {
                e.currentTarget.classList.remove("st-resizing");
              }
            }}
          >
            <div className="st-row">
              <span className="st-rank">{rankOf(p)}</span>
              <div className="st-who">
                <span className="st-name">{botName(p.botId)}</span>
                <Rack
                  {...rackTiles(racks, p.botId, startingRackSize)}
                  className="st-rack"
                />
              </div>
              <div className="st-score">
                <span className="st-points">{String(p.score)}</span>
                <span className="st-balance" title="Currency left to bid with">
                  {String(p.balance)} coins
                </span>
                {word && (
                  // Keyed by play, so a new word starts its own fade.
                  <span
                    key={String(word.id)}
                    className="st-word"
                    style={{ animationDuration: `${WORD_FADE_MS}ms` }}
                  >
                    <TileWord word={word.word} />
                    <span className="st-word-points">
                      +{String(word.totalReward)}
                    </span>
                  </span>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// Each bot's latest word, while it's still fresh. Freshness is timed from
// when this browser first saw the play rather than from `playedAt`, because
// the client's clock can drift from the server's by a second or more, which
// is most of the fade.
function useFreshWords(plays: WordPlay[], now: number) {
  const firstSeen = useRef(new Map<bigint, number>());
  const fresh = new Map<bigint, WordPlay>();
  for (const play of plays) {
    if (!firstSeen.current.has(play.id)) firstSeen.current.set(play.id, now);
    const age = now - firstSeen.current.get(play.id)!;
    const stale = now - fmtTimestamp(play.playedAt) > WORD_STALE_MS;
    const prev = fresh.get(play.botId);
    if (age < WORD_FADE_MS && !stale && (!prev || play.id > prev.id)) {
      fresh.set(play.botId, play);
    }
  }
  return fresh;
}

const MOVE_MS = 320;
const MOVE_EASING = "cubic-bezier(0.2, 0.8, 0.2, 1)";

// Keeps the list from jerking as it changes. Each row's height follows its
// contents (a new word, a rack that wraps) through a CSS transition, and
// when the order changes, rows slide from their old places to their new ones.
function useSmoothRows(keys: string[]) {
  const listRef = useRef<HTMLOListElement>(null);
  const order = keys.join(",");
  const lastOrder = useRef(order);
  // The rows being watched for size changes, and whether any ever were.
  const observed = useRef(new WeakSet<Element>());
  const shownBefore = useRef(false);

  // Where each row was before this render reaches the DOM. Measured during
  // render because by the layout effect the rows have already moved.
  const before = new Map<string, number>();
  if (listRef.current && order !== lastOrder.current) {
    for (const li of rows(listRef.current)) {
      before.set(li.dataset.key!, li.getBoundingClientRect().top);
    }
  }

  // Pin each row's height to its contents' height, so a change in the
  // contents becomes a change in a pixel height, which can transition.
  const observer = useRef<ResizeObserver>();
  useLayoutEffect(() => {
    const ro = new ResizeObserver((entries) => {
      for (const { target, borderBoxSize } of entries) {
        // A row that's left the list (dropped out of a top three) is done.
        if (!target.isConnected) {
          ro.unobserve(target);
          continue;
        }
        const li = target.parentElement!;
        const next = `${borderBoxSize[0].blockSize + borderBottom(li)}px`;
        const animated = !matchMedia("(prefers-reduced-motion: reduce)")
          .matches;
        if (animated && li.style.height && li.style.height !== next) {
          li.classList.add("st-resizing");
        }
        li.style.height = next;
      }
    });
    observer.current = ro;
    observed.current = new WeakSet();
    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    lastOrder.current = order;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const firstShowing = !shownBefore.current;
    for (const li of rows(list)) {
      const key = li.dataset.key!;
      if (!observed.current.has(li)) {
        observed.current.add(li);
        observer.current?.observe(li.firstElementChild!);
        // A newcomer (say, climbing into a top three) fades in, unless
        // it's part of the list's first appearance.
        if (!firstShowing && !still) {
          li.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: MOVE_MS,
            easing: "ease-out",
          });
        }
      }
      const was = before.get(key);
      if (was === undefined || still) continue;
      const dy = was - li.getBoundingClientRect().top;
      if (dy !== 0) {
        li.animate(
          [{ transform: `translateY(${dy}px)` }, { transform: "none" }],
          { duration: MOVE_MS, easing: MOVE_EASING },
        );
      }
    }
    if (list.children.length > 0) shownBefore.current = true;
  });

  return listRef;
}

function rows(list: HTMLElement) {
  return list.children as HTMLCollectionOf<HTMLLIElement>;
}

function borderBottom(el: HTMLElement) {
  return parseFloat(getComputedStyle(el).borderBottomWidth) || 0;
}
