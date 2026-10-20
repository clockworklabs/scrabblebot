// Pure functions: tile values, the bag, scoring multipliers, the
// dictionary and the sim bots' bidding rules.

import { expect, test } from "vitest";
import WORDLIST from "../../wordlist.txt";
import { findBestPlayable, isValidWord } from "../dictionary";
import { decideBid } from "../game";
import { identityFromClaims } from "../identity";
import { DEFAULT_BAG, lengthMultiplier, letterValue } from "../letters";
import type { BotStrategy } from "../schema";
import { asClaims, emptyDb } from "./harness";

const HUMAN: BotStrategy = { tag: "Human" };
const CHEAPSKATE: BotStrategy = { tag: "Cheapskate" };
const VALUE_BIDDER: BotStrategy = { tag: "ValueBidder" };
const AGGRESSIVE: BotStrategy = { tag: "Aggressive" };

function rackOf(letters: string): Map<string, number> {
  const rack = new Map<string, number>();
  for (const c of letters) {
    rack.set(c, (rack.get(c) ?? 0) + 1);
  }
  return rack;
}

const words = WORDLIST.split("\n").filter((l) => l.length > 0);

test("letter values follow scrabble", () => {
  const cases: [string, number][] = [
    ["A", 1],
    ["D", 2],
    ["B", 3],
    ["F", 4],
    ["K", 5],
    ["J", 8],
    ["Q", 10],
    ["Z", 10],
  ];
  for (const [c, v] of cases) {
    expect(letterValue(c), c).toBe(v);
  }
  expect(letterValue("a"), "lowercase is not a tile").toBe(0);
  expect(letterValue("?")).toBe(0);
});

test("default bag is the 98 tile scrabble set", () => {
  expect(DEFAULT_BAG.length).toBe(26);
  expect(DEFAULT_BAG.reduce((sum, [, n]) => sum + n, 0)).toBe(98);
  const points = DEFAULT_BAG.reduce(
    (sum, [c, n]) => sum + letterValue(c) * n,
    0,
  );
  expect(points, "standard Scrabble face value without blanks").toBe(187);
});

test("length multiplier rewards longer words", () => {
  expect(lengthMultiplier(2)).toEqual([1n, 1n]);
  expect(lengthMultiplier(3)).toEqual([1n, 1n]);
  expect(lengthMultiplier(4)).toEqual([3n, 2n]);
  expect(lengthMultiplier(5)).toEqual([2n, 1n]);
  expect(lengthMultiplier(6)).toEqual([5n, 2n]);
  expect(lengthMultiplier(7)).toEqual([3n, 1n]);
  expect(lengthMultiplier(15)).toEqual([3n, 1n]);
});

test("dictionary accepts words in any case", () => {
  expect(isValidWord("AA")).toBe(true);
  expect(isValidWord("cat")).toBe(true);
  expect(isValidWord("QUIZ")).toBe(true);
  // First and last entries exercise the binary search's bounds.
  expect(isValidWord(words[0]!)).toBe(true);
  expect(isValidWord(words[words.length - 1]!)).toBe(true);
});

test("dictionary rejects nonwords and junk", () => {
  expect(isValidWord("XQZT")).toBe(false);
  expect(isValidWord("A"), "single letters are too short").toBe(false);
  expect(isValidWord("")).toBe(false);
  expect(isValidWord("CA T")).toBe(false);
  expect(isValidWord("CAT1")).toBe(false);
  expect(isValidWord("CAFÉ")).toBe(false);
});

test("wordlist is sorted uppercase and unique", () => {
  // `isValidWord` binary-searches the raw file, so this must hold.
  const outOfOrder = words.findIndex((w, i) => i > 0 && !(words[i - 1]! < w));
  expect(outOfOrder, `out of order at ${words[outOfOrder]}`).toBe(-1);
  expect(words.filter((w) => !/^[A-Z]+$/.test(w))).toEqual([]);
});

test("find best playable picks a longest word", () => {
  let word = findBestPlayable(rackOf("TAC"), 3)!;
  expect(word.length).toBe(3);
  expect(["ACT", "CAT"]).toContain(word);

  word = findBestPlayable(rackOf("SETAERX"), 3)!;
  expect(isValidWord(word)).toBe(true);
  expect(
    word.length,
    `expected a long word from SETAERX, got ${word}`,
  ).toBeGreaterThanOrEqual(6);
  const rack = rackOf("SETAERX");
  for (const c of word) {
    const n = rack.get(c);
    expect(n, "used a letter not on the rack").toBeDefined();
    expect(n!, `used ${c} too many times`).toBeGreaterThan(0);
    rack.set(c, n! - 1);
  }
});

test("find best playable respects min len", () => {
  expect(findBestPlayable(rackOf("AA"), 3)).toBeUndefined();
  expect(findBestPlayable(rackOf("AA"), 2)).toBe("AA");
  expect(findBestPlayable(rackOf("QXZ"), 3)).toBeUndefined();
  expect(findBestPlayable(new Map(), 2)).toBeUndefined();
});

test("find best playable ignores non tiles", () => {
  const rack = rackOf("CAT");
  rack.set("a", 5);
  rack.set("?", 5);
  const word = findBestPlayable(rack, 3)!;
  expect(word.length).toBe(3);
});

test("sim bid strategies", () => {
  // E is worth 1, Q 10.
  expect(decideBid(HUMAN, "Q", 100n, 0n)).toBe(0n);
  expect(decideBid(CHEAPSKATE, "E", 100n, 0n), "never below 1").toBe(1n);
  expect(decideBid(CHEAPSKATE, "Q", 100n, 0n)).toBe(9n);
  expect(decideBid(VALUE_BIDDER, "Q", 100n, 0n)).toBe(10n);
  expect(decideBid(AGGRESSIVE, "E", 100n, 0n), "vowel premium").toBe(5n);
  expect(decideBid(AGGRESSIVE, "Q", 100n, 0n)).toBe(12n);
});

test("sim bid jitter shifts the base bid", () => {
  expect(decideBid(VALUE_BIDDER, "Q", 100n, 2n)).toBe(12n);
  expect(decideBid(VALUE_BIDDER, "Q", 100n, -2n)).toBe(8n);
  expect(decideBid(CHEAPSKATE, "E", 100n, -2n), "never below 1").toBe(1n);
  expect(decideBid(AGGRESSIVE, "Q", 11n, 2n)).toBe(11n);
  expect(decideBid(HUMAN, "Q", 100n, 2n)).toBe(0n);
});

test("sim bids are capped by balance", () => {
  expect(decideBid(AGGRESSIVE, "Q", 7n, 0n)).toBe(7n);
  expect(decideBid(VALUE_BIDDER, "Q", 0n, 0n)).toBe(0n);
  expect(decideBid(VALUE_BIDDER, "Q", -5n, 0n), "never negative").toBe(0n);
});

// The TypeScript module computes sim bots' identities itself. They must be
// the identities the host gives clients with those claims.
test("identity from claims matches the host", () => {
  const db = emptyDb();
  const cases: [string, string][] = [
    ["sim", "Cheapo-sim"],
    ["sim", "Zed-sim"],
    ["https://auth.example.com", "alice"],
    ["sim", "Ünïcödé-sim 🎲"],
    ["sim", "x".repeat(32)],
  ];
  for (const [iss, sub] of cases) {
    const host = db.viewContext(asClaims(iss, sub)).sender;
    expect(identityFromClaims(iss, sub).toHexString(), `${iss}|${sub}`).toBe(
      host.toHexString(),
    );
  }
});
