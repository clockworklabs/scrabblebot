// The cut and the finals: tiebreaks, admin-paced matches, and crowning a
// champion with placings.

import { expect, test } from "vitest";
import {
  createTournament,
  forceEndTournament,
  registerSimBots,
  startNextFinalsMatch,
  startTournament,
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
    createTournament(tx, {
      swissRoundsTotal: rounds,
      topCut: topCut,
      matchSize: size,
      auctionType: { tag: "Vickrey" },
    }),
  );
  const t = [...db.db.tournament.iter()][0]!.id;
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId: t }));
  call(db, "admin", (tx) => startTournament(tx, { tournamentId: t }));
  return [db, t];
}

const startNext = (db: Test, t: bigint, who = "admin") =>
  call(db, who, (tx) => startNextFinalsMatch(tx, { tournamentId: t }));

function matchesIn(db: Test, t: bigint, phase: TournamentPhase["tag"]) {
  return [...db.db.tournamentMatch.tmByTournament.filter(t)]
    .filter((m) => m.phase.tag === phase)
    .sort((a, b) => byBigint(a.id, b.id));
}

/** The bots at a match, lowest id first. */
function seatedAt(db: Test, matchId: bigint): bigint[] {
  return [...db.db.matchParticipant.mpByMatch.filter(matchId)]
    .map((p) => p.botId)
    .sort(byBigint);
}

/** End a match with exactly these scores, as its last auction would. */
function finish(db: Test, matchId: bigint, scores: Map<bigint, bigint>) {
  for (const p of [...db.db.matchParticipant.mpByMatch.filter(matchId)]) {
    db.db.matchParticipant.id.update({ ...p, score: scores.get(p.botId)! });
  }
  const m = db.db.matchState.id.find(matchId)!;
  db.db.matchState.id.update({
    ...m,
    status: { tag: "Ended" },
    endedAt: db.clock.now(),
  });
  internal(db, (tx) => onTournamentMatchEnded(tx, matchId));
}

/** End a match giving its bots, lowest id first, these scores. */
function finishInOrder(db: Test, matchId: bigint, scores: bigint[]) {
  const bots = seatedAt(db, matchId);
  finish(db, matchId, new Map(bots.map((b, i) => [b, scores[i]!])));
}

function entry(db: Test, t: bigint, bot: bigint): TournamentEntry {
  return [...db.db.tournamentEntry.teByTournament.filter(t)].find(
    (e) => e.botId === bot,
  )!;
}

function alive(db: Test, t: bigint): bigint[] {
  return [...db.db.tournamentEntry.teByTournament.filter(t)]
    .filter((e) => !e.eliminated)
    .map((e) => e.botId)
    .sort(byBigint);
}

const status = (db: Test, t: bigint) => db.db.tournament.id.find(t)!.status.tag;

test("bots on the same score share a swiss place", () => {
  const [db, t] = start(2, 2);
  const [table] = matchesIn(db, t, "Swiss");
  const [a, b, c] = seatedAt(db, table!.matchId);

  finishInOrder(db, table!.matchId, [10n, 10n, 5n]);

  expect([a, b, c].map((bot) => entry(db, t, bot!).swissPoints)).toEqual([
    3, 3, 1,
  ]);
  expect(entry(db, t, a!).totalScore).toBe(10n);
});

test("the cut breaks ties by total score then bot id", () => {
  // Two tables of three; the runners-up tie on points, and the top 3 go
  // through, so the cut has to choose between them.
  const play = (secondAtB: bigint) => {
    const [db, t] = start(1, 3);
    const [tableA, tableB] = matchesIn(db, t, "Swiss");
    const a = seatedAt(db, tableA!.matchId);
    const b = seatedAt(db, tableB!.matchId);
    finishInOrder(db, tableA!.matchId, [30n, 20n, 10n]);
    finishInOrder(db, tableB!.matchId, [30n, secondAtB, 10n]);
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

test("a cut to two goes straight to the final", () => {
  const [db, t] = start(1, 2);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.matchId);
  }
  expect(status(db, t)).toBe("Final");
  expect(alive(db, t).length).toBe(2);
});

test("finals matches wait for the admin", () => {
  const [db, t] = start(1, 4);
  expect(failure(() => startNext(db, t))).toBe(
    "The tournament isn't in its finals",
  );
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.matchId);
  }
  expect(matchesIn(db, t, "Bracket")).toEqual([]);

  expect(failure(() => startNext(db, t, "stranger"))).toBe("Admin only");
  startNext(db, t);
  expect(matchesIn(db, t, "Bracket").length).toBe(1);
  expect(failure(() => startNext(db, t))).toBe(
    "A finals match is already being played",
  );
});

test("an elimination match knocks out last place with tiebreaks", () => {
  const [db, t] = start(1, 4);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.matchId);
  }
  startNext(db, t);
  const [match] = matchesIn(db, t, "Bracket");
  const [w, x, y, z] = seatedAt(db, match!.matchId) as [
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
    db.db.tournamentEntry.id.update({ ...e, totalScore: totals.get(bot)! });
  }

  finish(
    db,
    match!.matchId,
    new Map([
      [w, 30n],
      [x, 10n],
      [y, 10n],
      [z, 10n],
    ]),
  );

  expect(alive(db, t)).toEqual([w, x, y]);
  expect(entry(db, t, z).finalFinishPosition).toBe(4);
  expect(status(db, t), "three left, so another elimination").toBe("Bracket");
});

test("the final goes to the best score over its games", () => {
  const [db, t] = start(1, 2);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.matchId);
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
      game.matchId,
      new Map([
        [a, sa],
        [b, sb],
      ]),
    );
  }

  const tour = db.db.tournament.id.find(t)!;
  expect(tour.status.tag).toBe("Ended");
  expect(tour.winnerBotId).toBe(a);
  expect(tour.endedAt).toEqual(db.clock.now());
  expect(entry(db, t, a).finalFinishPosition).toBe(1);
  expect(entry(db, t, b).finalFinishPosition).toBe(2);
  expect(alive(db, t)).toEqual([a]);
  expect(failure(() => startNext(db, t))).toBe(
    "The tournament isn't in its finals",
  );
});

test("a drawn final goes to total score", () => {
  const [db, t] = start(1, 2);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.matchId);
  }
  const [a, b] = alive(db, t) as [bigint, bigint];
  const ea = entry(db, t, a);
  db.db.tournamentEntry.id.update({ ...ea, totalScore: 0n });
  const eb = entry(db, t, b);
  db.db.tournamentEntry.id.update({ ...eb, totalScore: 99n });
  for (let i = 0; i < 3; i++) {
    startNext(db, t);
    finish(
      db,
      matchesIn(db, t, "Final")[i]!.matchId,
      new Map([
        [a, 10n],
        [b, 10n],
      ]),
    );
  }
  expect(db.db.tournament.id.find(t)!.winnerBotId).toBe(b);
});

test("a finished tournament has placings for its finalists", () => {
  const [db, t] = start(1, 4);
  for (let i = 0; i < 50 && status(db, t) !== "Ended"; i++) {
    const running = [
      ...db.db.matchState.matchByStatus.filter({
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
  const es = [...db.db.tournamentEntry.teByTournament.filter(t)];
  const placed = es
    .filter((e) => e.finalFinishPosition !== undefined)
    .sort((a, b) => a.finalFinishPosition! - b.finalFinishPosition!);
  expect(placed.map((e) => e.finalFinishPosition)).toEqual([1, 2, 3, 4]);
  expect(placed[0]!.botId).toBe(tour.winnerBotId);
  expect(placed[0]!.eliminated).toBe(false);
  expect(placed.slice(1).every((e) => e.eliminated)).toBe(true);
  expect(
    es.filter((e) => e.finalFinishPosition === undefined).length,
    "the two cut after the Swiss rounds have no placing",
  ).toBe(2);
});

// ---------- Stopping a tournament ----------

const forceEnd = (db: Test, t: bigint, who = "admin") =>
  call(db, who, (tx) => forceEndTournament(tx, { tournamentId: t }));

test("force ending stops a tournament where it is", () => {
  const [db, t] = start(2, 4);
  const round1 = matchesIn(db, t, "Swiss");

  forceEnd(db, t);

  const tour = db.db.tournament.id.find(t)!;
  expect(tour.status.tag).toBe("ForceEnded");
  expect(tour.endedAt).toEqual(db.clock.now());
  expect(tour.winnerBotId).toBeUndefined();
  // The matches it had going play out, but don't move it on.
  for (const m of round1) {
    runToEnd(db, m.matchId);
  }
  expect(matchesIn(db, t, "Swiss").length, "no second round").toBe(
    round1.length,
  );
  expect(status(db, t)).toBe("ForceEnded");
  expect(
    [...db.db.tournamentEntry.teByTournament.filter(t)].every(
      (e) => e.swissPoints === 0,
    ),
    "results after the stop don't count",
  ).toBe(true);
});

test("a force ended tournament ignores its finals match", () => {
  const [db, t] = start(1, 4);
  for (const m of matchesIn(db, t, "Swiss")) {
    runToEnd(db, m.matchId);
  }
  startNext(db, t);
  const before = alive(db, t);

  forceEnd(db, t);
  runToEnd(db, matchesIn(db, t, "Bracket")[0]!.matchId);

  expect(alive(db, t)).toEqual(before);
  expect(
    [...db.db.tournamentEntry.teByTournament.filter(t)].some(
      (e) => e.finalFinishPosition !== undefined,
    ),
  ).toBe(false);
  expect(failure(() => startNext(db, t))).toBe(
    "The tournament isn't in its finals",
  );
});

test("force ending needs a tournament under way", () => {
  const db = newDb();
  makeAdmin(db, "admin");
  call(db, "admin", (tx) =>
    createTournament(tx, {
      swissRoundsTotal: 1,
      topCut: 2,
      matchSize: 3,
      auctionType: { tag: "Vickrey" },
    }),
  );
  const t = [...db.db.tournament.iter()][0]!.id;
  expect(failure(() => forceEnd(db, t))).toBe(
    "This tournament hasn't started; cancel it instead",
  );
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId: t }));
  call(db, "admin", (tx) => startTournament(tx, { tournamentId: t }));
  expect(failure(() => forceEnd(db, t, "stranger"))).toBe("Admin only");
  forceEnd(db, t);
  expect(failure(() => forceEnd(db, t))).toBe(
    "This tournament has already finished",
  );
});

test("after a force end a new tournament can open", () => {
  const [db, t] = start(1, 2);
  forceEnd(db, t);
  call(db, "admin", (tx) =>
    createTournament(tx, {
      swissRoundsTotal: 1,
      topCut: 2,
      matchSize: 3,
      auctionType: { tag: "Vickrey" },
    }),
  );
  expect(db.db.tournament.count()).toBe(2n);
});
