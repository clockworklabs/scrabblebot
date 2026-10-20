import {
  findParticipant,
  isErr,
  shuffle,
  sortDescending,
  startMatchWith,
} from "./game";
import type { Ctx, Result } from "./game";
import { SenderError } from "spacetimedb/server";
import type { Tournament, TournamentEntry, TournamentPhase } from "./schema";

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
export function heldForTournament(ctx: Ctx, bot_id: bigint): boolean {
  const bot = ctx.db.bot.id.find(bot_id);
  if (!bot || bot.is_simulated) {
    return false;
  }
  for (const e of ctx.db.tournament_entry.te_by_bot.filter(bot_id)) {
    const t = ctx.db.tournament.id.find(e.tournament_id);
    if (t && isUnderway(t) && !e.eliminated) {
      return true;
    }
  }
  return false;
}

export function requireRegistration(ctx: Ctx, tournament_id: bigint) {
  const t = ctx.db.tournament.id.find(tournament_id);
  if (!t) {
    throw new SenderError("Unknown tournament");
  }
  if (t.status.tag !== "Registration") {
    throw new SenderError("Tournament is not taking registrations");
  }
}

export function addEntry(ctx: Ctx, tournament_id: bigint, bot_id: bigint) {
  ctx.db.tournament_entry.insert({
    id: 0n,
    tournament_id,
    bot_id,
    swiss_points: 0,
    eliminated: false,
    total_score: 0n,
    final_finish_position: undefined,
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
    b.swiss_points - a.swiss_points ||
    compareBigint(b.total_score, a.total_score) ||
    compareBigint(a.bot_id, b.bot_id)
  );
}

export function startSwissRound(
  ctx: Ctx,
  tournament_id: bigint,
  round: number,
): Result<void> {
  const t = ctx.db.tournament.id.find(tournament_id);
  if (!t) {
    return { err: "Unknown tournament" };
  }
  ctx.db.tournament.id.update({ ...t, current_round: round });
  const entries = [
    ...ctx.db.tournament_entry.te_by_tournament.filter(tournament_id),
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
  for (const size of tableSizes(entries.length, t.match_size)) {
    const seated = rest.slice(0, size);
    rest = rest.slice(size);
    const roster = seated.map((e) => e.bot_id);
    const started = startMatchWith(ctx, t.auction_type, roster);
    if (isErr(started)) {
      return started;
    }
    ctx.db.tournament_match.insert({
      id: 0n,
      tournament_id: t.id,
      match_id: started.ok,
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
  tournament_id: bigint,
  bot_id: bigint,
): TournamentEntry | undefined {
  return [
    ...ctx.db.tournament_entry.te_by_tournament.filter(tournament_id),
  ].find((e) => e.bot_id === bot_id);
}

function matchEnded(ctx: Ctx, match_id: bigint): boolean {
  return ctx.db.match_state.id.find(match_id)?.status.tag === "Ended";
}

function aliveEntries(ctx: Ctx, tournament_id: bigint): TournamentEntry[] {
  return [
    ...ctx.db.tournament_entry.te_by_tournament.filter(tournament_id),
  ].filter((e) => !e.eliminated);
}

function finalGames(ctx: Ctx, tournament_id: bigint) {
  return [
    ...ctx.db.tournament_match.tm_by_tournament.filter(tournament_id),
  ].filter((m) => m.phase.tag === "Final");
}

// Whether one of the tournament's matches is being played.
export function tournamentMatchRunning(
  ctx: Ctx,
  tournament_id: bigint,
): boolean {
  return [
    ...ctx.db.tournament_match.tm_by_tournament.filter(tournament_id),
  ].some(
    (m) => ctx.db.match_state.id.find(m.match_id)?.status.tag === "Running",
  );
}

// ---------- The finals ----------
// After the cut the tournament waits for the admin, who starts each
// elimination match and each game of the final with
// `start_next_finals_match`, so the finals can be run from a stage.

export function startNextFinalsMatch(ctx: Ctx, t: Tournament): Result<void> {
  if (t.status.tag !== "Bracket" && t.status.tag !== "Final") {
    return { err: "The tournament isn't in its finals" };
  }
  if (tournamentMatchRunning(ctx, t.id)) {
    return { err: "A finals match is already being played" };
  }
  const roster = aliveEntries(ctx, t.id).map((e) => e.bot_id);
  let round: number;
  if (t.status.tag === "Bracket") {
    round = t.current_round + 1;
    ctx.db.tournament.id.update({ ...t, current_round: round });
  } else {
    round = finalGames(ctx, t.id).length + 1;
  }
  const started = startMatchWith(ctx, t.auction_type, roster);
  if (isErr(started)) {
    return started;
  }
  ctx.db.tournament_match.insert({
    id: 0n,
    tournament_id: t.id,
    match_id: started.ok,
    round,
    phase: { tag: t.status.tag },
  });
  console.info(
    `Tournament ${t.id}: ${t.status.tag} match ${round} started (match ${started.ok})`,
  );
  return { ok: undefined };
}

// The Swiss rounds are over: keep the top `top_cut` and wait for the admin
// to start the finals.
function cut(ctx: Ctx, t: Tournament) {
  const ranked = aliveEntries(ctx, t.id).sort(byStanding);
  ranked.forEach((e, i) => {
    if (i >= t.top_cut) {
      ctx.db.tournament_entry.id.update({ ...e, eliminated: true });
    }
  });
  const kept = Math.min(ranked.length, t.top_cut);
  ctx.db.tournament.id.update({
    ...t,
    status: { tag: kept > 2 ? "Bracket" : "Final" },
    current_round: 0,
  });
  console.info(`Tournament ${t.id}: Swiss done, ${kept} go through`);
}

// Knock out the last-place finisher of an elimination match. A tie for
// last goes to total score, then the higher bot id, so there's always
// exactly one, with no replays.
function knockOutLast(
  ctx: Ctx,
  t: Tournament,
  placed: { bot_id: bigint; score: bigint }[],
) {
  const alive = aliveEntries(ctx, t.id);
  const inMatch = alive.filter((e) =>
    placed.some((p) => p.bot_id === e.bot_id),
  );
  const scoreOf = (e: TournamentEntry) =>
    placed.find((p) => p.bot_id === e.bot_id)!.score;
  const worst = inMatch.sort(
    (a, b) =>
      compareBigint(scoreOf(a), scoreOf(b)) ||
      compareBigint(a.total_score, b.total_score) ||
      compareBigint(b.bot_id, a.bot_id),
  )[0];
  if (!worst) {
    return;
  }
  ctx.db.tournament_entry.id.update({
    ...worst,
    eliminated: true,
    final_finish_position: alive.length,
  });
  if (alive.length - 1 <= 2) {
    ctx.db.tournament.id.update({
      ...t,
      status: { tag: "Final" },
      current_round: 0,
    });
  }
  console.info(
    `Tournament ${t.id}: bot ${worst.bot_id} out in place ${alive.length}`,
  );
}

// After the last game of the final, rank the finalists by their score over
// the final's games, then total score, then the lower bot id.
function crown(ctx: Ctx, t: Tournament) {
  const games = finalGames(ctx, t.id).map((m) => m.match_id);
  const finalScore = (bot_id: bigint) =>
    games.reduce(
      (sum, match_id) =>
        sum + (findParticipant(ctx, match_id, bot_id)?.score ?? 0n),
      0n,
    );
  const ranked = aliveEntries(ctx, t.id)
    .map((e) => ({ entry: e, score: finalScore(e.bot_id) }))
    .sort(
      (a, b) =>
        compareBigint(b.score, a.score) ||
        compareBigint(b.entry.total_score, a.entry.total_score) ||
        compareBigint(a.entry.bot_id, b.entry.bot_id),
    );
  ranked.forEach(({ entry }, i) => {
    ctx.db.tournament_entry.id.update({
      ...entry,
      eliminated: i > 0,
      final_finish_position: i + 1,
    });
  });
  const champion = ranked[0]?.entry.bot_id;
  ctx.db.tournament.id.update({
    ...t,
    status: { tag: "Ended" },
    ended_at: ctx.timestamp,
    winner_bot_id: champion,
  });
  console.info(`Tournament ${t.id} won by bot ${champion}`);
}

// ---------- Match results ----------

// Swiss points by finishing place, scored against the configured match
// size so first place is worth the same at every table; places past
// match_size at an oversized table earn nothing. Bots on the same score
// share the higher place, as tied leaders all get a win.
function awardSwissPoints(
  ctx: Ctx,
  t: Tournament,
  placed: { bot_id: bigint; score: bigint }[],
) {
  for (const p of placed) {
    const place = placed.filter((q) => q.score > p.score).length;
    const e = entryFor(ctx, t.id, p.bot_id);
    if (e) {
      ctx.db.tournament_entry.id.update({
        ...e,
        swiss_points: e.swiss_points + Math.max(t.match_size - place, 0),
      });
    }
  }
}

// The tournament's part in a match ending: score it, and move the
// tournament on.
export function onTournamentMatchEnded(ctx: Ctx, match_id: bigint) {
  let tm;
  for (const row of ctx.db.tournament_match.tm_by_match.filter(match_id)) {
    tm = row;
    break;
  }
  if (!tm) {
    return;
  }
  const t = ctx.db.tournament.id.find(tm.tournament_id);
  // A tournament that has finished doesn't move on.
  if (!t || !isUnderway(t)) {
    return;
  }

  const placed = sortDescending(
    [...ctx.db.match_participant.mp_by_match.filter(match_id)],
    (p) => p.score,
  );
  for (const p of placed) {
    const e = entryFor(ctx, t.id, p.bot_id);
    if (e) {
      ctx.db.tournament_entry.id.update({
        ...e,
        total_score: e.total_score + p.score,
      });
    }
  }

  switch (tm.phase.tag) {
    case "Swiss": {
      awardSwissPoints(ctx, t, placed);
      const roundDone = [
        ...ctx.db.tournament_match.tm_by_tournament.filter(t.id),
      ]
        .filter((m) => m.round === tm.round && m.phase.tag === "Swiss")
        .every((m) => matchEnded(ctx, m.match_id));
      if (!roundDone) {
        return;
      }
      if (t.current_round < t.swiss_rounds_total) {
        startSwissRound(ctx, t.id, t.current_round + 1);
      } else {
        cut(ctx, t);
      }
      break;
    }
    case "Bracket":
      knockOutLast(ctx, t, placed);
      break;
    case "Final":
      if (finalGames(ctx, t.id).every((m) => matchEnded(ctx, m.match_id))) {
        if (finalGames(ctx, t.id).length >= FINAL_GAMES) {
          crown(ctx, t);
        }
      }
      break;
  }
}
