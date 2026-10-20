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
  Lobby,
  Match,
  MatchParticipant,
  PendingBid,
} from "./schema";
import { heldForTournament, onTournamentMatchEnded } from "./tournament";

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

// Lobby: one open lobby at a time. Bots call `join_lobby` to enter. When
// it fills with `LOBBY_MAX_SIZE` real bots, the match starts immediately.
// When `LOBBY_DURATION_SECONDS` elapses, whoever's there plays, padded out
// to `LOBBY_MAX_SIZE` with idle simulated bots.
export const LOBBY_MAX_SIZE = 6;
export const LOBBY_DURATION_SECONDS = 90n;
// Each bot is dealt this many tiles from the bag at match start. They go
// straight into Holding (private), so opponents can't see them until the
// bot plays them in a word.
export const STARTING_RACK_SIZE = 5;

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
  const link = ctx.db.human_link.web_identity.find(ctx.sender);
  return link ? link.human_identity : ctx.sender;
}

export function resolveHuman(ctx: Ctx): Identity {
  const link = ctx.db.human_link.web_identity.find(ctx.sender);
  return link ? link.human_identity : ctx.sender;
}

function callerIsAdmin(ctx: Ctx): boolean {
  const human = resolveHuman(ctx);
  return ctx.db.admin.human_identity.find(human) != null;
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
  return ctx.db.bot_credential.identity.find(ctx.sender)?.bot_id;
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
    team_id: 0n,
    is_simulated: true,
    strategy,
    created_at: ctx.timestamp,
  });
  const identity = identityFromClaims("sim", name);
  if (ctx.db.bot_credential.identity.find(identity) == null) {
    ctx.db.bot_credential.insert({
      identity,
      bot_id: bot.id,
      connected: true,
      last_seen: ctx.timestamp,
    });
  }
  console.info(`Seeded sim bot: ${name} (id ${bot.id})`);
  return { ok: bot.id };
}

export function generateNonceCode(ctx: Ctx): string {
  // Random 12-character alphanumeric code. Deterministic in transaction
  // via ctx.random. ~57 bits of entropy — fine for a single-use code with
  // short TTL.
  const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let n = 0; n < 12; n++) {
    out += CHARS[ctx.random.integerInRange(0, CHARS.length - 1)];
  }
  return out;
}

// ---------- Match control ----------
// Matches start via the lobby flow (see `join_lobby` /
// `lobby_timeout_tick`) or via the tournament code. There's no direct
// public reducer to spawn a one-off match.

// Starts a match and returns its id. Checks the whole roster before writing
// anything, so callers that discard the error aren't left with a half-built
// match.
export function startMatchWith(
  ctx: Ctx,
  auction_type: AuctionType,
  participants: bigint[],
): Result<bigint> {
  if (participants.length === 0) {
    return { err: "Need at least one participant" };
  }
  const missing = participants.find((id) => ctx.db.bot.id.find(id) == null);
  if (missing !== undefined) {
    return { err: `Unknown bot in roster: ${missing}` };
  }
  const bag_total = DEFAULT_BAG.reduce((sum, [, count]) => sum + count, 0);
  const inserted = ctx.db.match_state.insert({
    id: 0n,
    status: { tag: "Running" },
    current_round: 1,
    current_auction_id: undefined,
    bag_total,
    auction_type,
    created_at: ctx.timestamp,
    started_at: ctx.timestamp,
    ended_at: undefined,
  });
  const match_id = inserted.id;

  for (const bot_id of participants) {
    ctx.db.match_participant.insert({
      id: 0n,
      match_id,
      bot_id,
      balance: STARTING_BALANCE,
      score: 0n,
    });
  }

  for (const [letter, count] of DEFAULT_BAG) {
    ctx.db.bag_letter.insert({
      id: 0n,
      match_id,
      letter,
      remaining: count,
    });
  }

  // Deal each participant a starting rack from the bag. These tiles are
  // hidden from opponents (Holding is private) and only become derivable
  // when a bot plays a word with them.
  for (const bid of participants) {
    for (let n = 0; n < STARTING_RACK_SIZE; n++) {
      const letter = drawLetter(ctx, match_id);
      if (letter === undefined) {
        break;
      }
      addToRack(ctx, match_id, bid, letter);
    }
  }

  const first_letter = drawLetter(ctx, match_id);
  if (first_letter === undefined) {
    return { err: "Bag empty" };
  }
  const opens_at = ctx.timestamp;
  const closes_at = afterMillis(ctx.timestamp, AUCTION_DURATION_MS);
  const opened = ctx.db.auction.insert({
    id: 0n,
    match_id,
    letter: first_letter,
    opens_at,
    closes_at,
    status: { tag: "Open" },
  });

  const m = ctx.db.match_state.id.find(match_id)!;
  ctx.db.match_state.id.update({ ...m, current_auction_id: opened.id });

  ctx.db.auction_schedule.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(closes_at.microsSinceUnixEpoch),
    match_id,
  });

  simulateBids(ctx, opened);

  console.info(
    `Match ${match_id} started with ${participants.length} participants`,
  );
  return { ok: match_id };
}

// Add one `letter` tile to a bot's rack in a match.
function addToRack(ctx: Ctx, match_id: bigint, bot_id: bigint, letter: string) {
  const existing = [
    ...ctx.db.holding.holding_by_match_bot.filter([match_id, bot_id]),
  ].find((h) => h.letter === letter);
  if (existing) {
    ctx.db.holding.id.update({ ...existing, count: existing.count + 1 });
  } else {
    ctx.db.holding.insert({
      id: 0n,
      match_id,
      bot_id,
      letter,
      count: 1,
    });
  }
}

// ---------- Lobby ----------

export function botInRunningMatch(ctx: Ctx, bot_id: bigint): boolean {
  for (const p of ctx.db.match_participant.mp_by_bot.filter(bot_id)) {
    if (ctx.db.match_state.id.find(p.match_id)?.status.tag === "Running") {
      return true;
    }
  }
  return false;
}

// Returns the current open Lobby, creating one (and scheduling its timeout)
// if none is open.
export function openLobbyOrCreate(ctx: Ctx): Lobby {
  for (const l of ctx.db.lobby.lobby_by_status.filter({ tag: "Open" })) {
    return l;
  }
  const closes_at = afterSeconds(ctx.timestamp, LOBBY_DURATION_SECONDS);
  const lobby = ctx.db.lobby.insert({
    id: 0n,
    status: { tag: "Open" },
    opens_at: ctx.timestamp,
    closes_at,
    max_size: LOBBY_MAX_SIZE,
    auction_type: { tag: "Vickrey" },
    resolved_match_id: undefined,
  });
  ctx.db.lobby_timeout_schedule.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(closes_at.microsSinceUnixEpoch),
    lobby_id: lobby.id,
  });
  console.info(`Opened lobby ${lobby.id}`);
  return lobby;
}

// Resolve an open Lobby into a Match (when full or on timeout) and start a
// fresh lobby in its place. `padWithSims` adds idle simulated bots to
// reach max_size — only true for timeouts.
export function resolveLobby(ctx: Ctx, lobby_id: bigint, padWithSims: boolean) {
  const lobby = ctx.db.lobby.id.find(lobby_id);
  if (!lobby) {
    return;
  }
  if (lobby.status.tag !== "Open") {
    return; // already handled
  }

  // Skip members whose bot has since been deleted (its team dissolved),
  // or is being held for a tournament.
  const roster = [...ctx.db.lobby_member.lm_by_lobby.filter(lobby_id)]
    .map((m) => m.bot_id)
    .filter(
      (id) => ctx.db.bot.id.find(id) != null && !heldForTournament(ctx, id),
    );

  if (padWithSims) {
    // Sim bots are reusable — they're driven inside the module, so a
    // single Cheapo can play any number of concurrent matches (each
    // gets its own MatchParticipant / Holding rows). We just need to
    // avoid putting the same sim in *this* lobby twice.
    const inRoster = new Set(roster);
    const availableSims = [...ctx.db.bot.iter()]
      .filter((b) => b.is_simulated && !inRoster.has(b.id))
      .map((b) => b.id);
    // Shuffle so we don't always grab the same sim bots first.
    shuffle(ctx, availableSims);
    const need = Math.max(lobby.max_size - roster.length, 0);
    for (const sim_id of availableSims.slice(0, need)) {
      ctx.db.lobby_member.insert({
        id: 0n,
        lobby_id,
        bot_id: sim_id,
        joined_at: ctx.timestamp,
      });
      roster.push(sim_id);
    }
  }

  if (roster.length < 2) {
    // Not enough to play. Cancel and try again with a fresh lobby.
    ctx.db.lobby.id.update({ ...lobby, status: { tag: "Cancelled" } });
    console.warn(`Lobby ${lobby_id} cancelled (<2 participants)`);
    openLobbyOrCreate(ctx);
    return;
  }

  const started = startMatchWith(ctx, lobby.auction_type, roster);
  if (isErr(started)) {
    ctx.db.lobby.id.update({ ...lobby, status: { tag: "Cancelled" } });
    console.error(`Lobby ${lobby_id} cancelled: ${started.err}`);
  } else {
    ctx.db.lobby.id.update({
      ...lobby,
      status: { tag: "Resolved" },
      resolved_match_id: started.ok,
    });
    console.info(`Lobby ${lobby_id} resolved -> match ${started.ok}`);
  }

  openLobbyOrCreate(ctx);
}

// ---------- Match end ----------

export function onMatchEnded(ctx: Ctx, match_id: bigint) {
  // Move live top_bid rows into the public archive. Once a match ends,
  // bots can't act on the info, so it's safe to expose; and pruning the
  // private table keeps `visible_auction_top_bids` cheap to materialise.
  const live = [...ctx.db.auction_top_bid.top_bid_by_match.filter(match_id)];
  for (const top of live) {
    ctx.db.auction_top_bid_archive.insert({
      auction_id: top.auction_id,
      match_id: top.match_id,
      top_bid: top.top_bid,
    });
    ctx.db.auction_top_bid.auction_id.delete(top.auction_id);
  }

  updateEloAtMatchEnd(ctx, match_id);

  onTournamentMatchEnded(ctx, match_id);
}

// ---------- ELO ----------

function getOrInitStats(ctx: Ctx, bot_id: bigint): BotStats {
  return (
    ctx.db.bot_stats.bot_id.find(bot_id) ?? {
      bot_id,
      rating: 1000,
      openskill_mu: 25.0,
      openskill_sigma: 25.0 / 3.0,
      matches_played: 0,
      wins: 0,
      total_score: 0n,
      last_played: undefined,
    }
  );
}

function outcome(mine: bigint, theirs: bigint): Outcome {
  return mine > theirs ? "WIN" : mine < theirs ? "LOSS" : "DRAW";
}

export function updateEloAtMatchEnd(ctx: Ctx, match_id: bigint) {
  const placed = [...ctx.db.match_participant.mp_by_match.filter(match_id)];
  if (placed.length < 2) {
    return;
  }
  sortDescending(placed, (p) => p.score);

  // Snapshot all ratings before any updates
  const snapshots = placed.map((p) => getOrInitStats(ctx, p.bot_id));
  const preElo: EloRating[] = snapshots.map((s) => ({ rating: s.rating }));
  const preWl: WengLinRating[] = snapshots.map((s) => ({
    rating: s.openskill_mu,
    uncertainty: s.openskill_sigma,
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

    const existing = getOrInitStats(ctx, p.bot_id);
    // Everyone tied on the top score shares the win.
    const wasWin = p.score === placed[0]!.score;
    const stats: BotStats = {
      ...existing,
      rating: newRating,
      openskill_mu: newWl.rating,
      openskill_sigma: newWl.uncertainty,
      matches_played: existing.matches_played + 1,
      wins: existing.wins + (wasWin ? 1 : 0),
      total_score: existing.total_score + p.score,
      last_played: ctx.timestamp,
    };
    if (ctx.db.bot_stats.bot_id.find(p.bot_id) != null) {
      ctx.db.bot_stats.bot_id.update(stats);
    } else {
      ctx.db.bot_stats.insert(stats);
    }
  });
}

// Ended matches in the order they ended, those with no end time first.
export function endedMatchesInOrder(ctx: Ctx): Match[] {
  return [...ctx.db.match_state.iter()]
    .filter((m) => m.status.tag === "Ended")
    .sort((a, b) => {
      const ka = a.ended_at?.microsSinceUnixEpoch;
      const kb = b.ended_at?.microsSinceUnixEpoch;
      if (ka === kb) return 0;
      if (ka === undefined) return -1;
      if (kb === undefined) return 1;
      return ka < kb ? -1 : 1;
    });
}

// ---------- Auction close ----------

export function closeAuction(ctx: Ctx, match_id: bigint) {
  const m = ctx.db.match_state.id.find(match_id);
  if (!m || m.status.tag !== "Running") {
    return;
  }
  const auction_id = m.current_auction_id;
  if (auction_id === undefined) {
    return;
  }
  const auction = ctx.db.auction.id.find(auction_id);
  if (!auction) {
    return;
  }

  const bids = [...ctx.db.pending_bid.bid_by_auction.filter(auction_id)];
  const sorted = bids.filter((b) => b.amount > 0n);
  // Shuffle, then stable-sort by amount, so equal bids land in random
  // order and ties don't always go to whoever bid first.
  shuffle(ctx, sorted);
  sortDescending(sorted, (b) => b.amount);

  let winner: bigint | undefined;
  let top_bid = 0n;
  let paid = 0n;
  const [first, second] = sorted;
  if (first) {
    winner = first.bidder_bot_id;
    top_bid = first.amount;
    if (m.auction_type.tag === "FirstPrice") {
      paid = first.amount;
    } else {
      paid = second ? second.amount : minBig(AUCTION_RESERVE, first.amount);
    }
  }

  let simWinner: bigint | undefined;
  if (winner !== undefined) {
    const participant = findParticipant(ctx, match_id, winner);
    if (participant && participant.balance >= paid) {
      const botIsSim = ctx.db.bot.id.find(winner)?.is_simulated ?? false;
      ctx.db.match_participant.id.update({
        ...participant,
        balance: participant.balance - paid,
      });
      addToRack(ctx, match_id, winner, auction.letter);
      if (botIsSim) {
        simWinner = winner;
      }
    }
  }

  ctx.db.auction_result.insert({
    auction_id,
    match_id,
    letter: auction.letter,
    winner_bot_id: winner,
    paid,
    closed_at: ctx.timestamp,
  });
  // Spectator-visible mirror of the winning bid (gated through the
  // `visible_auction_top_bids` view so bots can't see it).
  ctx.db.auction_top_bid.insert({
    auction_id,
    match_id,
    top_bid,
    visible: true,
  });
  ctx.db.auction.id.update({ ...auction, status: { tag: "Closed" } });
  for (const b of bids) {
    ctx.db.pending_bid.id.delete(b.id);
  }

  if (simWinner !== undefined) {
    simulateWordPlay(ctx, match_id, simWinner);
  }

  const m2 = ctx.db.match_state.id.find(match_id)!;
  const next_letter = drawLetter(ctx, match_id);
  if (next_letter === undefined) {
    ctx.db.match_state.id.update({
      ...m2,
      status: { tag: "Ended" },
      current_auction_id: undefined,
      ended_at: ctx.timestamp,
    });
    console.info(`Match ${match_id} ended (bag empty)`);
    onMatchEnded(ctx, match_id);
    return;
  }

  const opens_at = ctx.timestamp;
  const closes_at = afterMillis(ctx.timestamp, AUCTION_DURATION_MS);
  const next_auction = ctx.db.auction.insert({
    id: 0n,
    match_id,
    letter: next_letter,
    opens_at,
    closes_at,
    status: { tag: "Open" },
  });

  const m3 = ctx.db.match_state.id.find(match_id)!;
  ctx.db.match_state.id.update({
    ...m3,
    current_round: m3.current_round + 1,
    current_auction_id: next_auction.id,
  });
  ctx.db.auction_schedule.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(closes_at.microsSinceUnixEpoch),
    match_id,
  });

  simulateBids(ctx, next_auction);
}

// ---------- Helpers ----------

export function findParticipant(
  ctx: Ctx,
  match_id: bigint,
  bot_id: bigint,
): MatchParticipant | undefined {
  return [...ctx.db.match_participant.mp_by_match.filter(match_id)].find(
    (p) => p.bot_id === bot_id,
  );
}

export function playWord(
  ctx: Ctx,
  participant: MatchParticipant,
  word_upper: string,
): Result<void> {
  const match_id = participant.match_id;
  const bot_id = participant.bot_id;

  const needed = new Map<string, number>();
  for (const c of word_upper) {
    needed.set(c, (needed.get(c) ?? 0) + 1);
  }

  const holdings = [
    ...ctx.db.holding.holding_by_match_bot.filter([match_id, bot_id]),
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

  let base_score = 0n;
  for (const c of word_upper) {
    base_score += BigInt(letterValue(c));
  }
  const [num, denom] = lengthMultiplier(word_upper.length);
  const total_reward = (base_score * num) / denom;
  const bonus = total_reward - base_score;

  ctx.db.match_participant.id.update({
    ...participant,
    balance: participant.balance + total_reward,
    score: participant.score + total_reward,
  });

  ctx.db.word_play.insert({
    id: 0n,
    match_id,
    bot_id,
    word: word_upper,
    base_score,
    bonus,
    total_reward,
    played_at: ctx.timestamp,
  });

  console.info(
    `[match ${match_id}] '${word_upper}' played: base=${base_score}, bonus=${bonus}, total=${total_reward}`,
  );
  return { ok: undefined };
}

export function drawLetter(ctx: Ctx, match_id: bigint): string | undefined {
  const m = ctx.db.match_state.id.find(match_id);
  if (!m) {
    return undefined;
  }
  if (m.bag_total === 0) {
    return undefined;
  }
  let idx = ctx.random.integerInRange(0, m.bag_total - 1);
  const entries = [...ctx.db.bag_letter.bag_by_match.filter(match_id)]
    .filter((b) => b.remaining > 0)
    .sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0));
  for (const bag of entries) {
    if (idx < bag.remaining) {
      ctx.db.bag_letter.id.update({ ...bag, remaining: bag.remaining - 1 });
      ctx.db.match_state.id.update({ ...m, bag_total: m.bag_total - 1 });
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
    ...ctx.db.match_participant.mp_by_match.filter(auction.match_id),
  ];
  for (const p of participants) {
    const bot = ctx.db.bot.id.find(p.bot_id);
    if (!bot) {
      continue;
    }
    if (!bot.is_simulated) {
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

// Record `bot_id`'s bid on an auction, replacing any earlier one.
export function replaceBid(
  ctx: Ctx,
  auction_id: bigint,
  bot_id: bigint,
  amount: bigint,
) {
  const prior: PendingBid[] = [
    ...ctx.db.pending_bid.bid_by_auction.filter(auction_id),
  ].filter((b) => b.bidder_bot_id === bot_id);
  for (const b of prior) {
    ctx.db.pending_bid.id.delete(b.id);
  }
  ctx.db.pending_bid.insert({
    id: 0n,
    auction_id,
    bidder_bot_id: bot_id,
    amount,
    submitted_at: ctx.timestamp,
  });
}

function simulateWordPlay(ctx: Ctx, match_id: bigint, bot_id: bigint) {
  const participant = findParticipant(ctx, match_id, bot_id);
  if (!participant) {
    return;
  }
  const holdings: Holding[] = [
    ...ctx.db.holding.holding_by_match_bot.filter([match_id, bot_id]),
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
