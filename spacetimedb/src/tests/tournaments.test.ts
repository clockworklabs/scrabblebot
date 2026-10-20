// Tournaments: Swiss rounds, then a bracket, then a best-of-3 final.

import { expect, test } from "vitest";
import { tableSizes } from "../tournament";
import {
  createTournament,
  registerSimBots,
  spawnSimulatedBot,
  startNextFinalsMatch,
  startTournament,
} from "../index";
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

function create(
  db: Test,
  rounds: number,
  topCut: number,
  size: number,
): bigint {
  call(db, "admin", (tx) =>
    createTournament(tx, {
      swissRoundsTotal: rounds,
      topCut: topCut,
      matchSize: size,
      auctionType: { tag: "Vickrey" },
    }),
  );
  return [...db.db.tournament.iter()]
    .map((t) => t.id)
    .reduce((a, b) => (a > b ? a : b));
}

/** Create a tournament, enter every sim bot and start it. */
function start(db: Test, rounds: number, topCut: number, size: number): bigint {
  const t = create(db, rounds, topCut, size);
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId: t }));
  call(db, "admin", (tx) => startTournament(tx, { tournamentId: t }));
  return t;
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
  return [...db.db.tournamentMatch.tmByTournament.filter(id)]
    .filter((m) => m.phase.tag === phase)
    .sort((a, b) => byBigint(a.id, b.id));
}

function entries(db: Test, id: bigint): TournamentEntry[] {
  return [...db.db.tournamentEntry.teByTournament.filter(id)].sort((a, b) =>
    byBigint(a.botId, b.botId),
  );
}

function runningMatches(db: Test): bigint[] {
  return [...db.db.matchState.matchByStatus.filter({ tag: "Running" })]
    .map((m) => m.id)
    .sort(byBigint);
}

function seated(db: Test, matchId: bigint): MatchParticipant[] {
  return [...db.db.matchParticipant.mpByMatch.filter(matchId)];
}

/**
 * Play every running match to the end, and start each finals match as the
 * admin would, until the tournament finishes.
 */
function playOut(db: Test) {
  for (let i = 0; i < 50; i++) {
    const running = runningMatches(db);
    if (running.length === 0) {
      const t = [...db.db.tournament.iter()].find((t) =>
        ["Bracket", "Final"].includes(t.status.tag),
      );
      if (!t) {
        return;
      }
      call(db, "admin", (tx) =>
        startNextFinalsMatch(tx, { tournamentId: t.id }),
      );
      continue;
    }
    for (const m of running) {
      runToEnd(db, m);
    }
  }
  throw new Error("tournament never finished");
}

function spawnExtraSim(db: Test) {
  call(db, "admin", (tx) =>
    spawnSimulatedBot(tx, {
      name: "Extra-sim",
      strategy: { tag: "Cheapskate" },
    }),
  );
}

/** Swiss points of each bot in `matchId`, best score first. */
function pointsByPlacing(db: Test, t: bigint, matchId: bigint): number[] {
  const placed = seated(db, matchId).sort((a, b) => byBigint(b.score, a.score));
  return placed.map(
    (p) => entries(db, t).find((e) => e.botId === p.botId)!.swissPoints,
  );
}

test("create tournament validates its settings", () => {
  const db = adminDb();
  expect(failure(() => create(db, 1, 2, 1))).toBe(
    "Tournament match_size must be >= 2",
  );
  expect(failure(() => create(db, 0, 2, 2))).toBe(
    "Need at least 1 Swiss round",
  );
  expect(failure(() => create(db, 1, 1, 2))).toBe("top_cut must be >= 2");
  expect(db.db.tournament.count()).toBe(0n);
});

test("starting needs enough entrants", () => {
  const db = adminDb();
  expect(failure(() => start(db, 1, 2, 7))).toBe(
    "Need at least 7 registered bots to start",
  );
  const t = [...db.db.tournament.iter()][0]!;
  expect(t.status.tag, "still taking registrations").toBe("Registration");
});

test("starting enters every bot and pairs round one", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);

  const tour = tournament(db, t);
  expect([tour.status.tag, tour.currentRound]).toEqual(["Swiss", 1]);
  const es = entries(db, t);
  expect(es.map((e) => e.botId)).toEqual(simIds(db));
  expect(es.every((e) => e.swissPoints === 0 && !e.eliminated)).toBe(true);

  const round1 = tmatches(db, t, "Swiss");
  expect(round1.length).toBe(2);
  const all = round1
    .flatMap((tm) => seated(db, tm.matchId).map((p) => p.botId))
    .sort(byBigint);
  expect(all, "each bot plays exactly once").toEqual(simIds(db));
});

test("swiss matches award points by placing", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);
  const first = tmatches(db, t, "Swiss")[0]!.matchId;
  runToEnd(db, first);

  expect(pointsByPlacing(db, t, first)).toEqual([3, 2, 1]);
  expect(tournament(db, t).currentRound, "round 1 isn't over yet").toBe(1);
});

test("the next swiss round starts when the last match ends", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);
  for (const tm of tmatches(db, t, "Swiss")) {
    runToEnd(db, tm.matchId);
  }
  expect(tournament(db, t).currentRound).toBe(2);
  const round2 = tmatches(db, t, "Swiss").filter((m) => m.round === 2);
  expect(round2.length).toBe(2);
});

test("a full tournament runs from swiss to a single champion", () => {
  const db = adminDb();
  const t = start(db, 2, 4, 3);
  playOut(db);

  const tour = tournament(db, t);
  expect(tour.status.tag).toBe("Ended");
  expect(tour.endedAt).toBeDefined();

  expect(tmatches(db, t, "Swiss").length).toBe(4);
  // Bracket: 4 → 3 → 2, one elimination per match.
  expect(tmatches(db, t, "Bracket").length).toBe(2);
  const finals = tmatches(db, t, "Final");
  expect(finals.map((m) => m.round)).toEqual([1, 2, 3]);

  const alive = entries(db, t).filter((e) => !e.eliminated);
  expect(alive.length, "one champion").toBe(1);
  // The champion had the best aggregate across the three finals.
  const champion = alive[0]!.botId;
  const finalists = seated(db, finals[0]!.matchId).map((p) => p.botId);
  expect(finalists.length).toBe(2);
  const total = (bot: bigint) =>
    finals.reduce((sum, f) => sum + participant(db, f.matchId, bot).score, 0n);
  for (const bot of finalists) {
    expect(total(champion) >= total(bot)).toBe(true);
  }
});

test("the top cut keeps the best swiss records", () => {
  const db = adminDb();
  const t = start(db, 1, 4, 3);
  for (const tm of tmatches(db, t, "Swiss")) {
    runToEnd(db, tm.matchId);
  }

  expect(tournament(db, t).status.tag).toBe("Bracket");
  const es = entries(db, t);
  const kept = es.filter((e) => !e.eliminated);
  const cut = es.filter((e) => e.eliminated);
  expect(kept.length).toBe(4);
  for (const k of kept) {
    for (const c of cut) {
      expect(k.swissPoints >= c.swissPoints).toBe(true);
    }
  }
  expect(tmatches(db, t, "Bracket"), "the bracket waits for the admin").toEqual(
    [],
  );
  call(db, "admin", (tx) => startNextFinalsMatch(tx, { tournamentId: t }));
  const bracket = tmatches(db, t, "Bracket");
  expect(bracket.length).toBe(1);
  expect(seated(db, bracket[0]!.matchId).length).toBe(4);
});

test("table sizes seat everyone evenly", () => {
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

test("every entrant plays in round one", () => {
  const db = adminDb();
  spawnExtraSim(db);
  const t = start(db, 1, 2, 3);
  const sizes = tmatches(db, t, "Swiss").map(
    (tm) => seated(db, tm.matchId).length,
  );
  expect(sizes).toEqual([4, 3]);
});

test("an oversized table scores against the match size", () => {
  const db = adminDb();
  spawnExtraSim(db);
  const t = start(db, 2, 2, 3);
  const big = tmatches(db, t, "Swiss").find(
    (tm) => seated(db, tm.matchId).length === 4,
  )!.matchId;
  runToEnd(db, big);

  // First is worth 3, as at a table of three, and fourth earns nothing.
  // Bots on the same score share the higher place.
  const scores = seated(db, big)
    .map((p) => p.score)
    .sort((a, b) => byBigint(b, a));
  const expected = scores.map((s) =>
    Math.max(3 - scores.filter((other) => other > s).length, 0),
  );
  expect(pointsByPlacing(db, t, big)).toEqual(expected);
});

test("a tournament with an awkward field still finishes", () => {
  const db = adminDb();
  spawnExtraSim(db);
  const t = start(db, 2, 3, 3);
  playOut(db);

  expect(tournament(db, t).status.tag).toBe("Ended");
  expect(
    entries(db, t).every((e) => e.swissPoints > 0),
    "everyone played",
  ).toBe(true);
  expect(entries(db, t).filter((e) => !e.eliminated).length).toBe(1);
});
