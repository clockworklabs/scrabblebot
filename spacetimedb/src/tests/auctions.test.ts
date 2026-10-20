// Starting matches, bidding, closing auctions and running out the bag.

import { ScheduleAt, TimeDuration } from "spacetimedb";
import { expect, test } from "vitest";
import {
  afterMillis,
  AUCTION_DURATION_MS,
  AUCTION_RESERVE,
  decideBid,
  SIM_BID_JITTER,
  startMatchWith,
  STARTING_BALANCE,
  STARTING_RACK_SIZE,
} from "../game";
import { auction_tick, submit_bid } from "../index";
import type { AuctionResult, AuctionType } from "../schema";
import {
  auctionJob,
  botNamed,
  byBigint,
  call,
  currentAuction,
  failure,
  FIRST_PRICE,
  getMatch,
  internal,
  newDb,
  now,
  participant,
  rack,
  runToEnd,
  setRack,
  simIds,
  startMatch,
  teamWithBot,
  tick,
  VICKREY,
  type Test,
} from "./harness";

/** Three real (Human-strategy) bots, so nobody bids unless a test says so. */
function threeBots(db: Test): [bigint, bigint, bigint] {
  return [
    teamWithBot(db, "alice", "Ann"),
    teamWithBot(db, "bob", "Ben"),
    teamWithBot(db, "carol", "Cat"),
  ];
}

function bid(db: Test, bot: string, auction_id: bigint, amount: bigint) {
  call(db, bot, (tx) => submit_bid(tx, { auction_id, amount }));
}

function bidsOn(db: Test, auctionId: bigint): [bigint, bigint][] {
  return [...db.db.pending_bid.bid_by_auction.filter(auctionId)]
    .map((b): [bigint, bigint] => [b.bidder_bot_id, b.amount])
    .sort(([a, an], [b, bn]) => byBigint(a, b) || byBigint(an, bn));
}

function resultOf(db: Test, auctionId: bigint): AuctionResult {
  return db.db.auction_result.auction_id.find(auctionId)!;
}

function holds(
  db: Test,
  matchId: bigint,
  botId: bigint,
  letter: string,
): number {
  return rack(db, matchId, botId).find(([l]) => l === letter)?.[1] ?? 0;
}

test("starting_a_match_deals_racks_and_opens_the_first_auction", () => {
  const db = newDb();
  const bots = threeBots(db);
  const m = startMatch(db, VICKREY, bots);

  const state = getMatch(db, m);
  expect(state.status.tag).toBe("Running");
  expect(state.current_round).toBe(1);
  expect(state.started_at).toEqual(now());
  const dealt = bots.length * STARTING_RACK_SIZE;
  expect(state.bag_total).toBe(98 - dealt - 1);
  const inBag = [...db.db.bag_letter.bag_by_match.filter(m)].reduce(
    (sum, b) => sum + b.remaining,
    0,
  );
  expect(inBag, "bag rows agree with bag_total").toBe(state.bag_total);

  for (const bot of bots) {
    const p = participant(db, m, bot);
    expect([p.balance, p.score]).toEqual([STARTING_BALANCE, 0n]);
    const tiles = rack(db, m, bot).reduce((sum, [, n]) => sum + n, 0);
    expect(tiles).toBe(STARTING_RACK_SIZE);
  }

  const auction = currentAuction(db, m);
  expect(auction.status.tag).toBe("Open");
  expect(auction.closes_at).toEqual(afterMillis(now(), AUCTION_DURATION_MS));
  const schedule = [...db.db.auction_schedule.iter()].filter(
    (s) => s.match_id === m,
  );
  expect(schedule.length).toBe(1);
  expect(schedule[0]!.scheduled_at).toEqual(
    ScheduleAt.time(auction.closes_at.microsSinceUnixEpoch),
  );
});

test("starting_a_match_with_an_unknown_bot_writes_nothing", () => {
  const db = newDb();
  const sim = simIds(db)[0]!;
  // Ignore the error and commit, as a careless caller might: the roster is
  // checked before anything is written, so there's nothing to roll back.
  const result = internal(db, (tx) =>
    startMatchWith(tx, VICKREY, [sim, 9999n]),
  );
  expect(result).toEqual({ err: "Unknown bot in roster: 9999" });
  expect(db.db.match_state.count()).toBe(0n);
  expect(db.db.match_participant.count()).toBe(0n);
  expect(db.db.bag_letter.count()).toBe(0n);
});

test("sims_bid_as_soon_as_an_auction_opens", () => {
  const db = newDb();
  const sims = simIds(db);
  const m = startMatch(db, VICKREY, sims);
  const auction = currentAuction(db, m);
  const bids = bidsOn(db, auction.id);
  expect(bids.length).toBe(sims.length);
  for (const [botId, amount] of bids) {
    const strategy = db.db.bot.id.find(botId)!.strategy;
    const bidWith = (jitter: bigint) =>
      decideBid(strategy, auction.letter, STARTING_BALANCE, jitter);
    const [lo, hi] = [bidWith(-SIM_BID_JITTER), bidWith(SIM_BID_JITTER)];
    expect(
      amount >= lo && amount <= hi,
      `${strategy.tag} bid ${amount}, outside ${lo}..=${hi}`,
    ).toBe(true);
  }
});

test("bids_are_validated", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;

  expect(failure(() => bid(db, "Ann", a, -1n))).toBe(
    "Bid must be non-negative",
  );
  expect(failure(() => bid(db, "stranger", a, 1n))).toBe(
    "Your identity is not a credential for any bot",
  );
  expect(failure(() => bid(db, "Ann", 9999n, 1n))).toBe("Unknown auction");
  expect(failure(() => bid(db, "Cat", a, 1n))).toBe("Not in this match");
  expect(failure(() => bid(db, "Ann", a, STARTING_BALANCE + 1n))).toBe(
    "Insufficient balance",
  );
  expect(bidsOn(db, a)).toEqual([]);

  bid(db, "Ann", a, STARTING_BALANCE);
  bid(db, "Ann", a, 0n);
});

test("bids_close_with_the_auction_window", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;

  db.clock.set(afterMillis(now(), AUCTION_DURATION_MS));
  expect(failure(() => bid(db, "Ann", a, 1n))).toBe("Auction window expired");

  tick(db, m);
  expect(failure(() => bid(db, "Ann", a, 1n))).toBe("Auction closed");
});

test("a_new_bid_replaces_the_old_one", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;

  bid(db, "Ann", a, 5n);
  bid(db, "Ben", a, 3n);
  bid(db, "Ann", a, 2n);

  const expected: [bigint, bigint][] = [
    [ann, 2n],
    [ben, 3n],
  ];
  expected.sort(([a1], [b1]) => byBigint(a1, b1));
  expect(bidsOn(db, a)).toEqual(expected);
});

test("vickrey_winner_pays_the_second_highest_bid", () => {
  const db = newDb();
  const [ann, ben, cat] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben, cat]);
  const auction = currentAuction(db, m);
  const had = holds(db, m, ben, auction.letter);

  bid(db, "Ann", auction.id, 4n);
  bid(db, "Ben", auction.id, 9n);
  bid(db, "Cat", auction.id, 6n);
  tick(db, m);

  const r = resultOf(db, auction.id);
  expect([r.winner_bot_id, r.paid]).toEqual([ben, 6n]);
  expect(participant(db, m, ben).balance).toBe(STARTING_BALANCE - 6n);
  expect(participant(db, m, ann).balance).toBe(STARTING_BALANCE);
  expect(holds(db, m, ben, auction.letter)).toBe(had + 1);
  const top = db.db.auction_top_bid.auction_id.find(auction.id)!;
  expect(top.top_bid).toBe(9n);
});

test("a_lone_vickrey_bidder_pays_the_reserve", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;

  bid(db, "Ann", a, 20n);
  tick(db, m);

  expect(resultOf(db, a).paid).toBe(AUCTION_RESERVE);
  expect(participant(db, m, ann).balance).toBe(
    STARTING_BALANCE - AUCTION_RESERVE,
  );
});

test("first_price_winner_pays_their_own_bid", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, FIRST_PRICE, [ann, ben]);
  const a = currentAuction(db, m).id;

  bid(db, "Ann", a, 3n);
  bid(db, "Ben", a, 8n);
  tick(db, m);

  const r = resultOf(db, a);
  expect([r.winner_bot_id, r.paid]).toEqual([ben, 8n]);
  expect(participant(db, m, ben).balance).toBe(STARTING_BALANCE - 8n);
});

test("ties_are_broken_at_random", () => {
  for (const auctionType of [VICKREY, FIRST_PRICE] as AuctionType[]) {
    const db = newDb();
    const [ann, ben] = threeBots(db);
    const m = startMatch(db, auctionType, [ann, ben]);

    const winners = new Set<bigint>();
    for (let i = 0; i < 20; i++) {
      const a = currentAuction(db, m).id;
      bid(db, "Ben", a, 1n);
      bid(db, "Ann", a, 1n);
      db.clock.advance(new TimeDuration(AUCTION_DURATION_MS * 1000n));
      tick(db, m);

      const r = resultOf(db, a);
      expect(r.paid, auctionType.tag).toBe(1n);
      winners.add(r.winner_bot_id!);
    }
    expect(
      [...winners].sort(byBigint),
      `${auctionType.tag}: both tied bidders win sometimes`,
    ).toEqual([ann, ben].sort(byBigint));
  }
});

test("an_auction_with_no_positive_bids_goes_unsold", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;

  bid(db, "Ann", a, 0n);
  tick(db, m);

  const r = resultOf(db, a);
  expect([r.winner_bot_id, r.paid]).toEqual([undefined, 0n]);
  expect(participant(db, m, ann).balance).toBe(STARTING_BALANCE);
});

test("closing_an_auction_opens_the_next_one", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  const first = currentAuction(db, m);
  const bagBefore = getMatch(db, m).bag_total;
  bid(db, "Ann", first.id, 2n);

  db.clock.set(first.closes_at);
  tick(db, m);

  expect(db.db.auction.id.find(first.id)!.status.tag).toBe("Closed");
  expect(bidsOn(db, first.id), "pending bids are cleared").toEqual([]);
  const state = getMatch(db, m);
  expect(state.current_round).toBe(2);
  expect(state.bag_total).toBe(bagBefore - 1);
  const next = currentAuction(db, m);
  expect(next.id).not.toBe(first.id);
  expect(next.status.tag).toBe("Open");
  expect(next.opens_at).toEqual(first.closes_at);
  expect(
    [...db.db.auction_schedule.iter()].some(
      (s) =>
        s.match_id === m &&
        s.scheduled_at.tag === "Time" &&
        s.scheduled_at.value.microsSinceUnixEpoch ===
          next.closes_at.microsSinceUnixEpoch,
    ),
  ).toBe(true);
});

test("ticks_for_finished_or_unknown_matches_do_nothing", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  runToEnd(db, m);
  const results = db.db.auction_result.count();

  tick(db, m);
  tick(db, 9999n);

  expect(db.db.auction_result.count()).toBe(results);
});

test("a_sim_that_wins_a_letter_plays_its_best_word", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const valor = botNamed(db, "Valor-sim").id;
  const m = startMatch(db, VICKREY, [ann, valor]);
  const auction = currentAuction(db, m);
  setRack(db, m, valor, "CA");
  db.db.auction.id.update({ ...auction, letter: "T" });
  db.db.pending_bid.insert({
    id: 0n,
    auction_id: auction.id,
    bidder_bot_id: valor,
    amount: 1n,
    submitted_at: now(),
  });

  tick(db, m);

  const plays = [...db.db.word_play.play_by_bot.filter(valor)];
  expect(plays.length).toBe(1);
  expect(["ACT", "CAT"]).toContain(plays[0]!.word);
  expect(rack(db, m, valor)).toEqual([]);
  expect(participant(db, m, valor).score).toBe(5n);
});

test("a_match_ends_when_the_bag_is_empty", () => {
  const db = newDb();
  const sims = simIds(db);
  const m = startMatch(db, VICKREY, sims);
  const ticks = runToEnd(db, m);

  const dealt = sims.length * STARTING_RACK_SIZE;
  expect(ticks, "one auction per remaining tile").toBe(98 - dealt);
  const state = getMatch(db, m);
  expect(state.status.tag).toBe("Ended");
  expect(state.ended_at).toEqual(db.clock.now());
  expect(state.current_auction_id).toBeUndefined();
  expect(state.bag_total).toBe(0);
  expect(
    [...db.db.auction.auction_by_match.filter(m)].every(
      (a) => a.status.tag === "Closed",
    ),
  ).toBe(true);
});

test("every_tile_is_accounted_for_at_the_end_of_a_match", () => {
  const db = newDb();
  const sims = simIds(db);
  const m = startMatch(db, VICKREY, sims);
  runToEnd(db, m);

  const held = [...db.db.holding.holding_by_match.filter(m)].reduce(
    (s, h) => s + h.count,
    0,
  );
  const played = [...db.db.word_play.play_by_match.filter(m)].reduce(
    (s, w) => s + w.word.length,
    0,
  );
  const unsold = [...db.db.auction_result.result_by_match.filter(m)].filter(
    (r) => r.winner_bot_id === undefined,
  ).length;
  expect(held + played + unsold).toBe(98);
  expect(played, "sims should have played some words").toBeGreaterThan(0);
});

test("balances_equal_start_minus_spend_plus_score", () => {
  const db = newDb();
  const sims = simIds(db);
  const m = startMatch(db, FIRST_PRICE, sims);
  runToEnd(db, m);

  for (const bot of sims) {
    const spent = [...db.db.auction_result.result_by_match.filter(m)]
      .filter((r) => r.winner_bot_id === bot)
      .reduce((s, r) => s + r.paid, 0n);
    const p = participant(db, m, bot);
    expect(p.balance, `bot ${bot}`).toBe(STARTING_BALANCE - spent + p.score);
    expect(p.balance >= 0n).toBe(true);
    const rewards = [...db.db.word_play.play_by_match.filter(m)]
      .filter((w) => w.bot_id === bot)
      .reduce((s, w) => s + w.total_reward, 0n);
    expect(p.score).toBe(rewards);
  }
});

test("ending_a_match_publishes_its_top_bids", () => {
  const db = newDb();
  const sims = simIds(db);
  const m = startMatch(db, VICKREY, sims);
  runToEnd(db, m);

  expect([...db.db.auction_top_bid.top_bid_by_match.filter(m)].length).toBe(0);
  const archived = [...db.db.auction_top_bid_archive.archive_by_match.filter(m)]
    .length;
  expect(archived).toBe(
    [...db.db.auction_result.result_by_match.filter(m)].length,
  );
});

test("matches_are_deterministic_for_a_given_seed", () => {
  const play = () => {
    const db = newDb();
    const m = startMatch(db, VICKREY, simIds(db));
    runToEnd(db, m);
    return [...db.db.word_play.iter()]
      .map((w) => [w.id, w.bot_id, w.word] as const)
      .sort(([a], [b]) => byBigint(a, b));
  };
  expect(play()).toEqual(play());
});

test("clients_cannot_close_an_auction_early", () => {
  const db = newDb();
  const [ann, ben] = threeBots(db);
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;
  const err = failure(() =>
    call(db, "Ann", (tx) => auction_tick(tx, { job: auctionJob(m) })),
  );
  expect(err).toBe("Only the scheduler may call this");
  expect(db.db.auction.id.find(a)!.status.tag).toBe("Open");
});
