import type { DbConnection } from "./module_bindings";
import type {
  AuctionResult,
  Bot,
  MatchParticipant,
  WordPlay,
} from "./module_bindings/types";

export function fmtTimestamp(ts: {
  __timestamp_micros_since_unix_epoch__: bigint;
}): number {
  return Number(ts.__timestamp_micros_since_unix_epoch__) / 1000;
}

// Mirrors STARTING_RACK_SIZE in spacetimedb/src/lib.rs: every participant is
// dealt this many tiles at match start, into the private `holding` table.
export const STARTING_RACK_SIZE = 5;

// What the public can know about one bot's rack: the letters it won at
// auction and hasn't yet played, plus a count of tiles still face-down.
export type PublicRack = { known: Map<string, number>; hidden: number };

// Reconstruct each bot's rack in a match from public AuctionResult + WordPlay
// events. Keyed by bot_id (as string for Map convenience).
//
// The starting tiles are dealt privately, so a played word may use letters
// the public never saw arrive. Each played letter is taken from the known
// letters if possible, otherwise from the face-down tiles. That keeps every
// known letter genuinely on the rack, and the total tile count exact, even
// when we can't tell which of two identical letters was used.
export function reconstructRacks(
  results: AuctionResult[],
  plays: WordPlay[],
): Map<string, PublicRack> {
  const racks = new Map<string, PublicRack>();
  const rackOf = (botId: bigint) => {
    const key = String(botId);
    let rack = racks.get(key);
    if (!rack) {
      rack = { known: new Map(), hidden: STARTING_RACK_SIZE };
      racks.set(key, rack);
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
  racks: Map<string, PublicRack>,
  botId: bigint,
): { letters: string[]; hidden: number } {
  const rack = racks.get(String(botId));
  if (!rack) return { letters: [], hidden: STARTING_RACK_SIZE };
  const letters: string[] = [];
  for (const [letter, count] of rack.known.entries()) {
    for (let i = 0; i < count; i++) letters.push(letter);
  }
  letters.sort();
  return { letters, hidden: rack.hidden };
}

export function botName(bots: Bot[], botId: bigint | null | undefined): string {
  if (botId === null || botId === undefined) return "—";
  const b = bots.find((x) => x.id === botId);
  return b?.name ?? `#${botId}`;
}

export function readAllBots(conn: DbConnection): Bot[] {
  const out: Bot[] = [];
  for (const b of conn.db.bot.iter()) out.push(b);
  return out;
}

export function readParticipantsForMatch(
  conn: DbConnection,
  matchId: bigint,
): MatchParticipant[] {
  const out: MatchParticipant[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId === matchId) out.push(p);
  }
  out.sort((a, b) => Number(b.score - a.score));
  return out;
}

export function isBotCredentialConnected(
  conn: DbConnection,
  botId: bigint,
): boolean {
  for (const c of conn.db.botCredential.iter()) {
    if (c.botId === botId && c.connected) return true;
  }
  return false;
}

// Mirrors `letter_value` in spacetimedb/src/letters.rs.
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
