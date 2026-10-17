// Queries over the client cache that more than one page needs.
import type { Identity } from "spacetimedb";
import type { DbConnection } from "./module_bindings";
import type {
  Auction,
  AuctionResult,
  MatchParticipant,
  WordPlay,
} from "./module_bindings/types";

export type BotNames = (botId: bigint | null | undefined) => string;

// Look up bots by id, falling back to the id for a bot we haven't seen.
export function botNames(conn: DbConnection | null): BotNames {
  const names = new Map<bigint, string>();
  if (conn) for (const b of conn.db.bot.iter()) names.set(b.id, b.name);
  return (botId) =>
    botId === null || botId === undefined
      ? "—"
      : (names.get(botId) ?? `#${botId}`);
}

// Every match's participants, highest score first.
export function standingsByMatch(
  conn: DbConnection | null,
): Map<bigint, MatchParticipant[]> {
  const byMatch = new Map<bigint, MatchParticipant[]>();
  if (!conn) return byMatch;
  for (const p of conn.db.matchParticipant.iter()) {
    const list = byMatch.get(p.matchId) ?? [];
    list.push(p);
    byMatch.set(p.matchId, list);
  }
  for (const list of byMatch.values()) {
    list.sort((a, b) => Number(b.score - a.score));
  }
  return byMatch;
}

// One match's tile sales and word plays, each in the order they happened.
export function matchHistory(
  conn: DbConnection,
  matchId: bigint,
): { results: AuctionResult[]; plays: WordPlay[] } {
  const results = [...conn.db.auctionResult.iter()].filter(
    (r) => r.matchId === matchId,
  );
  results.sort((a, b) => Number(a.auctionId - b.auctionId));
  const plays = [...conn.db.wordPlay.iter()].filter(
    (p) => p.matchId === matchId,
  );
  plays.sort((a, b) => Number(a.id - b.id));
  return { results, plays };
}

// The auction currently taking bids in each match.
export function openAuctions(conn: DbConnection | null): Map<bigint, Auction> {
  const byMatch = new Map<bigint, Auction>();
  if (!conn) return byMatch;
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") byMatch.set(a.matchId, a);
  }
  return byMatch;
}

// The spacetimedb.com identity this browser is linked to, if any.
export function humanLinkOf(
  conn: DbConnection | null,
  identity: Identity | null,
) {
  return conn && identity
    ? (conn.db.humanLink.web_identity.find(identity) ?? null)
    : null;
}

export function myTeam(conn: DbConnection | null) {
  return conn?.db.myTeam.iter().next().value ?? null;
}

export function amAdmin(conn: DbConnection | null): boolean {
  return !!conn?.db.myAdmin.iter().next().value;
}
