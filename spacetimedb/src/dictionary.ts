import WORDLIST from "../wordlist.txt";
import { asciiUppercase, byteLength, isAsciiUppercase } from "./text";

// The wordlist is bundled into the module as a string. The two word arrays
// below are derived from it on first use and kept for the life of the
// module instance; they depend only on the constant wordlist.
//
//   lexWords()     — the original lex-sorted wordlist (one word per line),
//                    binary-searched by `isValidWord`.
//   wordsByLength() — same words, sorted by length desc then lex asc. Used
//                    by `findBestPlayable` so the first match is the longest
//                    playable word and we early-exit when remaining words
//                    are shorter than `minLen`.
let LEX_WORDS: string[] | undefined;
let WORDS_BY_LENGTH: string[] | undefined;

export function lexWords(): string[] {
  LEX_WORDS ??= WORDLIST.split("\n").filter((l) => l.length > 0);
  return LEX_WORDS;
}

function wordsByLength(): string[] {
  WORDS_BY_LENGTH ??= [...lexWords()].sort(
    (a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0),
  );
  return WORDS_BY_LENGTH;
}

export function isValidWord(word: string): boolean {
  const target = asciiUppercase(word);
  if (byteLength(target) < 2) {
    return false;
  }
  if (!isAsciiUppercase(target)) {
    return false;
  }
  const words = lexWords();
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = lo + Math.floor((hi - lo) / 2);
    const w = words[mid]!;
    if (w < target) {
      lo = mid + 1;
    } else if (w === target) {
      return true;
    } else {
      hi = mid;
    }
  }
  return false;
}

const A = "A".charCodeAt(0);
const U32_MAX = 0xffffffff;

// Find the longest word in the dictionary that can be spelled from `rack`.
// Returns undefined if no word of `minLen` or longer can be made.
//
// Iterates the by-length-descending wordlist; the first match is by
// definition the longest playable word, and we stop as soon as the next
// candidate is shorter than `minLen`.
export function findBestPlayable(
  rack: Map<string, number>,
  minLen: number,
): string | undefined {
  const rackCounts = new Array<number>(26).fill(0);
  let total = 0;
  for (const [c, n] of rack) {
    if (/^[A-Z]$/.test(c)) {
      const slot = c.charCodeAt(0) - A;
      rackCounts[slot] = Math.min(rackCounts[slot]! + n, U32_MAX);
      total = Math.min(total + n, U32_MAX);
    }
  }
  if (total < minLen) {
    return undefined;
  }

  const need = new Array<number>(26);
  for (const word of wordsByLength()) {
    if (word.length < minLen) {
      break;
    }
    if (word.length > total) {
      continue;
    }
    need.fill(0);
    let ok = true;
    for (let i = 0; i < word.length; i++) {
      const slot = word.charCodeAt(i) - A;
      if (slot < 0 || slot >= 26) {
        ok = false;
        break;
      }
      need[slot]!++;
    }
    if (!ok) {
      continue;
    }
    if (need.every((n, i) => n <= rackCounts[i]!)) {
      return word;
    }
  }
  return undefined;
}
