import {
  botInRunningMatch,
  findParticipant,
  isErr,
  shuffle,
  sortDescending,
  startMatchWith,
} from "./game";
import type { Ctx, Result } from "./game";
import { SenderError } from "spacetimedb/server";
import type {
  Bot,
  Tournament,
  TournamentEntry,
  TournamentPhase,
} from "./schema";

// A tournament still to finish: taking registrations or under way. Only one
// may exist at a time.
export function isActive(t: Tournament): boolean {
  switch (t.status.tag) {
    case "Registration":
    case "Swiss":
    case "Bracket":
    case "Final":
      return true;
    default:
      return false;
  }
}

// A tournament that has started and not yet finished.
export function isUnderway(t: Tournament): boolean {
  return isActive(t) && t.status.tag !== "Registration";
}

// Whether a bot must stay out of casual matches: it's still in contention
// in a tournament that's under way, so it has to be free whenever its next
// tournament match starts. Sim bots are exempt; the module plays them, and
// they can play any number of matches at once.
export function heldForTournament(ctx: Ctx, botId: bigint): boolean {
  const bot = ctx.db.bot.id.find(botId);
  if (!bot || bot.isSimulated) {
    return false;
  }
  for (const e of ctx.db.tournamentEntry.teByBot.filter(botId)) {
    const t = ctx.db.tournament.id.find(e.tournamentId);
    if (t && isUnderway(t) && !e.eliminated) {
      return true;
    }
  }
  return false;
}

// Deletes the entries of bots deleted since they registered (their team
// dissolved), which can't play, and returns the rest.
export function dropEntriesWithoutBots(
  ctx: Ctx,
  tournamentId: bigint,
): TournamentEntry[] {
  const entries = [];
  for (const e of [
    ...ctx.db.tournamentEntry.teByTournament.filter(tournamentId),
  ]) {
    if (ctx.db.bot.id.find(e.botId)) {
      entries.push(e);
    } else {
      ctx.db.tournamentEntry.id.delete(e.id);
    }
  }
  return entries;
}

// Real entrants in a running match. Sim bots are driven by the module and
// can play any number of matches at once.
export function entrantsStillPlaying(ctx: Ctx, tournamentId: bigint): Bot[] {
  const busy = [];
  for (const e of ctx.db.tournamentEntry.teByTournament.filter(tournamentId)) {
    const bot = ctx.db.bot.id.find(e.botId);
    if (bot && !bot.isSimulated && botInRunningMatch(ctx, bot.id)) {
      busy.push(bot);
    }
  }
  return busy;
}

// After any match ends: start round 1 of a tournament that started while
// some of its entrants were in casual matches, once none are.
export function startRoundOneWhenFree(ctx: Ctx) {
  for (const t of [...ctx.db.tournament.iter()]) {
    if (t.status.tag !== "Swiss" || t.currentRound !== 0) {
      continue;
    }
    if (entrantsStillPlaying(ctx, t.id).length > 0) {
      continue;
    }
    dropEntriesWithoutBots(ctx, t.id);
    const started = startSwissRound(ctx, t.id, 1);
    if (isErr(started)) {
      console.error(
        `Tournament ${t.id} couldn't start round 1: ${started.err}`,
      );
    } else {
      console.info(`Tournament ${t.id}: round 1 started`);
    }
  }
}

export function requireRegistration(ctx: Ctx, tournamentId: bigint) {
  const t = ctx.db.tournament.id.find(tournamentId);
  if (!t) {
    throw new SenderError("Unknown tournament");
  }
  if (t.status.tag !== "Registration") {
    throw new SenderError("Tournament is not taking registrations");
  }
}

export function addEntry(ctx: Ctx, tournamentId: bigint, botId: bigint) {
  ctx.db.tournamentEntry.insert({
    id: 0n,
    tournamentId,
    botId,
    swissPoints: 0,
    eliminated: false,
    totalScore: 0n,
    finalFinishPosition: undefined,
  });
}

// How many games the final lasts. The finalists' scores over all of them
// decide the champion.
export const FINAL_GAMES = 3;

function compareBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Standings order: Swiss points, then total score, then the lower bot id,
// so nobody's place depends on the order rows happen to be stored in.
export function byStanding(a: TournamentEntry, b: TournamentEntry): number {
  return (
    b.swissPoints - a.swissPoints ||
    compareBigint(b.totalScore, a.totalScore) ||
    compareBigint(a.botId, b.botId)
  );
}

export function startSwissRound(
  ctx: Ctx,
  tournamentId: bigint,
  round: number,
): Result<void> {
  const t = ctx.db.tournament.id.find(tournamentId);
  if (!t) {
    return { err: "Unknown tournament" };
  }
  ctx.db.tournament.id.update({ ...t, currentRound: round });
  const entries = [
    ...ctx.db.tournamentEntry.teByTournament.filter(tournamentId),
  ].filter((e) => !e.eliminated);
  if (round === 1) {
    shuffle(ctx, entries);
  } else {
    entries.sort(byStanding);
  }
  return pairIntoMatches(ctx, t, entries, round, { tag: "Swiss" });
}

function pairIntoMatches(
  ctx: Ctx,
  t: Tournament,
  entries: TournamentEntry[],
  round: number,
  phase: TournamentPhase,
): Result<void> {
  let rest = entries;
  for (const size of tableSizes(entries.length, t.matchSize)) {
    const seated = rest.slice(0, size);
    rest = rest.slice(size);
    const roster = seated.map((e) => e.botId);
    const started = startMatchWith(ctx, t.auctionType, roster);
    if (isErr(started)) {
      return started;
    }
    ctx.db.tournamentMatch.insert({
      id: 0n,
      tournamentId: t.id,
      matchId: started.ok,
      round,
      phase,
    });
  }
  return { ok: undefined };
}

// Seat `n` entrants at tables of about `matchSize`, leaving nobody out:
// floor(n / matchSize) tables, with the leftovers spread one per table
// from the top, so sizes differ by at most one (7 at size 3 → [4, 3]).
export function tableSizes(n: number, matchSize: number): number[] {
  if (n < 2 || matchSize === 0) {
    return [];
  }
  const tables = Math.max(Math.floor(n / matchSize), 1);
  const base = Math.floor(n / tables);
  const extra = n % tables;
  return Array.from({ length: tables }, (_, i) => base + (i < extra ? 1 : 0));
}

export function entryFor(
  ctx: Ctx,
  tournamentId: bigint,
  botId: bigint,
): TournamentEntry | undefined {
  return [...ctx.db.tournamentEntry.teByTournament.filter(tournamentId)].find(
    (e) => e.botId === botId,
  );
}

function matchEnded(ctx: Ctx, matchId: bigint): boolean {
  return ctx.db.matchState.id.find(matchId)?.status.tag === "Ended";
}

function aliveEntries(ctx: Ctx, tournamentId: bigint): TournamentEntry[] {
  return [...ctx.db.tournamentEntry.teByTournament.filter(tournamentId)].filter(
    (e) => !e.eliminated,
  );
}

function finalGames(ctx: Ctx, tournamentId: bigint) {
  return [...ctx.db.tournamentMatch.tmByTournament.filter(tournamentId)].filter(
    (m) => m.phase.tag === "Final",
  );
}

// Whether one of the tournament's matches is being played.
export function tournamentMatchRunning(
  ctx: Ctx,
  tournamentId: bigint,
): boolean {
  return [...ctx.db.tournamentMatch.tmByTournament.filter(tournamentId)].some(
    (m) => ctx.db.matchState.id.find(m.matchId)?.status.tag === "Running",
  );
}

// ---------- The finals ----------
// After the cut the tournament waits for the admin, who starts each
// elimination match and each game of the final with
// `startNextFinalsMatch`, so the finals can be run from a stage.

export function startFinalsMatch(ctx: Ctx, t: Tournament): Result<void> {
  if (t.status.tag !== "Bracket" && t.status.tag !== "Final") {
    return { err: "The tournament isn't in its finals" };
  }
  if (tournamentMatchRunning(ctx, t.id)) {
    return { err: "A finals match is already being played" };
  }
  const roster = aliveEntries(ctx, t.id).map((e) => e.botId);
  let round: number;
  if (t.status.tag === "Bracket") {
    round = t.currentRound + 1;
    ctx.db.tournament.id.update({ ...t, currentRound: round });
  } else {
    round = finalGames(ctx, t.id).length + 1;
  }
  const started = startMatchWith(ctx, t.auctionType, roster);
  if (isErr(started)) {
    return started;
  }
  ctx.db.tournamentMatch.insert({
    id: 0n,
    tournamentId: t.id,
    matchId: started.ok,
    round,
    phase: { tag: t.status.tag },
  });
  console.info(
    `Tournament ${t.id}: ${t.status.tag} match ${round} started (match ${started.ok})`,
  );
  return { ok: undefined };
}

// The Swiss rounds are over: keep the top `topCut` and wait for the admin
// to start the finals.
function cut(ctx: Ctx, t: Tournament) {
  const ranked = aliveEntries(ctx, t.id).sort(byStanding);
  ranked.forEach((e, i) => {
    if (i >= t.topCut) {
      ctx.db.tournamentEntry.id.update({ ...e, eliminated: true });
    }
  });
  const kept = Math.min(ranked.length, t.topCut);
  ctx.db.tournament.id.update({
    ...t,
    status: { tag: kept > 2 ? "Bracket" : "Final" },
    currentRound: 0,
  });
  console.info(`Tournament ${t.id}: Swiss done, ${kept} go through`);
}

// Knock out the last-place finisher of an elimination match. A tie for
// last goes to total score, then the higher bot id, so there's always
// exactly one, with no replays.
function knockOutLast(
  ctx: Ctx,
  t: Tournament,
  placed: { botId: bigint; score: bigint }[],
) {
  const alive = aliveEntries(ctx, t.id);
  const inMatch = alive.filter((e) => placed.some((p) => p.botId === e.botId));
  const scoreOf = (e: TournamentEntry) =>
    placed.find((p) => p.botId === e.botId)!.score;
  const worst = inMatch.sort(
    (a, b) =>
      compareBigint(scoreOf(a), scoreOf(b)) ||
      compareBigint(a.totalScore, b.totalScore) ||
      compareBigint(b.botId, a.botId),
  )[0];
  if (!worst) {
    return;
  }
  ctx.db.tournamentEntry.id.update({
    ...worst,
    eliminated: true,
    finalFinishPosition: alive.length,
  });
  if (alive.length - 1 <= 2) {
    ctx.db.tournament.id.update({
      ...t,
      status: { tag: "Final" },
      currentRound: 0,
    });
  }
  console.info(
    `Tournament ${t.id}: bot ${worst.botId} out in place ${alive.length}`,
  );
}

// After the last game of the final, rank the finalists by their score over
// the final's games, then total score, then the lower bot id.
function crown(ctx: Ctx, t: Tournament) {
  const games = finalGames(ctx, t.id).map((m) => m.matchId);
  const finalScore = (botId: bigint) =>
    games.reduce(
      (sum, matchId) =>
        sum + (findParticipant(ctx, matchId, botId)?.score ?? 0n),
      0n,
    );
  const ranked = aliveEntries(ctx, t.id)
    .map((e) => ({ entry: e, score: finalScore(e.botId) }))
    .sort(
      (a, b) =>
        compareBigint(b.score, a.score) ||
        compareBigint(b.entry.totalScore, a.entry.totalScore) ||
        compareBigint(a.entry.botId, b.entry.botId),
    );
  ranked.forEach(({ entry }, i) => {
    ctx.db.tournamentEntry.id.update({
      ...entry,
      eliminated: i > 0,
      finalFinishPosition: i + 1,
    });
  });
  const champion = ranked[0]?.entry.botId;
  ctx.db.tournament.id.update({
    ...t,
    status: { tag: "Ended" },
    endedAt: ctx.timestamp,
    winnerBotId: champion,
  });
  console.info(`Tournament ${t.id} won by bot ${champion}`);
}

// ---------- Match results ----------

// Swiss points by finishing place, scored against the configured match
// size so first place is worth the same at every table; places past
// matchSize at an oversized table earn nothing. Bots on the same score
// share the higher place, as tied leaders all get a win.
function awardSwissPoints(
  ctx: Ctx,
  t: Tournament,
  placed: { botId: bigint; score: bigint }[],
) {
  for (const p of placed) {
    const place = placed.filter((q) => q.score > p.score).length;
    const e = entryFor(ctx, t.id, p.botId);
    if (e) {
      ctx.db.tournamentEntry.id.update({
        ...e,
        swissPoints: e.swissPoints + Math.max(t.matchSize - place, 0),
      });
    }
  }
}

// The tournament's part in a match ending: score it, and move the
// tournament on.
export function onTournamentMatchEnded(ctx: Ctx, matchId: bigint) {
  let tm;
  for (const row of ctx.db.tournamentMatch.tmByMatch.filter(matchId)) {
    tm = row;
    break;
  }
  if (!tm) {
    return;
  }
  const t = ctx.db.tournament.id.find(tm.tournamentId);
  // A tournament that has finished doesn't move on.
  if (!t || !isUnderway(t)) {
    return;
  }

  const placed = sortDescending(
    [...ctx.db.matchParticipant.mpByMatch.filter(matchId)],
    (p) => p.score,
  );
  for (const p of placed) {
    const e = entryFor(ctx, t.id, p.botId);
    if (e) {
      ctx.db.tournamentEntry.id.update({
        ...e,
        totalScore: e.totalScore + p.score,
      });
    }
  }

  switch (tm.phase.tag) {
    case "Swiss": {
      awardSwissPoints(ctx, t, placed);
      const roundDone = [...ctx.db.tournamentMatch.tmByTournament.filter(t.id)]
        .filter((m) => m.round === tm.round && m.phase.tag === "Swiss")
        .every((m) => matchEnded(ctx, m.matchId));
      if (!roundDone) {
        return;
      }
      if (t.currentRound < t.swissRoundsTotal) {
        startSwissRound(ctx, t.id, t.currentRound + 1);
      } else {
        cut(ctx, t);
      }
      break;
    }
    case "Bracket":
      knockOutLast(ctx, t, placed);
      break;
    case "Final":
      if (finalGames(ctx, t.id).every((m) => matchEnded(ctx, m.matchId))) {
        if (finalGames(ctx, t.id).length >= FINAL_GAMES) {
          crown(ctx, t);
        }
      }
      break;
  }
}
