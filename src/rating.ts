// The rating the site shows: OpenSkill's μ and σ on an Elo-like scale.
import type { BotStats } from "./module_bindings/types";
import { competitionRank } from "./util";

// What a new bot is rated, before its first match.
export const NEW_BOT = 1500;
// Rating points per point of μ, chosen so that, as in Elo, 400 points
// between two settled bots means 10:1 odds head to head: 400 / (ln 10 · β√2),
// with OpenSkill's β = 25/6.
const ELO_SCALE = 400 / (Math.LN10 * (25 / 6) * Math.SQRT2);
// A bot gets a rank once its ± is this narrow, which takes roughly 20 to 30
// matches. Until then it's listed below the ranked bots as provisional.
export const PROVISIONAL_ABOVE = 175;

// Anything carrying an OpenSkill rating: a bot's stats or a history row.
type Rated = { openskillMu: number; openskillSigma: number };

// OpenSkill's μ on that Elo-like scale, where a new bot's μ of 25 is 1500.
export function skill(s: Rated): number {
  return Math.round(NEW_BOT + ELO_SCALE * (s.openskillMu - 25));
}

// OpenSkill's σ on the same scale, shown as the ± after the rating.
export function spread(s: Rated): number {
  return Math.round(ELO_SCALE * s.openskillSigma);
}

export function isProvisional(s: Rated): boolean {
  return spread(s) > PROVISIONAL_ABOVE;
}

// Rated bots best first, split into ranked and provisional. Ranked bots on
// the same rating share a rank (1, 2, 3, 3, 3, 6).
export function standings(stats: BotStats[]) {
  const sorted = [...stats].sort((a, b) => skill(b) - skill(a));
  const ranked = sorted.filter((s) => !isProvisional(s));
  return {
    ranked,
    provisional: sorted.filter(isProvisional),
    rankOf: competitionRank(ranked, skill),
  };
}
