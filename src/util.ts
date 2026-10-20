import type {
  AuctionResult,
  MatchParticipant,
  WordPlay,
} from "./module_bindings/types";

export function fmtTimestamp(ts: {
  __timestamp_micros_since_unix_epoch__: bigint;
}): number {
  return Number(ts.__timestamp_micros_since_unix_epoch__) / 1000;
}

// What the public can know about one bot's rack: the letters it won at
// auction and hasn't yet played, plus a count of tiles still face-down.
export type PublicRack = { known: Map<string, number>; hidden: number };

// Reconstruct each bot's rack in a match from public AuctionResult + WordPlay
// events, keyed by bot id. Every participant is dealt `startingRackSize`
// tiles (the match's `startingRackSize`) at the start, into the private
// `holding` table.
//
// The starting tiles are dealt privately, so a played word may use letters
// the public never saw arrive. Each played letter is taken from the known
// letters if possible, otherwise from the face-down tiles. That keeps every
// known letter genuinely on the rack, and the total tile count exact, even
// when we can't tell which of two identical letters was used.
export function reconstructRacks(
  results: AuctionResult[],
  plays: WordPlay[],
  startingRackSize: number,
): Map<bigint, PublicRack> {
  const racks = new Map<bigint, PublicRack>();
  const rackOf = (botId: bigint) => {
    let rack = racks.get(botId);
    if (!rack) {
      rack = { known: new Map(), hidden: startingRackSize };
      racks.set(botId, rack);
    }
    return rack;
  };

  // Replay in time order. A sim bot plays straight after winning, in the same
  // transaction, so on a tied timestamp the win comes first.
  type Event =
    | { at: number; kind: 0; result: AuctionResult }
    | { at: number; kind: 1; play: WordPlay };
  const events: Event[] = [
    ...results.map((result) => ({
      at: fmtTimestamp(result.closedAt),
      kind: 0 as const,
      result,
    })),
    ...plays.map((play) => ({
      at: fmtTimestamp(play.playedAt),
      kind: 1 as const,
      play,
    })),
  ];
  events.sort((a, b) => a.at - b.at || a.kind - b.kind);

  for (const e of events) {
    if (e.kind === 0) {
      const winner = e.result.winnerBotId;
      if (winner === undefined || winner === null) continue;
      const { known } = rackOf(winner);
      known.set(e.result.letter, (known.get(e.result.letter) ?? 0) + 1);
    } else {
      const rack = rackOf(e.play.botId);
      for (const c of e.play.word) {
        const have = rack.known.get(c) ?? 0;
        if (have > 0) rack.known.set(c, have - 1);
        else rack.hidden = Math.max(0, rack.hidden - 1);
      }
    }
  }
  return racks;
}

export function rackTiles(
  racks: Map<bigint, PublicRack>,
  botId: bigint,
  startingRackSize: number,
): { letters: string[]; hidden: number } {
  const rack = racks.get(botId);
  if (!rack) return { letters: [], hidden: startingRackSize };
  const letters: string[] = [];
  for (const [letter, count] of rack.known.entries()) {
    for (let i = 0; i < count; i++) letters.push(letter);
  }
  letters.sort();
  return { letters, hidden: rack.hidden };
}

// Milliseconds from `now` until `ts`, never negative.
export function msUntil(
  ts: { __timestamp_micros_since_unix_epoch__: bigint },
  now: number,
): number {
  return Math.max(0, fmtTimestamp(ts) - now);
}

export function fmtDateTime(ts: {
  __timestamp_micros_since_unix_epoch__: bigint;
}): string {
  return new Date(fmtTimestamp(ts)).toLocaleString();
}

// "just now", "4 min ago", "3 h ago", "2 days ago".
export function fmtAgo(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  return `${d} ${d === 1 ? "day" : "days"} ago`;
}

export const plural = (n: number, one: string, many: string) =>
  n === 1 ? one : many;

// Standard competition ranking over a list sorted best-first: equal values
// share a rank, and the next rank skips past them (1, 2, 2, 4).
export function competitionRank<T, V>(
  sorted: T[],
  value: (t: T) => V,
): (t: T) => number {
  return (t) => sorted.findIndex((x) => value(x) === value(t)) + 1;
}

// Who won a match, given its standings sorted by score. Everyone level on
// the top score shares the win; `runnerUp` is the best of the rest.
export function matchOutcome(standings: MatchParticipant[]) {
  const top = standings[0]?.score ?? 0n;
  return {
    top,
    winners: standings.filter((p) => p.score === top),
    runnerUp: standings.find((p) => p.score < top),
  };
}

// Mirrors `letterValue` in spacetimedb/src/letters.ts.
const LETTER_VALUES: Record<string, number> = {
  ...Object.fromEntries([..."AEIOULNSTR"].map((c) => [c, 1])),
  ...Object.fromEntries([..."DG"].map((c) => [c, 2])),
  ...Object.fromEntries([..."BCMP"].map((c) => [c, 3])),
  ...Object.fromEntries([..."FHVWY"].map((c) => [c, 4])),
  K: 5,
  J: 8,
  X: 8,
  Q: 10,
  Z: 10,
};

export function letterValue(c: string): number {
  return LETTER_VALUES[c.toUpperCase()] ?? 0;
}

// Tile count of `DEFAULT_BAG` in spacetimedb/src/letters.rs.
export const BAG_SIZE = 98;
