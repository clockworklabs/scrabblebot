// Playing words: validation, rack consumption and scoring.

import { expect, test } from "vitest";
import { STARTING_BALANCE } from "../game";
import { submitWord } from "../index";
import {
  call,
  failure,
  newDb,
  now,
  participant,
  rack,
  runToEnd,
  setRack,
  simIds,
  startMatch,
  teamWithBot,
  VICKREY,
  type Test,
} from "./harness";

/** Ann (a real bot) in a running match with a sim. Returns [match, ann]. */
function setup(db: Test, letters: string): [bigint, bigint] {
  const ann = teamWithBot(db, "alice", "Ann");
  const m = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);
  setRack(db, m, ann, letters);
  return [m, ann];
}

function play(db: Test, matchId: bigint, word: string) {
  call(db, "Ann", (tx) => submitWord(tx, { matchId: matchId, word }));
}

function firstPlay(db: Test, bot: bigint) {
  for (const w of db.db.wordPlay.playByBot.filter(bot)) return w;
  throw new Error("no word played");
}

test("playing a word scores it and uses up the tiles", () => {
  const db = newDb();
  const [m, ann] = setup(db, "CATT");

  play(db, m, "cat");

  expect(rack(db, m, ann)).toEqual([["T", 1]]);
  const p = participant(db, m, ann);
  expect([p.score, p.balance]).toEqual([5n, STARTING_BALANCE + 5n]);
  const w = firstPlay(db, ann);
  expect(w.word).toBe("CAT");
  expect([w.baseScore, w.bonus, w.totalReward]).toEqual([5n, 0n, 5n]);
  expect(w.playedAt).toEqual(now());
});

test("longer words earn a multiplier", () => {
  // [word, base, total]
  const cases: [string, bigint, bigint][] = [
    ["QUIZ", 22n, 33n], // 1.5x
    ["AXES", 11n, 16n], // 1.5x, rounded down
    ["QUAKE", 18n, 36n], // 2x
    ["ZEBRAS", 17n, 42n], // 2.5x, rounded down
    ["JUKEBOX", 27n, 81n], // 3x
  ];
  for (const [word, base, total] of cases) {
    const db = newDb();
    const [m, ann] = setup(db, word);
    play(db, m, word);
    const w = firstPlay(db, ann);
    expect([w.baseScore, w.totalReward, w.bonus], word).toEqual([
      base,
      total,
      total - base,
    ]);
    expect(participant(db, m, ann).score).toBe(total);
  }
});

test("scores accumulate across words", () => {
  const db = newDb();
  const [m, ann] = setup(db, "CATDOG");
  play(db, m, "CAT");
  play(db, m, "DOG");
  expect(participant(db, m, ann).score).toBe(5n + 5n);
  expect(rack(db, m, ann)).toEqual([]);
});

test("words must be spelled from the rack", () => {
  const db = newDb();
  const [m, ann] = setup(db, "CAT");
  for (const word of ["DOG", "TACT", "CATS"]) {
    const err = failure(() => play(db, m, word));
    expect(err.startsWith("Not enough '"), `${word}: ${err}`).toBe(true);
  }
  expect(failure(() => play(db, m, "TAT"))).toBe(
    "Not enough 'T': need 2, have 1",
  );
  expect(rack(db, m, ann).length, "failed plays don't consume tiles").toBe(3);
  expect(participant(db, m, ann).score).toBe(0n);
});

test("words are validated", () => {
  const db = newDb();
  const [m] = setup(db, "CATXQZ");
  expect(failure(() => play(db, m, "C"))).toBe(
    "Word must be at least 2 letters",
  );
  expect(failure(() => play(db, m, "CA T"))).toBe("Word must be A-Z only");
  expect(failure(() => play(db, m, "çat"))).toBe("Word must be A-Z only");
  expect(failure(() => play(db, m, "xqz"))).toBe(
    "'XQZ' is not in the dictionary",
  );
  expect(failure(() => play(db, 9999n, "CAT"))).toBe("Unknown match");
  expect(db.db.wordPlay.count()).toBe(0n);
});

test("only participants can play", () => {
  const db = newDb();
  const [m] = setup(db, "CAT");
  teamWithBot(db, "bob", "Ben");
  const cat = (who: string) =>
    failure(() =>
      call(db, who, (tx) => submitWord(tx, { matchId: m, word: "CAT" })),
    );
  expect(cat("stranger")).toBe("Your identity is not a credential for any bot");
  expect(cat("Ben")).toBe("Not in this match");
});

test("no words after the match ends", () => {
  const db = newDb();
  const [m, ann] = setup(db, "");
  runToEnd(db, m);
  setRack(db, m, ann, "CAT");
  expect(failure(() => play(db, m, "CAT"))).toBe("Match not running");
});

test("racks are per match", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const sims = simIds(db);
  const m1 = startMatch(db, VICKREY, [ann, sims[0]!]);
  const m2 = startMatch(db, VICKREY, [ann, sims[1]!]);
  setRack(db, m1, ann, "CAT");
  setRack(db, m2, ann, "DOG");

  expect(failure(() => play(db, m2, "CAT")).startsWith("Not enough")).toBe(
    true,
  );
  play(db, m1, "CAT");
  expect(rack(db, m2, ann).length).toBe(3);
});
