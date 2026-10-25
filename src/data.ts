// Queries over the client cache that more than one page needs.
import type { Identity } from "spacetimedb";
import { useSubscription } from "./connection";
import { tables, type DbConnection } from "./module_bindings";
import type {
  Auction,
  AuctionResult,
  BotStats,
  MatchParticipant,
  TournamentEntry,
  WordPlay,
} from "./module_bindings/types";
import { fmtTimestamp } from "./util";

export type BotNames = (botId: bigint | null | undefined) => string;

// Every rated bot's current stats. Stats outlive a bot whose team was
// dissolved, so those are left out.
export function liveBotStats(conn: DbConnection | null): BotStats[] {
  if (!conn) return [];
  return [...conn.db.botStats.iter()].filter(
    (s) => conn.db.bot.id.find(s.botId) != null,
  );
}

// Which version of a bot is current, and which version played a match.
// Version 1 runs from the bot's creation; `botVersion` says when each later
// one started.
export type BotVersions = {
  current: (botId: bigint) => number;
  // The version that a match created at `at` (ms since the epoch) counts
  // for, as the module decides it.
  at: (botId: bigint, at: number) => number;
};

export function botVersions(conn: DbConnection | null): BotVersions {
  const starts = new Map<bigint, { version: number; at: number }[]>();
  if (conn) {
    for (const v of conn.db.botVersion.iter()) {
      const list = starts.get(v.botId) ?? [];
      list.push({ version: v.version, at: fmtTimestamp(v.startedAt) });
      starts.set(v.botId, list);
    }
  }
  const at = (botId: bigint, until: number) =>
    (starts.get(botId) ?? []).reduce(
      (version, s) => (s.at <= until ? Math.max(version, s.version) : version),
      1,
    );
  return { current: (botId) => at(botId, Infinity), at };
}

// Look up bots by id, falling back to the id for a bot we haven't seen.
export function botNames(conn: DbConnection | null): BotNames {
  const names = new Map<bigint, string>();
  if (conn) for (const b of conn.db.bot.iter()) names.set(b.id, b.name);
  return (botId) =>
    botId === null || botId === undefined
      ? "—"
      : (names.get(botId) ?? `#${botId}`);
}

// Subscribes to the rows the page shows for each of `matchIds`: the
// scoreboard, then the words played, then the tile sales and winning bids
// that the live card and match page replay. Every match ever played stays in
// these tables, so the site never subscribes to them whole.
export function useMatchRows(
  matchIds: bigint[],
  rows: "scores" | "words" | "history",
) {
  useSubscription(
    matchIds.flatMap((id) => [
      tables.matchParticipant.where((r) => r.matchId.eq(id)),
      ...(rows === "scores"
        ? []
        : [tables.wordPlay.where((r) => r.matchId.eq(id))]),
      ...(rows === "history"
        ? [
            tables.auction.where((r) => r.matchId.eq(id)),
            tables.auctionResult.where((r) => r.matchId.eq(id)),
            tables.auctionTopBidArchive.where((r) => r.matchId.eq(id)),
          ]
        : []),
    ]),
  );
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

// The highest-scoring word played in each match. On a tie, the first one
// played gets the credit.
export function bestWords(conn: DbConnection | null): Map<bigint, WordPlay> {
  const best = new Map<bigint, WordPlay>();
  if (!conn) return best;
  for (const p of conn.db.wordPlay.iter()) {
    const prev = best.get(p.matchId);
    if (!prev || betterPlay(p, prev)) best.set(p.matchId, p);
  }
  return best;
}

export const betterPlay = (a: WordPlay, b: WordPlay) =>
  a.totalReward > b.totalReward ||
  (a.totalReward === b.totalReward && a.id < b.id);

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
    ? (conn.db.humanLink.webIdentity.find(identity) ?? null)
    : null;
}

export function myTeam(conn: DbConnection | null) {
  return conn?.db.myTeam.iter().next().value ?? null;
}

export function amAdmin(conn: DbConnection | null): boolean {
  return !!conn?.db.myAdmin.iter().next().value;
}

// The newest tournament, which is the one the pages show.
export function latestTournament(conn: DbConnection | null) {
  if (!conn) return null;
  let latest = null;
  for (const t of conn.db.tournament.iter()) {
    if (!latest || t.id > latest.id) latest = t;
  }
  return latest;
}

export function tournamentEntries(
  conn: DbConnection,
  tournamentId: bigint,
): TournamentEntry[] {
  return [...conn.db.tournamentEntry.iter()].filter(
    (e) => e.tournamentId === tournamentId,
  );
}

// Whether any of the bot's credentials is connected right now.
export function botConnected(conn: DbConnection, botId: bigint): boolean {
  for (const c of conn.db.botCredential.iter()) {
    if (c.botId === botId && c.connected) return true;
  }
  return false;
}

// Whether one of the tournament's matches is being played.
export function tournamentMatchRunning(
  conn: DbConnection,
  tournamentId: bigint,
): boolean {
  for (const tm of conn.db.tournamentMatch.iter()) {
    if (
      tm.tournamentId === tournamentId &&
      conn.db.matchState.id.find(tm.matchId)?.status.tag === "Running"
    ) {
      return true;
    }
  }
  return false;
}
