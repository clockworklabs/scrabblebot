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
  });
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
    sortDescending(entries, (e) => e.swiss_points);
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

function aggregateFinalScore(
  ctx: Ctx,
  tournament_id: bigint,
  bot_id: bigint,
): bigint {
  let total = 0n;
  const finalMatches = [
    ...ctx.db.tournament_match.tm_by_tournament.filter(tournament_id),
  ]
    .filter((m) => m.phase.tag === "Final")
    .map((m) => m.match_id);
  for (const mid of finalMatches) {
    const p = findParticipant(ctx, mid, bot_id);
    if (p) {
      total += p.score;
    }
  }
  return total;
}

function advanceTournament(ctx: Ctx, tournament_id: bigint) {
  const t = ctx.db.tournament.id.find(tournament_id);
  if (!t) {
    return;
  }
  switch (t.status.tag) {
    case "Swiss": {
      if (t.current_round < t.swiss_rounds_total) {
        startSwissRound(ctx, t.id, t.current_round + 1);
      } else {
        const entries = sortDescending(
          [...ctx.db.tournament_entry.te_by_tournament.filter(t.id)],
          (e) => e.swiss_points,
        );
        const kept = t.top_cut;
        entries.forEach((e, i) => {
          if (i >= kept) {
            ctx.db.tournament_entry.id.update({ ...e, eliminated: true });
          }
        });
        ctx.db.tournament.id.update({
          ...t,
          status: { tag: "Bracket" },
          current_round: 0,
        });
        startEliminationRound(ctx, t.id);
      }
      break;
    }
    case "Bracket": {
      const remaining = [
        ...ctx.db.tournament_entry.te_by_tournament.filter(t.id),
      ].filter((e) => !e.eliminated).length;
      if (remaining <= 1) {
        ctx.db.tournament.id.update({
          ...t,
          status: { tag: "Ended" },
          ended_at: ctx.timestamp,
        });
      } else if (remaining === 2) {
        ctx.db.tournament.id.update({
          ...t,
          status: { tag: "Final" },
          current_round: 0,
        });
        startFinalGame(ctx, t.id, 1);
      } else {
        startEliminationRound(ctx, t.id);
      }
      break;
    }
    default:
      break;
  }
}

function aliveRoster(ctx: Ctx, tournament_id: bigint): bigint[] {
  return [...ctx.db.tournament_entry.te_by_tournament.filter(tournament_id)]
    .filter((e) => !e.eliminated)
    .map((e) => e.bot_id);
}

function startEliminationRound(ctx: Ctx, tournament_id: bigint): Result<void> {
  const t = ctx.db.tournament.id.find(tournament_id);
  if (!t) {
    return { err: "Unknown tournament" };
  }
  const roster = aliveRoster(ctx, t.id);
  if (roster.length < 2) {
    return { ok: undefined };
  }
  const next_round = t.current_round + 1;
  ctx.db.tournament.id.update({ ...t, current_round: next_round });
  const started = startMatchWith(ctx, t.auction_type, roster);
  if (isErr(started)) {
    return started;
  }
  ctx.db.tournament_match.insert({
    id: 0n,
    tournament_id: t.id,
    match_id: started.ok,
    round: next_round,
    phase: { tag: "Bracket" },
  });
  return { ok: undefined };
}

function startFinalGame(
  ctx: Ctx,
  tournament_id: bigint,
  game_num: number,
): Result<void> {
  const t = ctx.db.tournament.id.find(tournament_id);
  if (!t) {
    return { err: "Unknown tournament" };
  }
  const roster = aliveRoster(ctx, t.id);
  if (roster.length < 2) {
    return { ok: undefined };
  }
  const started = startMatchWith(ctx, t.auction_type, roster);
  if (isErr(started)) {
    return started;
  }
  ctx.db.tournament_match.insert({
    id: 0n,
    tournament_id: t.id,
    match_id: started.ok,
    round: game_num,
    phase: { tag: "Final" },
  });
  console.info(`Final game ${game_num} started for tournament ${t.id}`);
  return { ok: undefined };
}

// The tournament's part in a match ending: score it, and move the
// tournament on once its round is over.
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
  if (!t) {
    return;
  }

  const placed = sortDescending(
    [...ctx.db.match_participant.mp_by_match.filter(match_id)],
    (p) => p.score,
  );

  switch (tm.phase.tag) {
    case "Swiss": {
      // Scored against the configured match size, not this table's,
      // so first place is worth the same at every table. Places past
      // match_size at an oversized table earn nothing.
      const n = t.match_size;
      placed.forEach((p, idx) => {
        const pts = Math.max(n - idx, 0);
        const e = entryFor(ctx, t.id, p.bot_id);
        if (e) {
          ctx.db.tournament_entry.id.update({
            ...e,
            swiss_points: e.swiss_points + pts,
          });
        }
      });
      break;
    }
    case "Bracket": {
      // Eliminate only the last-place bot.
      const last = placed[placed.length - 1];
      if (last) {
        const e = entryFor(ctx, t.id, last.bot_id);
        if (e) {
          ctx.db.tournament_entry.id.update({ ...e, eliminated: true });
        }
      }
      break;
    }
    case "Final":
      // Finals are best-of-3, decided after all 3 games.
      break;
  }

  if (tm.phase.tag === "Final") {
    const finalGamesDone = [
      ...ctx.db.tournament_match.tm_by_tournament.filter(t.id),
    ].filter(
      (m) => m.phase.tag === "Final" && matchEnded(ctx, m.match_id),
    ).length;
    if (finalGamesDone < 3) {
      startFinalGame(ctx, t.id, finalGamesDone + 1);
    } else {
      const finalists = [
        ...ctx.db.tournament_entry.te_by_tournament.filter(t.id),
      ]
        .filter((e) => !e.eliminated)
        .map((e) => e.bot_id);
      const totals = sortDescending(
        finalists.map((b) => [b, aggregateFinalScore(ctx, t.id, b)] as const),
        ([, total]) => total,
      );
      const loser = totals[totals.length - 1];
      if (loser) {
        const e = entryFor(ctx, t.id, loser[0]);
        if (e) {
          ctx.db.tournament_entry.id.update({ ...e, eliminated: true });
        }
      }
      ctx.db.tournament.id.update({
        ...t,
        status: { tag: "Ended" },
        ended_at: ctx.timestamp,
      });
      console.info("Tournament ended");
    }
    return;
  }

  const roundDone = [...ctx.db.tournament_match.tm_by_tournament.filter(t.id)]
    .filter((m) => m.round === tm.round && m.phase.tag === tm.phase.tag)
    .every((m) => matchEnded(ctx, m.match_id));
  if (!roundDone) {
    return;
  }
  advanceTournament(ctx, t.id);
}
