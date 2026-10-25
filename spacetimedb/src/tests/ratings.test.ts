// ELO and OpenSkill (Plackett-Luce) updates at match end, and the backfills.

import { TimeDuration } from "spacetimedb";
import { expect, test } from "vitest";
import { updateEloAtMatchEnd } from "../game";
import { eloRatingPeriod, plackettLuce, type Outcome } from "../ratings";
import {
  backfillElo,
  backfillTopBidArchive,
  startNewBotVersion,
} from "../index";
import type { BotStats } from "../schema";
import {
  byBigint,
  call,
  failure,
  getMatch,
  internal,
  makeAdmin,
  newDb,
  now,
  participant,
  runToEnd,
  simIds,
  startMatch,
  teamWithBot,
  VICKREY,
  type Test,
} from "./harness";

/**
 * A finished match between `scores`' bots with the given final scores,
 * rated as the match-end hook would.
 */
function rate(db: Test, scores: [bigint, bigint][]): bigint {
  const m = startMatch(
    db,
    VICKREY,
    scores.map(([b]) => b),
  );
  finish(db, m, scores);
  return m;
}

/** Ends match `m` with the given final scores and rates it. */
function finish(db: Test, m: bigint, scores: [bigint, bigint][]) {
  for (const [bot, score] of scores) {
    const p = participant(db, m, bot);
    db.db.matchParticipant.id.update({ ...p, score });
  }
  const state = getMatch(db, m);
  db.db.matchState.id.update({
    ...state,
    status: { tag: "Ended" },
    endedAt: db.clock.now(),
  });
  internal(db, (tx) => updateEloAtMatchEnd(tx, m));
}

function stats(db: Test, bot: bigint): BotStats {
  return db.db.botStats.botId.find(bot)!;
}

test("a win moves ratings apart", () => {
  const db = newDb();
  const [a, b] = simIds(db) as [bigint, bigint];
  rate(db, [
    [a, 30n],
    [b, 10n],
  ]);

  const [w, l] = [stats(db, a), stats(db, b)];
  expect([w.rating, l.rating], "K=32, equal starting ratings").toEqual([
    1016, 984,
  ]);
  expect(w.openskillMu > 25.0 && l.openskillMu < 25.0).toBe(true);
  expect(w.openskillSigma < 25.0 / 3.0 && l.openskillSigma < 25.0 / 3.0).toBe(
    true,
  );
  expect([w.matchesPlayed, w.wins, w.totalScore]).toEqual([1, 1, 30n]);
  expect([l.matchesPlayed, l.wins, l.totalScore]).toEqual([1, 0, 10n]);
  expect(w.lastPlayed).toEqual(now());
});

test("ratings are nearly zero sum and ordered by placing", () => {
  const db = newDb();
  const s = simIds(db);
  rate(db, [
    [s[0]!, 5n],
    [s[1]!, 50n],
    [s[2]!, 20n],
    [s[3]!, 20n],
  ]);

  const r = s.slice(0, 4).map((b) => stats(db, b).rating);
  expect(r[1]! > r[2]! && r[2] === r[3] && r[3]! > r[0]!, `${r}`).toBe(true);
  // Each bot's new rating is rounded on its own, so the pool can drift by
  // up to half a point per bot per match.
  const drift = r.reduce((sum, x) => sum + x, 0) - 4000;
  expect(Math.abs(drift), `drift ${drift}`).toBeLessThanOrEqual(2);
});

test("a draw leaves equal ratings unchanged", () => {
  const db = newDb();
  const [a, b] = simIds(db) as [bigint, bigint];
  rate(db, [
    [a, 20n],
    [b, 20n],
  ]);
  expect([stats(db, a).rating, stats(db, b).rating]).toEqual([1000, 1000]);
  expect(Math.abs(stats(db, a).openskillMu - 25.0)).toBeLessThan(1e-9);
});

test("everyone tied for first gets a win", () => {
  const db = newDb();
  const s = simIds(db);
  rate(db, [
    [s[0]!, 20n],
    [s[1]!, 20n],
    [s[2]!, 5n],
  ]);
  const wins = s.slice(0, 3).map((b) => stats(db, b).wins);
  expect(wins).toEqual([1, 1, 0]);
});

test("stats accumulate over matches", () => {
  const db = newDb();
  const [a, b] = simIds(db) as [bigint, bigint];
  rate(db, [
    [a, 30n],
    [b, 10n],
  ]);
  rate(db, [
    [a, 5n],
    [b, 10n],
  ]);

  const s = stats(db, a);
  expect([s.matchesPlayed, s.wins, s.totalScore]).toEqual([2, 1, 35n]);
  expect(
    s.rating,
    "losing to a lower-rated bot costs more than the win earned",
  ).toBeLessThan(1000);
});

test("a solo match is not rated", () => {
  const db = newDb();
  const a = simIds(db)[0]!;
  rate(db, [[a, 30n]]);
  expect(db.db.botStats.botId.find(a)).toBeNull();
  expect([...db.db.ratingHistory.iter()]).toEqual([]);
});

test("each rated match records every bot's new rating, dated by its end", () => {
  const db = newDb();
  const [a, b] = simIds(db) as [bigint, bigint];
  const first = rate(db, [
    [a, 30n],
    [b, 10n],
  ]);
  const ended = getMatch(db, first).endedAt;
  db.clock.advance(new TimeDuration(60_000_000n));
  const second = rate(db, [
    [a, 5n],
    [b, 10n],
  ]);

  const history = [...db.db.ratingHistory.historyByBot.filter(a)].sort((x, y) =>
    byBigint(x.matchId, y.matchId),
  );
  expect(history.map((h) => h.matchId)).toEqual([first, second]);
  expect(history[0]!.at).toEqual(ended);
  expect(history[1]!.at).toEqual(getMatch(db, second).endedAt);
  const s = stats(db, a);
  expect([history[1]!.openskillMu, history[1]!.openskillSigma]).toEqual([
    s.openskillMu,
    s.openskillSigma,
  ]);
  expect([...db.db.ratingHistory.historyByBot.filter(b)]).toHaveLength(2);
});

test("finishing a real match rates everyone in it", () => {
  const db = newDb();
  const sims = simIds(db);
  const m = startMatch(db, VICKREY, sims);
  runToEnd(db, m);

  const top = sims
    .map((b) => participant(db, m, b).score)
    .reduce((max, s) => (s > max ? s : max));
  for (const bot of sims) {
    const s = stats(db, bot);
    const score = participant(db, m, bot).score;
    expect(s.matchesPlayed).toBe(1);
    expect(s.totalScore).toBe(score);
    expect(s.wins, `bot ${bot}`).toBe(score === top ? 1 : 0);
  }
});

test("backfill elo replays history to the same result", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  const sims = simIds(db);
  for (const roster of [sims.slice(0, 3), sims.slice(2), sims.slice(1, 5)]) {
    const m = startMatch(db, VICKREY, roster);
    runToEnd(db, m);
  }
  const live = [...db.db.botStats.iter()].sort((a, b) =>
    byBigint(a.botId, b.botId),
  );
  const history = () =>
    [...db.db.ratingHistory.iter()]
      .map((h) => [h.matchId, h.botId, h.at, h.openskillMu, h.openskillSigma])
      .sort((x, y) =>
        x[0] === y[0]
          ? byBigint(x[1] as bigint, y[1] as bigint)
          : byBigint(x[0] as bigint, y[0] as bigint),
      );
  const liveHistory = history();
  expect(liveHistory).toHaveLength(
    live.reduce((n, s) => n + s.matchesPlayed, 0),
  );

  // Corrupt the stats and history, then rebuild them.
  for (const s of live) {
    db.db.botStats.botId.update({ ...s, rating: 1, wins: 99 });
  }
  const stray = db.db.ratingHistory.iter().next().value!;
  db.db.ratingHistory.insert({ ...stray, id: 0n, openskillMu: 99 });
  db.clock.advance(new TimeDuration(60_000_000n));
  call(db, "alice", (tx) => backfillElo(tx, {}));
  expect(history(), "dated by each match's end, not the backfill").toEqual(
    liveHistory,
  );

  const rebuilt = [...db.db.botStats.iter()].sort((a, b) =>
    byBigint(a.botId, b.botId),
  );
  const key = (s: BotStats) => [
    s.botId,
    s.rating,
    s.matchesPlayed,
    s.wins,
    s.totalScore,
    s.openskillMu,
    s.openskillSigma,
  ];
  // `toEqual` compares the floats exactly, like Rust's `to_bits`.
  expect(rebuilt.map(key)).toEqual(live.map(key));
});

test("backfill top bid archive moves ended matches in chunks", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  const ann = teamWithBot(db, "alice", "Ann");
  const ended = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);
  const running = startMatch(db, VICKREY, [ann, simIds(db)[1]!]);
  const state = getMatch(db, ended);
  db.db.matchState.id.update({ ...state, status: { tag: "Ended" } });
  // Legacy rows from before matches archived themselves.
  const legacy: [bigint, bigint][] = [
    [101n, ended],
    [102n, ended],
    [103n, ended],
    [201n, running],
  ];
  for (const [auctionId, matchId] of legacy) {
    db.db.auctionTopBid.insert({
      auctionId,
      matchId,
      topBid: 7n,
      visible: true,
    });
  }

  const backfill = (maxRows: number) =>
    call(db, "alice", (tx) => backfillTopBidArchive(tx, { maxRows }));
  expect(failure(() => backfill(0))).toBe("max_rows must be > 0");
  backfill(2);
  expect(db.db.auctionTopBidArchive.count()).toBe(2n);
  backfill(2);
  backfill(2);

  expect(db.db.auctionTopBidArchive.count()).toBe(3n);
  const left = [...db.db.auctionTopBid.iter()].map((t) => t.auctionId);
  expect(left, "running matches stay private").toEqual([201n]);
});

// Outputs of the Rust `skillratings` 0.29.2 crate, compiled to WebAssembly
// as the Rust module was, for the same inputs. The TypeScript port must
// reproduce them exactly, to the last bit.
test("elo matches the rust skillratings crate", () => {
  type Opponent = [elo: number, outcome: Outcome];
  const cases: {
    player: number;
    opponents: Opponent[];
    elo: number;
  }[] = [
    {
      player: 1000,
      opponents: [[1000, "WIN"]],
      elo: 1016,
    },
    {
      player: 1016,
      opponents: [[984, "LOSS"]],
      elo: 998.5304984710245,
    },
    {
      player: 1213,
      opponents: [
        [1187, "DRAW"],
        [1402, "LOSS"],
        [955, "WIN"],
      ],
      elo: 1209.9509615343452,
    },
    {
      player: 870,
      opponents: [
        [1105, "WIN"],
        [990, "WIN"],
        [1320, "WIN"],
        [1001, "DRAW"],
        [760, "WIN"],
      ],
      elo: 955.5175038267862,
    },
    {
      player: 1500,
      opponents: [
        [600, "LOSS"],
        [650, "LOSS"],
      ],
      elo: 1436.4645761552208,
    },
  ];
  for (const c of cases) {
    const elo = eloRatingPeriod(
      { rating: c.player },
      c.opponents.map(([rating, outcome]) => [{ rating }, outcome]),
    );
    expect(elo.rating).toEqual(c.elo);
  }
});

// Outputs of the `openskill` npm package (4.1.1), whose default `rate` is
// Plackett-Luce, for the same matches. Its `Math.exp` can differ from ours
// in the last bit, so these agree to 12 places rather than exactly.
test("openskill matches the openskill package", () => {
  type Player = [mu: number, sigma: number, place: number];
  const cases: {
    players: Player[];
    expected: [mu: number, sigma: number][];
  }[] = [
    {
      players: [
        [25, 8.333333333333334, 0],
        [25, 8.333333333333334, 1],
      ],
      expected: [
        [27.63523138347365, 8.065506316323548],
        [22.36476861652635, 8.065506316323548],
      ],
    },
    {
      players: [
        [25, 8.333333333333334, 0],
        [25, 8.333333333333334, 0],
      ],
      expected: [
        [25, 8.065506316323548],
        [25, 8.065506316323548],
      ],
    },
    {
      players: [
        [51.6, 1.39, 0],
        [48.98, 1.82, 1],
        [44.5, 1.43, 2],
        [47, 1.26, 3],
        [25, 8.333333333333334, 4],
        [11.75, 1.62, 5],
      ],
      expected: [
        [51.69931652742782, 1.3898441755955127],
        [49.07676902295709, 1.8190951040801187],
        [44.52574788199967, 1.4295220758946592],
        [46.90885433969147, 1.2596001391778169],
        [24.594558820432937, 7.825955570845122],
        [11.671374228654924, 1.6195528695360948],
      ],
    },
    {
      players: [
        [30.2, 4.1, 0],
        [35.1, 2.2, 1],
        [35.1, 2.2, 1],
        [20.4, 7.7, 3],
        [26, 6, 4],
      ],
      expected: [
        [31.1340321038928, 4.092559321355726],
        [35.0588299257802, 2.1983409165504844],
        [35.0588299257802, 2.1983409165504844],
        [21.92162992070921, 7.438680918074243],
        [23.688229780304862, 5.88777193976909],
      ],
    },
    {
      players: [
        [18.75, 6.25, 0],
        [40, 0.9, 0],
        [33, 1.5, 2],
        [25.1, 8, 2],
        [15, 6.9, 2],
        [24.25, 4.75, 5],
      ],
      expected: [
        [19.695118575713256, 6.236044597193379],
        [40.00787346134852, 0.8999843896595591],
        [32.9624405871058, 1.4997785867111788],
        [24.912494906750556, 7.866447296209009],
        [15.352852102169289, 6.855051760001233],
        [23.76030753859052, 4.734127644049885],
      ],
    },
  ];
  for (const c of cases) {
    const rated = plackettLuce(
      c.players.map(([rating, uncertainty, place]) => ({
        rating,
        uncertainty,
        place,
      })),
    );
    rated.forEach((r, i) => {
      const [mu, sigma] = c.expected[i]!;
      expect(r.rating).toBeCloseTo(mu, 12);
      expect(r.uncertainty).toBeCloseTo(sigma, 12);
    });
  }
});

test("openskill rates a free-for-all as one result", () => {
  const players = [40, 35, 30, 25, 20, 15].map((rating, place) => ({
    rating,
    uncertainty: 2,
    place,
  }));
  const rated = plackettLuce(players);
  // An upset at the top: the bottom seed wins, everyone else keeps order.
  const upset = plackettLuce(
    players.map((p, i) => ({ ...p, place: i === 5 ? 0 : p.place + 1 })),
  );
  const favourite = rated[0]!.rating - 40;
  const underdog = upset[5]!.rating - 15;
  expect(favourite, "an expected win earns less than an upset").toBeLessThan(
    underdog,
  );
  const moved = rated.map((r, i) => r.rating - players[i]!.rating);
  expect(Math.abs(moved.reduce((a, b) => a + b, 0))).toBeLessThan(1e-9);
  // One match shrinks sigma once, not once per opponent.
  for (const r of rated) expect(r.uncertainty).toBeGreaterThan(1.99);
});

// ---------- Bot versions ----------

const SECOND = new TimeDuration(1_000_000n);

const newVersion = (db: Test, member: string) =>
  call(db, member, (tx) => startNewBotVersion(tx, {}));

function retired(db: Test, bot: bigint) {
  return [...db.db.retiredBotStats.retiredByBot.filter(bot)].sort(
    (a, b) => a.version - b.version,
  );
}

test("a new version starts the bot's rating over and keeps the old one", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const sim = simIds(db)[0]!;
  rate(db, [
    [ann, 30n],
    [sim, 10n],
  ]);
  const v1 = stats(db, ann);

  db.clock.advance(SECOND);
  newVersion(db, "alice");
  expect(db.db.botStats.botId.find(ann), "v2 hasn't played").toBeNull();
  const kept = (bot: bigint) =>
    retired(db, bot).map((r) => [
      r.version,
      r.rating,
      r.openskillMu,
      r.openskillSigma,
      r.matchesPlayed,
    ]);
  const v1Kept = [
    [1, v1.rating, v1.openskillMu, v1.openskillSigma, v1.matchesPlayed],
  ];
  expect(kept(ann)).toEqual(v1Kept);

  db.clock.advance(SECOND);
  rate(db, [
    [ann, 5n],
    [sim, 10n],
  ]);
  const v2 = stats(db, ann);
  expect([v2.matchesPlayed, v2.wins]).toEqual([1, 0]);
  expect(v2.openskillMu, "a loss from a fresh 25").toBeLessThan(25);
  expect(v2.rating, "a loss from a fresh 1000").toBeLessThan(1000);
  expect(kept(ann), "v1 is left alone").toEqual(v1Kept);
  expect([...db.db.ratingHistory.historyByBot.filter(ann)]).toHaveLength(2);
});

test("a match under way when the version changes counts for the old version", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const sim = simIds(db)[0]!;
  const m = startMatch(db, VICKREY, [ann, sim]);
  db.clock.advance(SECOND);
  newVersion(db, "alice");
  finish(db, m, [
    [ann, 30n],
    [sim, 10n],
  ]);

  expect(db.db.botStats.botId.find(ann)).toBeNull();
  expect(
    retired(db, ann).map((r) => [r.version, r.matchesPlayed, r.wins]),
  ).toEqual([[1, 1, 1]]);
});

test("only someone on a team can start a new version", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Ann");
  expect(failure(() => newVersion(db, "mallory"))).toBe(
    "You're not on a team — create or join one first",
  );
  expect([...db.db.botVersion.iter()]).toEqual([]);
});

test("backfill elo keeps each version's ratings apart", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  const ann = teamWithBot(db, "alice", "Ann");
  const [s0, s1] = simIds(db) as [bigint, bigint];
  rate(db, [
    [ann, 30n],
    [s0, 10n],
  ]);
  db.clock.advance(SECOND);
  rate(db, [
    [ann, 10n],
    [s1, 20n],
  ]);
  db.clock.advance(SECOND);
  newVersion(db, "alice");
  db.clock.advance(SECOND);
  rate(db, [
    [ann, 25n],
    [s0, 5n],
  ]);

  // Backfill sets `lastPlayed` to its own time, so leave that out.
  const key = (s: BotStats) => [
    s.botId,
    s.rating,
    s.matchesPlayed,
    s.wins,
    s.totalScore,
    s.openskillMu,
    s.openskillSigma,
  ];
  const snapshot = () => ({
    current: [ann, s0, s1].map((b) => key(stats(db, b))),
    retired: retired(db, ann).map((r) => [r.version, ...key(r)]),
  });
  const before = snapshot();
  expect(before.retired.map((r) => r[0])).toEqual([1]);
  expect(before.current[0]![2], "v2 played once").toBe(1);

  db.clock.advance(SECOND);
  call(db, "alice", (tx) => backfillElo(tx, {}));
  expect(snapshot()).toEqual(before);
});
