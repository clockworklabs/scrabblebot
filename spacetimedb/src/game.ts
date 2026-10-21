import { Identity, ScheduleAt, Timestamp } from "spacetimedb";
import {
  SenderError,
  type InferSchema,
  type ReducerCtx,
  type ViewCtx,
} from "spacetimedb/server";
import { findBestPlayable } from "./dictionary";
import { identityFromClaims } from "./identity";
import { DEFAULT_BAG, lengthMultiplier, letterValue } from "./letters";
import {
  eloRatingPeriod,
  wengLinRatingPeriod,
  type EloRating,
  type Outcome,
  type WengLinRating,
} from "./ratings";
import type spacetimedb from "./schema";
import type {
  Auction,
  AuctionType,
  BotStats,
  BotStrategy,
  Holding,
  Match,
  MatchmakerConfig,
  MatchParticipant,
  PendingBid,
} from "./schema";

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
export type ViewContext = ViewCtx<InferSchema<typeof spacetimedb>>;

// The outcome of an internal step that can fail without failing the whole
// reducer, like Rust's `Result<T, String>`.
export type Result<T> = { ok: T } | { err: string };

export function isErr<T>(r: Result<T>): r is { err: string } {
  return "err" in r;
}

// Unwrap a step inside a reducer: a failed step fails the reducer, rolling
// back everything it wrote.
export function orThrow<T>(r: Result<T>): T {
  if (isErr(r)) throw new SenderError(r.err);
  return r.ok;
}

export const STARTING_BALANCE = 100n;
export const AUCTION_DURATION_MS = 1000n;
export const AUCTION_RESERVE = 1n;
// One hour. Long enough to copy a nonce into a bot config without hurry.
export const NONCE_TTL_SECONDS = 60n * 60n;

// Lobby: one open lobby at a time. Bots call `joinLobby` to enter. When
// it fills with `LOBBY_MAX_SIZE` real bots, the match starts immediately.
// When `LOBBY_DURATION_SECONDS` elapses, whoever's there plays, padded out
// to `LOBBY_MAX_SIZE` with idle simulated bots.
export const LOBBY_MAX_SIZE = 6;
export const LOBBY_DURATION_SECONDS = 90n;
// Each bot is dealt this many tiles from the bag at match start. They go
// straight into Holding (private), so opponents can't see them until the
// bot plays them in a word.
export const STARTING_RACK_SIZE = 5;

// Admins can change the auction length, rack size and lobby size from
// these defaults; see `setMatchmakerConfig`.
export function matchDefaults(ctx: Ctx): Omit<MatchmakerConfig, "id"> {
  return (
    ctx.db.matchmakerConfig.id.find(0) ?? {
      startingRackSize: STARTING_RACK_SIZE,
      lobbyMaxSize: LOBBY_MAX_SIZE,
      auctionDurationMs: AUCTION_DURATION_MS,
    }
  );
}

// Hardcoded seed admins — inserted by `init` on every fresh database init
// so wiping data (e.g. `--delete-data on-conflict` during dev) doesn't lock
// us out of the admin panel.
export const SEED_ADMIN_HEX: readonly string[] = [
  // Tyler
  "c200dd4e4e3e77c361561eee4c4932743ae44c634cf74819209080d98d5bc07e",
];

// ---------- Small helpers ----------

export function afterSeconds(ts: Timestamp, seconds: bigint): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + seconds * 1_000_000n);
}

export function afterMillis(ts: Timestamp, millis: bigint): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + millis * 1_000n);
}

function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

// Descending by `key`, keeping ties in their current order.
export function sortDescending<T>(
  items: T[],
  key: (item: T) => bigint | number,
): T[] {
  return items.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? 1 : ka > kb ? -1 : 0;
  });
}

// Fisher-Yates, as `rand`'s `SliceRandom::shuffle` does it.
export function shuffle<T>(ctx: Ctx, items: T[]): void {
  for (let i = items.length - 1; i >= 1; i--) {
    const j = ctx.random.integerInRange(0, i);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
}

// Rust's `f64::round` (half away from zero) then `as i32`.
function roundToI32(x: number): number {
  if (Number.isNaN(x)) return 0;
  const r = x < 0 ? -Math.round(-x) : Math.round(x);
  return Math.max(-2147483648, Math.min(2147483647, r));
}

// ---------- Callers ----------

export function resolveHumanView(ctx: ViewContext): Identity {
  const link = ctx.db.humanLink.webIdentity.find(ctx.sender);
  return link ? link.humanIdentity : ctx.sender;
}

export function resolveHuman(ctx: Ctx): Identity {
  const link = ctx.db.humanLink.webIdentity.find(ctx.sender);
  return link ? link.humanIdentity : ctx.sender;
}

function callerIsAdmin(ctx: Ctx): boolean {
  const human = resolveHuman(ctx);
  return ctx.db.admin.humanIdentity.find(human) != null;
}

export function requireAdmin(ctx: Ctx): void {
  if (!callerIsAdmin(ctx)) {
    throw new SenderError("Admin only");
  }
}

// Scheduled reducers are ordinary reducers, so clients can call them too.
// Only the database itself (the scheduler) may. (Not `senderAuth.isInternal`:
// the TypeScript module library sets it to false for every call on a real
// host, scheduled ones included.)
export function requireScheduler(ctx: Ctx): void {
  if (!ctx.sender.isEqual(ctx.databaseIdentity)) {
    throw new SenderError("Only the scheduler may call this");
  }
}

export function callerBotId(ctx: Ctx): bigint | undefined {
  return ctx.db.botCredential.identity.find(ctx.sender)?.botId;
}

// ---------- Sim bots ----------

export function ensureSimBot(
  ctx: Ctx,
  name: string,
  strategy: BotStrategy,
): Result<bigint> {
  const existing = ctx.db.bot.name.find(name);
  if (existing) {
    return { ok: existing.id };
  }
  const bot = ctx.db.bot.insert({
    id: 0n,
    name,
    teamId: 0n,
    isSimulated: true,
    strategy,
    createdAt: ctx.timestamp,
  });
  const identity = identityFromClaims("sim", name);
  if (ctx.db.botCredential.identity.find(identity) == null) {
    ctx.db.botCredential.insert({
      identity,
      botId: bot.id,
      connected: true,
      lastSeen: ctx.timestamp,
    });
  }
  console.info(`Seeded sim bot: ${name} (id ${bot.id})`);
  return { ok: bot.id };
}

// A 12-character code from an alphabet without lookalikes (60 bits). Not
// drawn from ctx.random: the SDK's seeding (2.12) maps many timestamps to
// the same few seeds, so two mints could draw the same code. It
// mixes the timestamp, the caller and an attempt number instead, and the
// caller retries with the next attempt if the code is taken.
export function generateNonceCode(ctx: Ctx, attempt: number): string {
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let h = splitmix64(ctx.timestamp.microsSinceUnixEpoch);
  for (let id = ctx.sender.__identity__; id > 0n; id >>= 64n) {
    h = splitmix64(h ^ BigInt.asUintN(64, id));
  }
  h = splitmix64(h ^ BigInt(attempt));
  let out = "";
  for (let n = 0; n < 12; n++) {
    out += CHARS[Number(h & 31n)];
    h >>= 5n;
  }
  return out;
}

// SplitMix64's output function, a cheap 64-bit mixer.
function splitmix64(x: bigint): bigint {
  x = BigInt.asUintN(64, x + 0x9e3779b97f4a7c15n);
  x = BigInt.asUintN(64, (x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n);
  x = BigInt.asUintN(64, (x ^ (x >> 27n)) * 0x94d049bb133111ebn);
  return x ^ (x >> 31n);
}

// ---------- Match control ----------
// Matches start via the lobby flow (see `joinLobby` /
// `lobbyTimeoutTick`) or via the tournament code. There's no direct
// public reducer to spawn a one-off match.

// Starts a match and returns its id. Checks the whole roster before writing
// anything, so callers that discard the error aren't left with a half-built
// match.
export function startMatchWith(
  ctx: Ctx,
  auctionType: AuctionType,
  participants: bigint[],
): Result<bigint> {
  if (participants.length === 0) {
    return { err: "Need at least one participant" };
  }
  const missing = participants.find((id) => ctx.db.bot.id.find(id) == null);
  if (missing !== undefined) {
    return { err: `Unknown bot in roster: ${missing}` };
  }
  const bagTotal = DEFAULT_BAG.reduce((sum, [, count]) => sum + count, 0);
  const { auctionDurationMs, startingRackSize } = matchDefaults(ctx);
  const inserted = ctx.db.matchState.insert({
    id: 0n,
    status: { tag: "Running" },
    currentRound: 1,
    currentAuctionId: undefined,
    bagTotal,
    auctionType,
    createdAt: ctx.timestamp,
    startedAt: ctx.timestamp,
    endedAt: undefined,
    auctionDurationMs,
    startingRackSize,
  });
  const matchId = inserted.id;

  for (const botId of participants) {
    ctx.db.matchParticipant.insert({
      id: 0n,
      matchId,
      botId,
      balance: STARTING_BALANCE,
      score: 0n,
    });
  }

  for (const [letter, count] of DEFAULT_BAG) {
    ctx.db.bagLetter.insert({
      id: 0n,
      matchId,
      letter,
      remaining: count,
    });
  }

  // Deal each participant a starting rack from the bag. These tiles are
  // hidden from opponents (Holding is private) and only become derivable
  // when a bot plays a word with them.
  for (const bid of participants) {
    for (let n = 0; n < startingRackSize; n++) {
      const letter = drawLetter(ctx, matchId);
      if (letter === undefined) {
        break;
      }
      addToRack(ctx, matchId, bid, letter);
    }
  }

  const firstLetter = drawLetter(ctx, matchId);
  if (firstLetter === undefined) {
    return { err: "Bag empty" };
  }
  const opensAt = ctx.timestamp;
  const closesAt = afterMillis(ctx.timestamp, auctionDurationMs);
  const opened = ctx.db.auction.insert({
    id: 0n,
    matchId,
    letter: firstLetter,
    opensAt,
    closesAt,
    status: { tag: "Open" },
  });

  const m = ctx.db.matchState.id.find(matchId)!;
  ctx.db.matchState.id.update({ ...m, currentAuctionId: opened.id });

  ctx.db.auctionSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(closesAt.microsSinceUnixEpoch),
    matchId,
  });

  simulateBids(ctx, opened);

  console.info(
    `Match ${matchId} started with ${participants.length} participants`,
  );
  return { ok: matchId };
}

// Add one `letter` tile to a bot's rack in a match.
function addToRack(ctx: Ctx, matchId: bigint, botId: bigint, letter: string) {
  const existing = [
    ...ctx.db.holding.holdingByMatchBot.filter([matchId, botId]),
  ].find((h) => h.letter === letter);
  if (existing) {
    ctx.db.holding.id.update({ ...existing, count: existing.count + 1 });
  } else {
    ctx.db.holding.insert({
      id: 0n,
      matchId,
      botId,
      letter,
      count: 1,
    });
  }
}

// ---------- Running matches ----------

export function botInRunningMatch(ctx: Ctx, botId: bigint): boolean {
  for (const p of ctx.db.matchParticipant.mpByBot.filter(botId)) {
    if (ctx.db.matchState.id.find(p.matchId)?.status.tag === "Running") {
      return true;
    }
  }
  return false;
}

// ---------- Match end ----------

export function onMatchEnded(ctx: Ctx, matchId: bigint) {
  // Move live `auctionTopBid` rows into the public archive. Once a match ends,
  // bots can't act on the info, so it's safe to expose; and pruning the
  // private table keeps `visibleAuctionTopBids` cheap to materialise.
  const live = [...ctx.db.auctionTopBid.topBidByMatch.filter(matchId)];
  for (const top of live) {
    ctx.db.auctionTopBidArchive.insert({
      auctionId: top.auctionId,
      matchId: top.matchId,
      topBid: top.topBid,
    });
    ctx.db.auctionTopBid.auctionId.delete(top.auctionId);
  }

  updateEloAtMatchEnd(ctx, matchId);
}

// ---------- ELO ----------

function getOrInitStats(ctx: Ctx, botId: bigint): BotStats {
  return (
    ctx.db.botStats.botId.find(botId) ?? {
      botId,
      rating: 1000,
      openskillMu: 25.0,
      openskillSigma: 25.0 / 3.0,
      matchesPlayed: 0,
      wins: 0,
      totalScore: 0n,
      lastPlayed: undefined,
    }
  );
}

function outcome(mine: bigint, theirs: bigint): Outcome {
  return mine > theirs ? "WIN" : mine < theirs ? "LOSS" : "DRAW";
}

export function updateEloAtMatchEnd(ctx: Ctx, matchId: bigint) {
  const placed = [...ctx.db.matchParticipant.mpByMatch.filter(matchId)];
  if (placed.length < 2) {
    return;
  }
  sortDescending(placed, (p) => p.score);

  // Snapshot all ratings before any updates
  const snapshots = placed.map((p) => getOrInitStats(ctx, p.botId));
  const preElo: EloRating[] = snapshots.map((s) => ({ rating: s.rating }));
  const preWl: WengLinRating[] = snapshots.map((s) => ({
    rating: s.openskillMu,
    uncertainty: s.openskillSigma,
  }));

  placed.forEach((p, idx) => {
    const others = placed
      .map((other, j) => [other, j] as const)
      .filter(([, j]) => j !== idx);
    const eloResults = others.map(
      ([other, j]) =>
        [preElo[j]!, outcome(p.score, other.score)] as [EloRating, Outcome],
    );
    const wlResults = others.map(
      ([other, j]) =>
        [preWl[j]!, outcome(p.score, other.score)] as [WengLinRating, Outcome],
    );

    const newElo = eloRatingPeriod(preElo[idx]!, eloResults);
    const newRating = Math.max(roundToI32(newElo.rating), 0);
    const newWl = wengLinRatingPeriod(preWl[idx]!, wlResults);

    const existing = getOrInitStats(ctx, p.botId);
    // Everyone tied on the top score shares the win.
    const wasWin = p.score === placed[0]!.score;
    const stats: BotStats = {
      ...existing,
      rating: newRating,
      openskillMu: newWl.rating,
      openskillSigma: newWl.uncertainty,
      matchesPlayed: existing.matchesPlayed + 1,
      wins: existing.wins + (wasWin ? 1 : 0),
      totalScore: existing.totalScore + p.score,
      lastPlayed: ctx.timestamp,
    };
    if (ctx.db.botStats.botId.find(p.botId) != null) {
      ctx.db.botStats.botId.update(stats);
    } else {
      ctx.db.botStats.insert(stats);
    }
  });
}

// Ended matches in the order they ended, those with no end time first.
export function endedMatchesInOrder(ctx: Ctx): Match[] {
  return [...ctx.db.matchState.iter()]
    .filter((m) => m.status.tag === "Ended")
    .sort((a, b) => {
      const ka = a.endedAt?.microsSinceUnixEpoch;
      const kb = b.endedAt?.microsSinceUnixEpoch;
      if (ka === kb) return 0;
      if (ka === undefined) return -1;
      if (kb === undefined) return 1;
      return ka < kb ? -1 : 1;
    });
}

// ---------- Auction close ----------

// Returns whether this ended the match, so the caller can run anything that
// follows a match ending outside the match itself (tournament progress).
export function closeAuction(ctx: Ctx, matchId: bigint): boolean {
  const m = ctx.db.matchState.id.find(matchId);
  if (!m || m.status.tag !== "Running") {
    return false;
  }
  const auctionId = m.currentAuctionId;
  if (auctionId === undefined) {
    return false;
  }
  const auction = ctx.db.auction.id.find(auctionId);
  if (!auction) {
    return false;
  }

  const bids = [...ctx.db.pendingBid.bidByAuction.filter(auctionId)];
  const sorted = bids.filter((b) => b.amount > 0n);
  // Shuffle, then stable-sort by amount, so equal bids land in random
  // order and ties don't always go to whoever bid first.
  shuffle(ctx, sorted);
  sortDescending(sorted, (b) => b.amount);

  let winner: bigint | undefined;
  let topBid = 0n;
  let paid = 0n;
  const [first, second] = sorted;
  if (first) {
    winner = first.bidderBotId;
    topBid = first.amount;
    if (m.auctionType.tag === "FirstPrice") {
      paid = first.amount;
    } else {
      paid = second ? second.amount : minBig(AUCTION_RESERVE, first.amount);
    }
  }

  let simWinner: bigint | undefined;
  if (winner !== undefined) {
    const participant = findParticipant(ctx, matchId, winner);
    if (participant && participant.balance >= paid) {
      const botIsSim = ctx.db.bot.id.find(winner)?.isSimulated ?? false;
      ctx.db.matchParticipant.id.update({
        ...participant,
        balance: participant.balance - paid,
      });
      addToRack(ctx, matchId, winner, auction.letter);
      if (botIsSim) {
        simWinner = winner;
      }
    }
  }

  ctx.db.auctionResult.insert({
    auctionId,
    matchId,
    letter: auction.letter,
    winnerBotId: winner,
    paid,
    closedAt: ctx.timestamp,
  });
  // Spectator-visible mirror of the winning bid (gated through the
  // `visibleAuctionTopBids` view so bots can't see it).
  ctx.db.auctionTopBid.insert({
    auctionId,
    matchId,
    topBid,
    visible: true,
  });
  ctx.db.auction.id.update({ ...auction, status: { tag: "Closed" } });
  for (const b of bids) {
    ctx.db.pendingBid.id.delete(b.id);
  }

  if (simWinner !== undefined) {
    simulateWordPlay(ctx, matchId, simWinner);
  }

  const m2 = ctx.db.matchState.id.find(matchId)!;
  const nextLetter = drawLetter(ctx, matchId);
  if (nextLetter === undefined) {
    ctx.db.matchState.id.update({
      ...m2,
      status: { tag: "Ended" },
      currentAuctionId: undefined,
      endedAt: ctx.timestamp,
    });
    console.info(`Match ${matchId} ended (bag empty)`);
    onMatchEnded(ctx, matchId);
    return true;
  }

  const opensAt = ctx.timestamp;
  const closesAt = afterMillis(ctx.timestamp, m2.auctionDurationMs);
  const nextAuction = ctx.db.auction.insert({
    id: 0n,
    matchId,
    letter: nextLetter,
    opensAt,
    closesAt,
    status: { tag: "Open" },
  });

  const m3 = ctx.db.matchState.id.find(matchId)!;
  ctx.db.matchState.id.update({
    ...m3,
    currentRound: m3.currentRound + 1,
    currentAuctionId: nextAuction.id,
  });
  ctx.db.auctionSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(closesAt.microsSinceUnixEpoch),
    matchId,
  });

  simulateBids(ctx, nextAuction);
  return false;
}

// ---------- Helpers ----------

export function findParticipant(
  ctx: Ctx,
  matchId: bigint,
  botId: bigint,
): MatchParticipant | undefined {
  return [...ctx.db.matchParticipant.mpByMatch.filter(matchId)].find(
    (p) => p.botId === botId,
  );
}

export function playWord(
  ctx: Ctx,
  participant: MatchParticipant,
  wordUpper: string,
): Result<void> {
  const matchId = participant.matchId;
  const botId = participant.botId;

  const needed = new Map<string, number>();
  for (const c of wordUpper) {
    needed.set(c, (needed.get(c) ?? 0) + 1);
  }

  const holdings = [
    ...ctx.db.holding.holdingByMatchBot.filter([matchId, botId]),
  ];
  const byLetter = new Map<string, [bigint, number]>();
  for (const h of holdings) {
    const c = [...h.letter][0];
    if (c !== undefined) {
      byLetter.set(c, [h.id, h.count]);
    }
  }
  for (const [c, n] of needed) {
    const have = byLetter.get(c)?.[1] ?? 0;
    if (have < n) {
      return { err: `Not enough '${c}': need ${n}, have ${have}` };
    }
  }

  for (const [c, n] of needed) {
    const [hid, ct] = byLetter.get(c)!;
    const newCount = ct - n;
    if (newCount === 0) {
      ctx.db.holding.id.delete(hid);
    } else {
      const h = ctx.db.holding.id.find(hid);
      if (h) {
        ctx.db.holding.id.update({ ...h, count: newCount });
      }
    }
  }

  let baseScore = 0n;
  for (const c of wordUpper) {
    baseScore += BigInt(letterValue(c));
  }
  const [num, denom] = lengthMultiplier(wordUpper.length);
  const totalReward = (baseScore * num) / denom;
  const bonus = totalReward - baseScore;

  ctx.db.matchParticipant.id.update({
    ...participant,
    balance: participant.balance + totalReward,
    score: participant.score + totalReward,
  });

  ctx.db.wordPlay.insert({
    id: 0n,
    matchId,
    botId,
    word: wordUpper,
    baseScore,
    bonus,
    totalReward,
    playedAt: ctx.timestamp,
  });

  console.info(
    `[match ${matchId}] '${wordUpper}' played: base=${baseScore}, bonus=${bonus}, total=${totalReward}`,
  );
  return { ok: undefined };
}

export function drawLetter(ctx: Ctx, matchId: bigint): string | undefined {
  const m = ctx.db.matchState.id.find(matchId);
  if (!m) {
    return undefined;
  }
  if (m.bagTotal === 0) {
    return undefined;
  }
  let idx = ctx.random.integerInRange(0, m.bagTotal - 1);
  const entries = [...ctx.db.bagLetter.bagByMatch.filter(matchId)]
    .filter((b) => b.remaining > 0)
    .sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0));
  for (const bag of entries) {
    if (idx < bag.remaining) {
      ctx.db.bagLetter.id.update({ ...bag, remaining: bag.remaining - 1 });
      ctx.db.matchState.id.update({ ...m, bagTotal: m.bagTotal - 1 });
      return bag.letter;
    }
    idx -= bag.remaining;
  }
  return undefined;
}

// ---------- Simulated-bot logic ----------

// How far a sim's bid may wander either side of its strategy's base bid.
// Without it, bots sharing a strategy bid identically on every letter.
export const SIM_BID_JITTER = 2n;

// `jitter` is added to the strategy's base bid; callers draw it from
// `-SIM_BID_JITTER..=SIM_BID_JITTER`.
export function decideBid(
  strategy: BotStrategy,
  letter: string,
  balance: bigint,
  jitter: bigint,
): bigint {
  const c = [...letter][0] ?? "A";
  const value = BigInt(letterValue(c));
  const isVowel = "AEIOU".includes(c);
  let base: bigint;
  switch (strategy.tag) {
    case "Human":
      return 0n;
    case "Cheapskate":
      base = value - 1n;
      break;
    case "ValueBidder":
      base = value;
      break;
    case "Aggressive":
      base = value + (isVowel ? 4n : 2n);
      break;
  }
  return maxBig(minBig(maxBig(base + jitter, 1n), balance), 0n);
}

export function simulateBids(ctx: Ctx, auction: Auction) {
  const participants = [
    ...ctx.db.matchParticipant.mpByMatch.filter(auction.matchId),
  ];
  for (const p of participants) {
    const bot = ctx.db.bot.id.find(p.botId);
    if (!bot) {
      continue;
    }
    if (!bot.isSimulated) {
      continue;
    }
    const jitter = BigInt(
      ctx.random.integerInRange(
        -Number(SIM_BID_JITTER),
        Number(SIM_BID_JITTER),
      ),
    );
    const amount = decideBid(bot.strategy, auction.letter, p.balance, jitter);
    if (amount <= 0n) {
      continue;
    }
    replaceBid(ctx, auction.id, bot.id, amount);
  }
}

// Record `botId`'s bid on an auction, replacing any earlier one.
export function replaceBid(
  ctx: Ctx,
  auctionId: bigint,
  botId: bigint,
  amount: bigint,
) {
  const prior: PendingBid[] = [
    ...ctx.db.pendingBid.bidByAuction.filter(auctionId),
  ].filter((b) => b.bidderBotId === botId);
  for (const b of prior) {
    ctx.db.pendingBid.id.delete(b.id);
  }
  ctx.db.pendingBid.insert({
    id: 0n,
    auctionId,
    bidderBotId: botId,
    amount,
    submittedAt: ctx.timestamp,
  });
}

function simulateWordPlay(ctx: Ctx, matchId: bigint, botId: bigint) {
  const participant = findParticipant(ctx, matchId, botId);
  if (!participant) {
    return;
  }
  const holdings: Holding[] = [
    ...ctx.db.holding.holdingByMatchBot.filter([matchId, botId]),
  ];
  const rack = new Map<string, number>();
  for (const h of holdings) {
    const c = [...h.letter][0];
    if (c !== undefined) {
      rack.set(c, (rack.get(c) ?? 0) + h.count);
    }
  }
  const word = findBestPlayable(rack, 3);
  if (word === undefined) {
    return;
  }
  playWord(ctx, participant, word);
}
