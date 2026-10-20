// The cut and the finals: tiebreaks, admin-paced matches, and crowning a
// champion with placings.

import { expect, test } from "vitest";
import {
  create_tournament,
  force_end_tournament,
  register_sim_bots,
  start_next_finals_match,
  start_tournament,
} from "../index";
import type { TournamentEntry, TournamentPhase } from "../schema";
import { onTournamentMatchEnded } from "../tournament";
import {
  byBigint,
  call,
  failure,
  internal,
  makeAdmin,
  newDb,
  runToEnd,
  type Test,
} from "./harness";

/** A started tournament of the six sims. */
function start(rounds: number, topCut: number, size = 3): [Test, bigint] {
  const db = newDb();
  makeAdmin(db, "admin");
  call(db, "admin", (tx) =>
    create_tournament(tx, {
      swiss_rounds_total: rounds,
      top_cut: topCut,
      match_size: size,
      auction_type: { tag: "Vickrey" },
    }),
  );
  const t = [...db.db.tournament.iter()][0]!.id;
  call(db, "admin", (tx) => register_sim_bots(tx, { tournament_id: t }));
  call(db, "admin", (tx) => start_tournament(tx, { tournament_id: t }));
  return [db, t];
}

const startNext = (db: Test, t: bigint, who = "admin") =>
  call(db, who, (tx) => start_next_finals_match(tx, { tournament_id: t }));

function matchesIn(db: Test, t: bigint, phase: TournamentPhase["tag"]) {
  return [...db.db.tournament_match.tm_by_tournament.filter(t)]
    .filter((m) => m.phase.tag === phase)
    .sort((a, b) => byBigint(a.id, b.id));
}

/** The bots at a match, lowest id first. */
function seatedAt(db: Test, matchId: bigint): bigint[] {
  return [...db.db.match_participant.mp_by_match.filter(matchId)]
    .map((p) => p.bot_id)
    .sort(byBigint);
}

/** End a match with exactly these scores, as its last auction would. */
function finish(db: Test, matchId: bigint, scores: Map<bigint, bigint>) {
  for (const p of [...db.db.match_participant.mp_by_match.filter(matchId)]) {
    db.db.match_participant.id.update({ ...p, score: scores.get(p.bot_id)! });
  }
  const m = db.db.match_state.id.find(matchId)!;
  db.db.match_state.id.update({
    ...m,
    status: { tag: "Ended" },
    ended_at: db.clock.now(),
  });
  internal(db, (tx) => onTournamentMatchEnded(tx, matchId));
}

/** End a match giving its bots, lowest id first, these scores. */
function finishInOrder(db: Test, matchId: bigint, scores: bigint[]) {
  const bots = seatedAt(db, matchId);
  finish(db, matchId, new Map(bots.map((b, i) => [b, scores[i]!])));
}

function entry(db: Test, t: bigint, bot: bigint): TournamentEntry {
  return [...db.db.tournament_entry.te_by_tournament.filter(t)].find(
    (e) => e.bot_id === bot,
  )!;
}

function alive(db: Test, t: bigint): bigint[] {
  return [...db.db.tournament_entry.te_by_tournament.filter(t)]
    .filter((e) => !e.eliminated)
    .map((e) => e.bot_id)
    .sort(byBigint);
}

const status = (db: Test, t: bigint) => db.db.tournament.id.find(t)!.status.tag;

test("bots_on_the_same_score_share_a_swiss_place", () => {
  const [db, t] = start(2, 2);
  const [table] = matchesIn(db, t, "Swiss");
  const [a, b, c] = seatedAt(db, table!.match_id);

  finishInOrder(db, table!.match_id, [10n, 10n, 5n]);

  expect([a, b, c].map((bot) => entry(db, t, bot!).swiss_points)).toEqual([
    3, 3, 1,
  ]);
  expect(entry(db, t, a!).total_score).toBe(10n);
});

test("the_cut_breaks_ties_by_total_score_then_bot_id", () => {
  // Two tables of three; the runners-up tie on points, and the top 3 go
  // through, so the cut has to choose between them.
  const play = (secondAtB: bigint) => {
    const [db, t] = start(1, 3);
    const [tableA, tableB] = matchesIn(db, t, "Swiss");
    const a = seatedAt(db, tableA!.match_id);
    const b = seatedAt(db, tableB!.match_id);
    finishInOrder(db, tableA!.match_id, [30n, 20n, 10n]);
    finishInOrder(db, tableB!.match_id, [30n, secondAtB, 10n]);
    return { db, t, a, b };
  };

  // Level on total score too: the lower bot id goes through.
  let { db, t, a, b } = play(20n);
  const lower = a[1]! < b[1]! ? a[1]! : b[1]!;
  expect(alive(db, t)).toEqual([a[0]!, b[0]!, lower].sort(byBigint));
  expect(status(db, t)).toBe("Bracket");

  // A better total score beats a lower bot id.
  ({ db, t, a, b } = play(25n));
  expect(alive(db, t)).toEqual([a[0]!, b[0]!, b[1]!].sort(byBigint));
});

test("a_cut_to_two_goes_straight_to_the_final", () => {
  const [db, t] = start(1, 2);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.match_id);
  }
  expect(status(db, t)).toBe("Final");
  expect(alive(db, t).length).toBe(2);
});

test("finals_matches_wait_for_the_admin", () => {
  const [db, t] = start(1, 4);
  expect(failure(() => startNext(db, t))).toBe(
    "The tournament isn't in its finals",
  );
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.match_id);
  }
  expect(matchesIn(db, t, "Bracket")).toEqual([]);

  expect(failure(() => startNext(db, t, "stranger"))).toBe("Admin only");
  startNext(db, t);
  expect(matchesIn(db, t, "Bracket").length).toBe(1);
  expect(failure(() => startNext(db, t))).toBe(
    "A finals match is already being played",
  );
});

test("an_elimination_match_knocks_out_last_place_with_tiebreaks", () => {
  const [db, t] = start(1, 4);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.match_id);
  }
  startNext(db, t);
  const [match] = matchesIn(db, t, "Bracket");
  const [w, x, y, z] = seatedAt(db, match!.match_id) as [
    bigint,
    bigint,
    bigint,
    bigint,
  ];
  // x, y and z tie for last; y and z also tie on total score, so the
  // higher bot id, z, goes out.
  const totals = new Map([
    [w, 200n],
    [x, 100n],
    [y, 50n],
    [z, 50n],
  ]);
  for (const bot of [w, x, y, z]) {
    const e = entry(db, t, bot);
    db.db.tournament_entry.id.update({ ...e, total_score: totals.get(bot)! });
  }

  finish(
    db,
    match!.match_id,
    new Map([
      [w, 30n],
      [x, 10n],
      [y, 10n],
      [z, 10n],
    ]),
  );

  expect(alive(db, t)).toEqual([w, x, y]);
  expect(entry(db, t, z).final_finish_position).toBe(4);
  expect(status(db, t), "three left, so another elimination").toBe("Bracket");
});

test("the_final_goes_to_the_best_score_over_its_games", () => {
  const [db, t] = start(1, 2);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.match_id);
  }
  const [a, b] = alive(db, t) as [bigint, bigint];
  // b wins two of the three games, but a scores more over all three.
  const games: [bigint, bigint][] = [
    [40n, 10n],
    [5n, 15n],
    [5n, 10n],
  ];
  for (const [i, [sa, sb]] of games.entries()) {
    expect(status(db, t), `before game ${i + 1}`).toBe("Final");
    startNext(db, t);
    const game = matchesIn(db, t, "Final")[i]!;
    expect(game.round).toBe(i + 1);
    finish(
      db,
      game.match_id,
      new Map([
        [a, sa],
        [b, sb],
      ]),
    );
  }

  const tour = db.db.tournament.id.find(t)!;
  expect(tour.status.tag).toBe("Ended");
  expect(tour.winner_bot_id).toBe(a);
  expect(tour.ended_at).toEqual(db.clock.now());
  expect(entry(db, t, a).final_finish_position).toBe(1);
  expect(entry(db, t, b).final_finish_position).toBe(2);
  expect(alive(db, t)).toEqual([a]);
  expect(failure(() => startNext(db, t))).toBe(
    "The tournament isn't in its finals",
  );
});

test("a_drawn_final_goes_to_total_score", () => {
  const [db, t] = start(1, 2);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.match_id);
  }
  const [a, b] = alive(db, t) as [bigint, bigint];
  const ea = entry(db, t, a);
  db.db.tournament_entry.id.update({ ...ea, total_score: 0n });
  const eb = entry(db, t, b);
  db.db.tournament_entry.id.update({ ...eb, total_score: 99n });
  for (let i = 0; i < 3; i++) {
    startNext(db, t);
    finish(
      db,
      matchesIn(db, t, "Final")[i]!.match_id,
      new Map([
        [a, 10n],
        [b, 10n],
      ]),
    );
  }
  expect(db.db.tournament.id.find(t)!.winner_bot_id).toBe(b);
});

test("a_finished_tournament_has_placings_for_its_finalists", () => {
  const [db, t] = start(1, 4);
  for (let i = 0; i < 50 && status(db, t) !== "Ended"; i++) {
    const running = [
      ...db.db.match_state.match_by_status.filter({
        tag: "Running",
      }),
    ];
    if (running.length === 0) {
      startNext(db, t);
    }
    for (const m of running) {
      runToEnd(db, m.id);
    }
  }

  const tour = db.db.tournament.id.find(t)!;
  expect(tour.status.tag).toBe("Ended");
  const es = [...db.db.tournament_entry.te_by_tournament.filter(t)];
  const placed = es
    .filter((e) => e.final_finish_position !== undefined)
    .sort((a, b) => a.final_finish_position! - b.final_finish_position!);
  expect(placed.map((e) => e.final_finish_position)).toEqual([1, 2, 3, 4]);
  expect(placed[0]!.bot_id).toBe(tour.winner_bot_id);
  expect(placed[0]!.eliminated).toBe(false);
  expect(placed.slice(1).every((e) => e.eliminated)).toBe(true);
  expect(
    es.filter((e) => e.final_finish_position === undefined).length,
    "the two cut after the Swiss rounds have no placing",
  ).toBe(2);
});

// ---------- Stopping a tournament ----------

const forceEnd = (db: Test, t: bigint, who = "admin") =>
  call(db, who, (tx) => force_end_tournament(tx, { tournament_id: t }));

test("force_ending_stops_a_tournament_where_it_is", () => {
  const [db, t] = start(2, 4);
  const round1 = matchesIn(db, t, "Swiss");

  forceEnd(db, t);

  const tour = db.db.tournament.id.find(t)!;
  expect(tour.status.tag).toBe("ForceEnded");
  expect(tour.ended_at).toEqual(db.clock.now());
  expect(tour.winner_bot_id).toBeUndefined();
  // The matches it had going play out, but don't move it on.
  for (const m of round1) {
    runToEnd(db, m.match_id);
  }
  expect(matchesIn(db, t, "Swiss").length, "no second round").toBe(
    round1.length,
  );
  expect(status(db, t)).toBe("ForceEnded");
  expect(
    [...db.db.tournament_entry.te_by_tournament.filter(t)].every(
      (e) => e.swiss_points === 0,
    ),
    "results after the stop don't count",
  ).toBe(true);
});

test("a_force_ended_tournament_ignores_its_finals_match", () => {
  const [db, t] = start(1, 4);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.match_id);
  }
  startNext(db, t);
  const before = alive(db, t);

  forceEnd(db, t);
  runToEnd(db, matchesIn(db, t, "Bracket")[0]!.match_id);

  expect(alive(db, t)).toEqual(before);
  expect(
    [...db.db.tournament_entry.te_by_tournament.filter(t)].some(
      (e) => e.final_finish_position !== undefined,
    ),
  ).toBe(false);
  expect(failure(() => startNext(db, t))).toBe(
    "The tournament isn't in its finals",
  );
});

test("force_ending_needs_a_tournament_under_way", () => {
  const db = newDb();
  makeAdmin(db, "admin");
  call(db, "admin", (tx) =>
    create_tournament(tx, {
      swiss_rounds_total: 1,
      top_cut: 2,
      match_size: 3,
      auction_type: { tag: "Vickrey" },
    }),
  );
  const t = [...db.db.tournament.iter()][0]!.id;
  expect(failure(() => forceEnd(db, t))).toBe(
    "This tournament hasn't started; cancel it instead",
  );
  call(db, "admin", (tx) => register_sim_bots(tx, { tournament_id: t }));
  call(db, "admin", (tx) => start_tournament(tx, { tournament_id: t }));
  expect(failure(() => forceEnd(db, t, "stranger"))).toBe("Admin only");
  forceEnd(db, t);
  expect(failure(() => forceEnd(db, t))).toBe(
    "This tournament has already finished",
  );
});

test("after_a_force_end_a_new_tournament_can_open", () => {
  const [db, t] = start(1, 2);
  forceEnd(db, t);
  call(db, "admin", (tx) =>
    create_tournament(tx, {
      swiss_rounds_total: 1,
      top_cut: 2,
      match_size: 3,
      auction_type: { tag: "Vickrey" },
    }),
  );
  expect(db.db.tournament.count()).toBe(2n);
});
