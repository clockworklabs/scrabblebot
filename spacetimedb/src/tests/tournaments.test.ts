// Tournaments: Swiss rounds, then a bracket, then a best-of-3 final.

import { expect, test } from "vitest";
import { tableSizes } from "../game";
import { spawn_simulated_bot, start_tournament } from "../index";
import type {
  MatchParticipant,
  Tournament,
  TournamentEntry,
  TournamentMatch,
  TournamentPhase,
} from "../schema";
import {
  byBigint,
  call,
  failure,
  makeAdmin,
  newDb,
  participant,
  runToEnd,
  simIds,
  type Test,
} from "./harness";

function start(db: Test, rounds: number, topCut: number, size: number): bigint {
  call(db, "admin", (tx) =>
    start_tournament(tx, {
      swiss_rounds_total: rounds,
      top_cut: topCut,
      match_size: size,
      auction_type: { tag: "Vickrey" },
    }),
  );
  return [...db.db.tournament.iter()]
    .map((t) => t.id)
    .reduce((a, b) => (a > b ? a : b));
}

function adminDb(): Test {
  const db = newDb();
  makeAdmin(db, "admin");
  return db;
}

function tournament(db: Test, id: bigint): Tournament {
  return db.db.tournament.id.find(id)!;
}

function tmatches(
  db: Test,
  id: bigint,
  phase: TournamentPhase["tag"],
): TournamentMatch[] {
  return [...db.db.tournament_match.tm_by_tournament.filter(id)]
    .filter((m) => m.phase.tag === phase)
    .sort((a, b) => byBigint(a.id, b.id));
}

function entries(db: Test, id: bigint): TournamentEntry[] {
  return [...db.db.tournament_entry.te_by_tournament.filter(id)].sort((a, b) =>
    byBigint(a.bot_id, b.bot_id),
  );
}

function runningMatches(db: Test): bigint[] {
  return [...db.db.match_state.match_by_status.filter({ tag: "Running" })]
    .map((m) => m.id)
    .sort(byBigint);
}

function seated(db: Test, matchId: bigint): MatchParticipant[] {
  return [...db.db.match_participant.mp_by_match.filter(matchId)];
}

/** Play every running match to the end until nothing is left running. */
function playOut(db: Test) {
  for (let i = 0; i < 50; i++) {
    const running = runningMatches(db);
    if (running.length === 0) {
      return;
    }
    for (const m of running) {
      runToEnd(db, m);
    }
  }
  throw new Error("tournament never finished");
}

function spawnExtraSim(db: Test) {
  call(db, "admin", (tx) =>
    spawn_simulated_bot(tx, {
      name: "Extra-sim",
      strategy: { tag: "Cheapskate" },
    }),
  );
}

/** Swiss points of each bot in `matchId`, best score first. */
function pointsByPlacing(db: Test, t: bigint, matchId: bigint): number[] {
  const placed = seated(db, matchId).sort((a, b) => byBigint(b.score, a.score));
  return placed.map(
    (p) => entries(db, t).find((e) => e.bot_id === p.bot_id)!.swiss_points,
  );
}

test("start_tournament_validates_its_settings", () => {
  const db = adminDb();
  expect(failure(() => start(db, 1, 2, 1))).toBe(
    "Tournament match_size must be >= 2",
  );
  expect(failure(() => start(db, 0, 2, 2))).toBe("Need at least 1 Swiss round");
  expect(failure(() => start(db, 1, 1, 2))).toBe("top_cut must be >= 2");
  expect(failure(() => start(db, 1, 2, 7))).toBe(
    "Need at least 7 registered bots to start",
  );
  expect(db.db.tournament.count()).toBe(0n);
});

test("starting_enters_every_bot_and_pairs_round_one", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);

  const tour = tournament(db, t);
  expect([tour.status.tag, tour.current_round]).toEqual(["Swiss", 1]);
  const es = entries(db, t);
  expect(es.map((e) => e.bot_id)).toEqual(simIds(db));
  expect(es.every((e) => e.swiss_points === 0 && !e.eliminated)).toBe(true);

  const round1 = tmatches(db, t, "Swiss");
  expect(round1.length).toBe(2);
  const all = round1
    .flatMap((tm) => seated(db, tm.match_id).map((p) => p.bot_id))
    .sort(byBigint);
  expect(all, "each bot plays exactly once").toEqual(simIds(db));
});

test("swiss_matches_award_points_by_placing", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);
  const first = tmatches(db, t, "Swiss")[0]!.match_id;
  runToEnd(db, first);

  expect(pointsByPlacing(db, t, first)).toEqual([3, 2, 1]);
  expect(tournament(db, t).current_round, "round 1 isn't over yet").toBe(1);
});

test("the_next_swiss_round_starts_when_the_last_match_ends", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);
  for (const tm of tmatches(db, t, "Swiss")) {
    runToEnd(db, tm.match_id);
  }
  expect(tournament(db, t).current_round).toBe(2);
  const round2 = tmatches(db, t, "Swiss").filter((m) => m.round === 2);
  expect(round2.length).toBe(2);
});

test("a_full_tournament_runs_from_swiss_to_a_single_champion", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);
  playOut(db);

  const tour = tournament(db, t);
  expect(tour.status.tag).toBe("Ended");
  expect(tour.ended_at).toBeDefined();

  expect(tmatches(db, t, "Swiss").length).toBe(4);
  // Bracket: 4 → 3 → 2, one elimination per match.
  expect(tmatches(db, t, "Bracket").length).toBe(2);
  const finals = tmatches(db, t, "Final");
  expect(finals.map((m) => m.round)).toEqual([1, 2, 3]);

  const alive = entries(db, t).filter((e) => !e.eliminated);
  expect(alive.length, "one champion").toBe(1);
  // The champion had the best aggregate across the three finals.
  const champion = alive[0]!.bot_id;
  const finalists = seated(db, finals[0]!.match_id).map((p) => p.bot_id);
  expect(finalists.length).toBe(2);
  const total = (bot: bigint) =>
    finals.reduce((sum, f) => sum + participant(db, f.match_id, bot).score, 0n);
  for (const bot of finalists) {
    expect(total(champion) >= total(bot)).toBe(true);
  }
});

test("the_top_cut_keeps_the_best_swiss_records", () => {
  const db = adminDb();
  const t = start(db, 1, 4, 3);
  for (const tm of tmatches(db, t, "Swiss")) {
    runToEnd(db, tm.match_id);
  }

  expect(tournament(db, t).status.tag).toBe("Bracket");
  const es = entries(db, t);
  const kept = es.filter((e) => !e.eliminated);
  const cut = es.filter((e) => e.eliminated);
  expect(kept.length).toBe(4);
  for (const k of kept) {
    for (const c of cut) {
      expect(k.swiss_points >= c.swiss_points).toBe(true);
    }
  }
  const bracket = tmatches(db, t, "Bracket");
  expect(bracket.length).toBe(1);
  expect(seated(db, bracket[0]!.match_id).length).toBe(4);
});

test("table_sizes_seat_everyone_evenly", () => {
  expect(tableSizes(6, 3)).toEqual([3, 3]);
  expect(tableSizes(7, 3)).toEqual([4, 3]);
  expect(tableSizes(8, 3)).toEqual([4, 4]);
  expect(tableSizes(11, 3)).toEqual([4, 4, 3]);
  expect(tableSizes(5, 3)).toEqual([5]);
  expect(tableSizes(2, 2)).toEqual([2]);
  expect(tableSizes(1, 2)).toEqual([]);
  for (let n = 2; n < 40; n++) {
    for (let size = 2; size < 8; size++) {
      const sizes = tableSizes(n, size);
      expect(
        sizes.reduce((a, b) => a + b, 0),
        `n=${n} size=${size}`,
      ).toBe(n);
      expect(
        sizes.every((s) => s >= Math.min(size, n)),
        `n=${n} size=${size}: ${sizes}`,
      ).toBe(true);
      expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
    }
  }
});

test("every_entrant_plays_in_round_one", () => {
  const db = adminDb();
  spawnExtraSim(db);
  const t = start(db, 1, 2, 3);
  const sizes = tmatches(db, t, "Swiss").map(
    (tm) => seated(db, tm.match_id).length,
  );
  expect(sizes).toEqual([4, 3]);
});

test("an_oversized_table_scores_against_the_match_size", () => {
  const db = adminDb();
  spawnExtraSim(db);
  const t = start(db, 2, 2, 3);
  const big = tmatches(db, t, "Swiss").find(
    (tm) => seated(db, tm.match_id).length === 4,
  )!.match_id;
  runToEnd(db, big);

  expect(pointsByPlacing(db, t, big)).toEqual([3, 2, 1, 0]);
});

test("a_tournament_with_an_awkward_field_still_finishes", () => {
  const db = adminDb();
  spawnExtraSim(db);
  const t = start(db, 2, 3, 3);
  playOut(db);

  expect(tournament(db, t).status.tag).toBe("Ended");
  expect(
    entries(db, t).every((e) => e.swiss_points > 0),
    "everyone played",
  ).toBe(true);
  expect(entries(db, t).filter((e) => !e.eliminated).length).toBe(1);
});
