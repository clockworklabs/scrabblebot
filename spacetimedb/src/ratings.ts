// Elo and OpenSkill ratings. Elo is ported from the Rust `skillratings`
// crate (0.29) that the module used before, operation for operation,
// including its fused multiply-adds and Rust's `powf`, so it comes out the
// same. OpenSkill uses the Plackett-Luce model, which rates a whole
// free-for-all at once.

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

// ---------- OpenSkill (Plackett-Luce) ----------

export type WengLinRating = { rating: number; uncertainty: number };

// A bot's rating going into a match, and where it finished: 0 for first,
// with bots level on points sharing a place.
export type Placed = WengLinRating & { place: number };

const BETA_SQ = (25.0 / 6.0) ** 2;
const KAPPA = 0.000_1;

// One match rated as a single result under the Plackett-Luce model (Weng
// and Lin 2011, algorithm 4), each bot a team of one, so a 6-bot match is
// one observation rather than 15 separate games. Gives what the `openskill`
// package's default `rate` gives.
export function plackettLuce(players: Placed[]): WengLinRating[] {
  const c = Math.sqrt(
    players.reduce(
      (sum, p) => sum + p.uncertainty * p.uncertainty + BETA_SQ,
      0,
    ),
  );
  const strength = players.map((p) => exp(p.rating / c));
  // For each place, the strength of everyone still in the running for it.
  const field = players.map((q) =>
    players.reduce(
      (sum, p, i) => (p.place >= q.place ? sum + strength[i]! : sum),
      0,
    ),
  );
  const tied = players.map(
    (q) => players.filter((p) => p.place === q.place).length,
  );

  return players.map((p, i) => {
    let omega = 0;
    let delta = 0;
    players.forEach((q, j) => {
      if (q.place > p.place) return;
      const share = strength[i]! / field[j]!;
      omega += (i === j ? 1 - share : -share) / tied[j]!;
      delta += (share * (1 - share)) / tied[j]!;
    });
    const sigmaSq = p.uncertainty * p.uncertainty;
    const gamma = p.uncertainty / c;
    return {
      rating: p.rating + omega * (sigmaSq / c),
      uncertainty:
        p.uncertainty *
        Math.sqrt(Math.max(1 - gamma * delta * (sigmaSq / (c * c)), KAPPA)),
    };
  });
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
