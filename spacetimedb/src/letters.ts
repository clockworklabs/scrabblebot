export function letterValue(c: string): number {
  switch (c) {
    case "A":
    case "E":
    case "I":
    case "O":
    case "U":
    case "L":
    case "N":
    case "S":
    case "T":
    case "R":
      return 1;
    case "D":
    case "G":
      return 2;
    case "B":
    case "C":
    case "M":
    case "P":
      return 3;
    case "F":
    case "H":
    case "V":
    case "W":
    case "Y":
      return 4;
    case "K":
      return 5;
    case "J":
    case "X":
      return 8;
    case "Q":
    case "Z":
      return 10;
    default:
      return 0;
  }
}

// Standard Scrabble distribution, no blanks. 98 tiles total.
export const BAG_SIZE = 98;
export const DEFAULT_BAG: readonly (readonly [string, number])[] = [
  ["A", 9],
  ["B", 2],
  ["C", 2],
  ["D", 4],
  ["E", 12],
  ["F", 2],
  ["G", 3],
  ["H", 2],
  ["I", 9],
  ["J", 1],
  ["K", 1],
  ["L", 4],
  ["M", 2],
  ["N", 6],
  ["O", 8],
  ["P", 2],
  ["Q", 1],
  ["R", 6],
  ["S", 4],
  ["T", 6],
  ["U", 4],
  ["V", 2],
  ["W", 2],
  ["X", 1],
  ["Y", 2],
  ["Z", 1],
];

// Length-based reward multiplier as (numerator, denominator).
// totalReward = baseScore * num / denom (integer division).
// Hoarding letters for longer words pays off superlinearly.
export function lengthMultiplier(len: number): [bigint, bigint] {
  if (len <= 3) return [1n, 1n]; // 1.0x
  if (len === 4) return [3n, 2n]; // 1.5x
  if (len === 5) return [2n, 1n]; // 2.0x
  if (len === 6) return [5n, 2n]; // 2.5x
  return [3n, 1n]; // 3.0x for 7+
}
