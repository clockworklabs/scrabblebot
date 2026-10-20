// ELO and OpenSkill (Weng-Lin) updates at match end, and the backfills.

import { expect, test } from "vitest";
import { updateEloAtMatchEnd } from "../game";
import { eloRatingPeriod, wengLinRatingPeriod, type Outcome } from "../ratings";
import { backfillElo, backfillTopBidArchive } from "../index";
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
  const bots = scores.map(([b]) => b);
  const m = startMatch(db, VICKREY, bots);
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
  return m;
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

  // Corrupt the stats, then rebuild them.
  for (const s of live) {
    db.db.botStats.botId.update({ ...s, rating: 1, wins: 99 });
  }
  call(db, "alice", (tx) => backfillElo(tx, {}));

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
test("ratings match the rust skillratings crate", () => {
  type Opponent = [elo: number, mu: number, sigma: number, outcome: Outcome];
  const cases: {
    player: [elo: number, mu: number, sigma: number];
    opponents: Opponent[];
    elo: number;
    mu: number;
    sigma: number;
  }[] = [
    {
      player: [1000, 25, 8.333333333333334],
      opponents: [[1000, 25, 8.333333333333334, "WIN"]],
      elo: 1016,
      mu: 27.63523138347365,
      sigma: 8.065506316323548,
    },
    {
      player: [1016, 27.63523138347365, 8.065506316323548],
      opponents: [[984, 22.36476861652635, 8.065506316323548, "LOSS"]],
      elo: 998.5304984710245,
      mu: 24.5888998262643,
      sigma: 7.82210295723689,
    },
    {
      player: [1213, 31.2, 4.1],
      opponents: [
        [1187, 29.9, 5.3, "DRAW"],
        [1402, 35.1, 2.2, "LOSS"],
        [955, 20.4, 7.7, "WIN"],
      ],
      elo: 1209.9509615343452,
      mu: 30.740742342360203,
      sigma: 3.952693254815325,
    },
    {
      player: [870, 18.75, 6.25],
      opponents: [
        [1105, 26.5, 3.5, "WIN"],
        [990, 24.25, 4.75, "WIN"],
        [1320, 33, 1.5, "WIN"],
        [1001, 25.1, 8, "DRAW"],
        [760, 15, 6.9, "WIN"],
      ],
      elo: 955.5175038267862,
      mu: 27.48549521904071,
      sigma: 5.51138031966475,
    },
    {
      player: [1500, 40, 0.9],
      opponents: [
        [600, 5, 8.3, "LOSS"],
        [650, 7.5, 8.1, "LOSS"],
      ],
      elo: 1436.4645761552208,
      mu: 39.8457751336324,
      sigma: 0.8999787441444734,
    },
  ];
  for (const c of cases) {
    const elo = eloRatingPeriod(
      { rating: c.player[0] },
      c.opponents.map(([rating, , , outcome]) => [{ rating }, outcome]),
    );
    const wl = wengLinRatingPeriod(
      { rating: c.player[1], uncertainty: c.player[2] },
      c.opponents.map(([, rating, uncertainty, outcome]) => [
        { rating, uncertainty },
        outcome,
      ]),
    );
    expect([elo.rating, wl.rating, wl.uncertainty]).toEqual([
      c.elo,
      c.mu,
      c.sigma,
    ]);
  }
});
