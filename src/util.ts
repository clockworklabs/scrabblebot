import type { Identity } from "spacetimedb";
import type { DbConnection } from "./module_bindings";
import type { AuctionResult, Bot, MatchParticipant, WordPlay } from "./module_bindings/types";

export function fmtTimestamp(ts: { __timestamp_micros_since_unix_epoch__: bigint }): number {
  return Number(ts.__timestamp_micros_since_unix_epoch__) / 1000;
}

// Reconstruct each bot's rack in a match from public AuctionResult + WordPlay events.
export function reconstructRacks(
  results: AuctionResult[],
  plays: WordPlay[],
): Map<string, Map<string, number>> {
  const racks = new Map<string, Map<string, number>>();
  for (const r of results) {
    if (!r.winner) continue;
    const key = r.winner.toHexString();
    const rack = racks.get(key) ?? new Map<string, number>();
    rack.set(r.letter, (rack.get(r.letter) ?? 0) + 1);
    racks.set(key, rack);
  }
  for (const p of plays) {
    const key = p.bot.toHexString();
    const rack = racks.get(key) ?? new Map<string, number>();
    for (const c of p.word) {
      rack.set(c, (rack.get(c) ?? 0) - 1);
    }
    racks.set(key, rack);
  }
  return racks;
}

export function rackTiles(racks: Map<string, Map<string, number>>, bot: Identity): string[] {
  const rack = racks.get(bot.toHexString());
  if (!rack) return [];
  const tiles: string[] = [];
  for (const [letter, count] of rack.entries()) {
    if (count <= 0) continue;
    for (let i = 0; i < count; i++) tiles.push(letter);
  }
  tiles.sort();
  return tiles;
}

export function botName(bots: Bot[], identity: Identity | null | undefined): string {
  if (!identity) return "—";
  const b = bots.find((x) => x.identity.isEqual(identity));
  return b?.name ?? identity.toHexString().slice(0, 8);
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
  for (const p of conn.db.match_participant.iter()) {
    if (p.matchId === matchId) out.push(p);
  }
  out.sort((a, b) => Number(b.score - a.score));
  return out;
}
