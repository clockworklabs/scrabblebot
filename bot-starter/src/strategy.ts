// Edit this file to implement your bidding and word-forming strategy.

// Standard Scrabble letter values — useful for valuation.
export const LETTER_VALUE: Record<string, number> = {
  A: 1, B: 3, C: 3, D: 2, E: 1, F: 4, G: 2, H: 4, I: 1, J: 8,
  K: 5, L: 1, M: 3, N: 1, O: 1, P: 3, Q: 10, R: 1, S: 1, T: 1,
  U: 1, V: 4, W: 4, X: 8, Y: 4, Z: 10,
};

export interface BidContext {
  letter: string;        // Letter being auctioned, e.g. "Q"
  myBalance: number;     // Current balance
  myRack: Map<string, number>; // Letters you currently own, letter -> count
}

/**
 * Decide how much to bid for `letter`. Return 0 to skip.
 * Default: bid the letter's face value plus a small premium if you don't have one yet.
 */
export function decideBid(ctx: BidContext): number {
  const value = LETTER_VALUE[ctx.letter] ?? 1;
  const have = ctx.myRack.get(ctx.letter) ?? 0;
  // Pay slightly above face value for letters you don't have yet.
  const want = have === 0 ? value + 2 : Math.max(1, value);
  return Math.min(want, Math.max(0, ctx.myBalance));
}

export interface WordContext {
  myRack: Map<string, number>;
  dictionary: string[]; // Sorted uppercase list, shared at startup
}

/**
 * Try to form a word using letters from `myRack`.
 * Return the word (uppercase) to play, or null to skip.
 *
 * Default strategy: greedily find the longest playable word in the dictionary.
 *
 * Keep this fast. The bot runs it on every rack change, and while it runs
 * the bot can't see the match move on: a search that takes longer than an
 * auction means bids on closed auctions and words from spent letters.
 */
export function chooseWord(ctx: WordContext): string | null {
  let tiles = 0;
  for (const count of ctx.myRack.values()) tiles += count;

  // The dictionary is longest first, so the first word we can spell is
  // the longest.
  for (const word of ctx.dictionary) {
    if (word.length <= tiles && canSpell(word, ctx.myRack)) return word;
  }
  return null;
}

// Whether `rack` has every letter of `word`, counting repeats.
function canSpell(word: string, rack: Map<string, number>): boolean {
  const used: Record<string, number> = {};
  for (const c of word) {
    used[c] = (used[c] ?? 0) + 1;
    if (used[c] > (rack.get(c) ?? 0)) return false;
  }
  return true;
}
