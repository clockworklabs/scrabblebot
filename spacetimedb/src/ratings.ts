// Elo and Weng-Lin (OpenSkill) rating periods, ported from the Rust
// `skillratings` crate (0.29) that the module used before. The arithmetic
// follows the crate operation for operation, including its fused
// multiply-adds and Rust's `exp` and `powf`, so ratings come out the same.

import { exp, pow } from "./libm";

export type Outcome = "WIN" | "LOSS" | "DRAW";

function chessPoints(outcome: Outcome): number {
  return outcome === "WIN" ? 1.0 : outcome === "DRAW" ? 0.5 : 0.0;
}

// ---------- Elo ----------

export type EloRating = { rating: number };

const ELO_K = 32.0;

export function eloRatingPeriod(
  player: EloRating,
  results: [EloRating, Outcome][],
): EloRating {
  let playerRating = player.rating;
  for (const [opponent, result] of results) {
    const exp =
      1.0 / (1.0 + pow(10.0, (opponent.rating - playerRating) / 400.0));
    const outcome = chessPoints(result);
    playerRating = fma(ELO_K, outcome - exp, playerRating);
  }
  return { rating: playerRating };
}

// ---------- Weng-Lin ----------

export type WengLinRating = { rating: number; uncertainty: number };

const WENG_LIN_BETA = 25.0 / 6.0;
const WENG_LIN_UNCERTAINTY_TOLERANCE = 0.000_001;

export function wengLinRatingPeriod(
  player: WengLinRating,
  results: [WengLinRating, Outcome][],
): WengLinRating {
  let playerRating = player.rating;
  let playerUncertainty = player.uncertainty;

  for (const [opponent, result] of results) {
    const c = Math.sqrt(
      fma(
        2.0,
        WENG_LIN_BETA * WENG_LIN_BETA,
        fma(
          playerUncertainty,
          playerUncertainty,
          opponent.uncertainty * opponent.uncertainty,
        ),
      ),
    );

    const p = pValue(playerRating, opponent.rating, c);
    const outcome = chessPoints(result);

    playerRating = newRating(playerRating, playerUncertainty, c, p, outcome);
    playerUncertainty = newUncertainty(
      playerUncertainty,
      c,
      p,
      WENG_LIN_UNCERTAINTY_TOLERANCE,
    );
  }

  return { rating: playerRating, uncertainty: playerUncertainty };
}

function pValue(ratingOne: number, ratingTwo: number, cValue: number): number {
  const e1 = exp(ratingOne / cValue);
  const e2 = exp(ratingTwo / cValue);
  return e1 / (e1 + e2);
}

function newRating(
  playerRating: number,
  playerUncertainty: number,
  cValue: number,
  pValue: number,
  score: number,
): number {
  return fma(
    (playerUncertainty * playerUncertainty) / cValue,
    score - pValue,
    playerRating,
  );
}

function newUncertainty(
  playerUncertainty: number,
  cValue: number,
  pValue: number,
  uncertaintyTolerance: number,
): number {
  const ratio = playerUncertainty / cValue;
  const eta = ratio * ratio * ratio * pValue * (1.0 - pValue);
  return Math.sqrt(
    playerUncertainty *
      playerUncertainty *
      Math.max(1.0 - eta, uncertaintyTolerance),
  );
}

// ---------- Fused multiply-add ----------

const scratch = new DataView(new ArrayBuffer(8));

// `x` as `[m, e]` with x = m * 2^e exactly, m an integer.
function decompose(x: number): [bigint, number] {
  scratch.setFloat64(0, x);
  const bits = scratch.getBigUint64(0);
  const negative = bits >> 63n === 1n;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0xfffffffffffffn;
  const [m, e] =
    exponentBits === 0
      ? [fraction, -1074]
      : [fraction | (1n << 52n), exponentBits - 1075];
  return [negative ? -m : m, e];
}

// a * b + c with a single rounding, like Rust's `f64::mul_add`. Computed
// exactly with integers, then rounded to the nearest double (ties to even)
// by `Number()`. Exact for the normal-range values ratings produce.
export function fma(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) {
    return a * b + c;
  }
  const [ma, ea] = decompose(a);
  const [mb, eb] = decompose(b);
  const [mc, ec] = decompose(c);
  const ep = ea + eb;
  const e = Math.min(ep, ec);
  const sum = ((ma * mb) << BigInt(ep - e)) + (mc << BigInt(ec - e));
  if (sum === 0n) {
    return a * b + c;
  }
  // Shift the integer down to at most 64 significant bits, keeping a sticky
  // bit, so `Number()` rounds once and the power-of-two scale is exact.
  const negative = sum < 0n;
  let mag = negative ? -sum : sum;
  let exp = e;
  const extra = mag.toString(2).length - 64;
  if (extra > 0) {
    const dropped = mag & ((1n << BigInt(extra)) - 1n);
    mag = (mag >> BigInt(extra)) | (dropped === 0n ? 0n : 1n);
    exp += extra;
  }
  let result = Number(mag);
  for (; exp < -1000; exp += 1000) result *= 2 ** -1000;
  for (; exp > 1000; exp -= 1000) result *= 2 ** 1000;
  result *= 2 ** exp;
  return negative ? -result : result;
}
