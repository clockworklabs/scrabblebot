// Starting matches, bidding, closing auctions and running out the bag.

use super::*;

/// Three real (Human-strategy) bots, so nobody bids unless a test says so.
fn three_bots(ctx: &TestContext) -> [u64; 3] {
    [
        team_with_bot(ctx, "alice", "Ann"),
        team_with_bot(ctx, "bob", "Ben"),
        team_with_bot(ctx, "carol", "Cat"),
    ]
}

fn bid(ctx: &TestContext, bot: &str, auction_id: u64, amount: i64) -> Result<(), String> {
    call(ctx, bot, |tx| submit_bid(tx, auction_id, amount))
}

fn bids_on(ctx: &TestContext, auction_id: u64) -> Vec<(u64, i64)> {
    let mut b: Vec<_> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(auction_id)
        .map(|b| (b.bidder_bot_id, b.amount))
        .collect();
    b.sort();
    b
}

fn result_of(ctx: &TestContext, auction_id: u64) -> AuctionResult {
    ctx.db
        .auction_result()
        .auction_id()
        .find(auction_id)
        .unwrap()
}

fn holds(ctx: &TestContext, match_id: u64, bot_id: u64, letter: &str) -> u32 {
    rack(ctx, match_id, bot_id)
        .into_iter()
        .find(|(l, _)| l == letter)
        .map_or(0, |(_, n)| n)
}

#[test]
fn starting_a_match_deals_racks_and_opens_the_first_auction() {
    let ctx = new_db();
    let bots = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &bots);

    let state = get_match(&ctx, m);
    assert_eq!(state.status, MatchStatus::Running);
    assert_eq!(state.current_round, 1);
    assert_eq!(state.started_at, Some(now()));
    let dealt = bots.len() as u32 * STARTING_RACK_SIZE;
    assert_eq!(state.bag_total, 98 - dealt - 1);
    let in_bag: u32 = ctx
        .db
        .bag_letter()
        .bag_by_match()
        .filter(m)
        .map(|b| b.remaining)
        .sum();
    assert_eq!(in_bag, state.bag_total, "bag rows agree with bag_total");

    for bot in bots {
        let p = participant(&ctx, m, bot);
        assert_eq!((p.balance, p.score), (STARTING_BALANCE, 0));
        let tiles: u32 = rack(&ctx, m, bot).iter().map(|(_, n)| n).sum();
        assert_eq!(tiles, STARTING_RACK_SIZE);
    }

    let auction = current_auction(&ctx, m);
    assert_eq!(auction.status, AuctionStatus::Open);
    assert_eq!(
        auction.closes_at,
        now() + Duration::from_millis(AUCTION_DURATION_MS)
    );
    let schedule: Vec<_> = ctx
        .db
        .auction_schedule()
        .iter()
        .filter(|s| s.match_id == m)
        .collect();
    assert_eq!(schedule.len(), 1);
    assert_eq!(
        schedule[0].scheduled_at,
        ScheduleAt::Time(auction.closes_at)
    );
}

#[test]
fn starting_a_match_with_an_unknown_bot_fails_cleanly() {
    let ctx = new_db();
    let err = internal(&ctx, |tx| {
        start_match_with(tx, AuctionType::Vickrey, vec![9999])
    })
    .unwrap_err();
    assert_eq!(err, "Unknown bot in roster: 9999");
    assert_eq!(ctx.db.match_state().count(), 0);
    assert_eq!(ctx.db.bag_letter().count(), 0);
}

#[test]
fn sims_bid_as_soon_as_an_auction_opens() {
    let ctx = new_db();
    let sims = sim_ids(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &sims);
    let auction = current_auction(&ctx, m);
    let bids = bids_on(&ctx, auction.id);
    assert_eq!(bids.len(), sims.len());
    for (bot_id, amount) in bids {
        let strategy = ctx.db.bot().id().find(bot_id).unwrap().strategy;
        assert_eq!(
            amount,
            decide_bid(&strategy, &auction.letter, STARTING_BALANCE)
        );
    }
}

#[test]
fn bids_are_validated() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let a = current_auction(&ctx, m).id;

    assert_eq!(
        bid(&ctx, "Ann", a, -1),
        Err("Bid must be non-negative".into())
    );
    assert_eq!(
        bid(&ctx, "stranger", a, 1),
        Err("Your identity is not a credential for any bot".into())
    );
    assert_eq!(bid(&ctx, "Ann", 9999, 1), Err("Unknown auction".into()));
    assert_eq!(bid(&ctx, "Cat", a, 1), Err("Not in this match".into()));
    assert_eq!(
        bid(&ctx, "Ann", a, STARTING_BALANCE + 1),
        Err("Insufficient balance".into())
    );
    assert!(bids_on(&ctx, a).is_empty());

    bid(&ctx, "Ann", a, STARTING_BALANCE).unwrap();
    bid(&ctx, "Ann", a, 0).unwrap();
}

#[test]
fn bids_close_with_the_auction_window() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let a = current_auction(&ctx, m).id;

    ctx.clock
        .set(now() + Duration::from_millis(AUCTION_DURATION_MS));
    assert_eq!(bid(&ctx, "Ann", a, 1), Err("Auction window expired".into()));

    tick(&ctx, m);
    assert_eq!(bid(&ctx, "Ann", a, 1), Err("Auction closed".into()));
}

#[test]
fn a_new_bid_replaces_the_old_one() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let a = current_auction(&ctx, m).id;

    bid(&ctx, "Ann", a, 5).unwrap();
    bid(&ctx, "Ben", a, 3).unwrap();
    bid(&ctx, "Ann", a, 2).unwrap();

    let mut expected = vec![(ann, 2), (ben, 3)];
    expected.sort();
    assert_eq!(bids_on(&ctx, a), expected);
}

#[test]
fn vickrey_winner_pays_the_second_highest_bid() {
    let ctx = new_db();
    let [ann, ben, cat] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben, cat]);
    let auction = current_auction(&ctx, m);
    let had = holds(&ctx, m, ben, &auction.letter);

    bid(&ctx, "Ann", auction.id, 4).unwrap();
    bid(&ctx, "Ben", auction.id, 9).unwrap();
    bid(&ctx, "Cat", auction.id, 6).unwrap();
    tick(&ctx, m);

    let r = result_of(&ctx, auction.id);
    assert_eq!((r.winner_bot_id, r.paid), (Some(ben), 6));
    assert_eq!(participant(&ctx, m, ben).balance, STARTING_BALANCE - 6);
    assert_eq!(participant(&ctx, m, ann).balance, STARTING_BALANCE);
    assert_eq!(holds(&ctx, m, ben, &auction.letter), had + 1);
    let top = ctx
        .db
        .auction_top_bid()
        .auction_id()
        .find(auction.id)
        .unwrap();
    assert_eq!(top.top_bid, 9);
}

#[test]
fn a_lone_vickrey_bidder_pays_the_reserve() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let a = current_auction(&ctx, m).id;

    bid(&ctx, "Ann", a, 20).unwrap();
    tick(&ctx, m);

    assert_eq!(result_of(&ctx, a).paid, AUCTION_RESERVE);
    assert_eq!(
        participant(&ctx, m, ann).balance,
        STARTING_BALANCE - AUCTION_RESERVE
    );
}

#[test]
fn first_price_winner_pays_their_own_bid() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::FirstPrice, &[ann, ben]);
    let a = current_auction(&ctx, m).id;

    bid(&ctx, "Ann", a, 3).unwrap();
    bid(&ctx, "Ben", a, 8).unwrap();
    tick(&ctx, m);

    let r = result_of(&ctx, a);
    assert_eq!((r.winner_bot_id, r.paid), (Some(ben), 8));
    assert_eq!(participant(&ctx, m, ben).balance, STARTING_BALANCE - 8);
}

#[test]
fn ties_go_to_the_earliest_bid() {
    for auction_type in [AuctionType::Vickrey, AuctionType::FirstPrice] {
        let ctx = new_db();
        let [ann, ben, _] = three_bots(&ctx);
        let m = start_match(&ctx, auction_type.clone(), &[ann, ben]);
        let a = current_auction(&ctx, m).id;

        bid(&ctx, "Ben", a, 5).unwrap();
        bid(&ctx, "Ann", a, 5).unwrap();
        tick(&ctx, m);

        let r = result_of(&ctx, a);
        assert_eq!(
            (r.winner_bot_id, r.paid),
            (Some(ben), 5),
            "{auction_type:?}"
        );
    }
}

#[test]
fn an_auction_with_no_positive_bids_goes_unsold() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let a = current_auction(&ctx, m).id;

    bid(&ctx, "Ann", a, 0).unwrap();
    tick(&ctx, m);

    let r = result_of(&ctx, a);
    assert_eq!((r.winner_bot_id, r.paid), (None, 0));
    assert_eq!(participant(&ctx, m, ann).balance, STARTING_BALANCE);
}

#[test]
fn closing_an_auction_opens_the_next_one() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let first = current_auction(&ctx, m);
    let bag_before = get_match(&ctx, m).bag_total;
    bid(&ctx, "Ann", first.id, 2).unwrap();

    ctx.clock.set(first.closes_at);
    tick(&ctx, m);

    assert_eq!(
        ctx.db.auction().id().find(first.id).unwrap().status,
        AuctionStatus::Closed
    );
    assert!(
        bids_on(&ctx, first.id).is_empty(),
        "pending bids are cleared"
    );
    let state = get_match(&ctx, m);
    assert_eq!(state.current_round, 2);
    assert_eq!(state.bag_total, bag_before - 1);
    let next = current_auction(&ctx, m);
    assert_ne!(next.id, first.id);
    assert_eq!(next.status, AuctionStatus::Open);
    assert_eq!(next.opens_at, first.closes_at);
    assert!(
        ctx.db
            .auction_schedule()
            .iter()
            .any(|s| s.match_id == m && s.scheduled_at == ScheduleAt::Time(next.closes_at))
    );
}

#[test]
fn ticks_for_finished_or_unknown_matches_do_nothing() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    run_to_end(&ctx, m);
    let results = ctx.db.auction_result().count();

    tick(&ctx, m);
    tick(&ctx, 9999);

    assert_eq!(ctx.db.auction_result().count(), results);
}

#[test]
fn a_sim_that_wins_a_letter_plays_its_best_word() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    let valor = bot_named(&ctx, "Valor-sim").id;
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, valor]);
    let auction = current_auction(&ctx, m);
    set_rack(&ctx, m, valor, "CA");
    ctx.db.auction().id().update(Auction {
        letter: "T".into(),
        ..auction.clone()
    });
    ctx.db.pending_bid().insert(PendingBid {
        id: 0,
        auction_id: auction.id,
        bidder_bot_id: valor,
        amount: 1,
        submitted_at: now(),
    });

    tick(&ctx, m);

    let plays: Vec<WordPlay> = ctx.db.word_play().play_by_bot().filter(valor).collect();
    assert_eq!(plays.len(), 1);
    assert!(["ACT", "CAT"].contains(&plays[0].word.as_str()));
    assert!(rack(&ctx, m, valor).is_empty());
    assert_eq!(participant(&ctx, m, valor).score, 5);
}

#[test]
fn a_match_ends_when_the_bag_is_empty() {
    let ctx = new_db();
    let sims = sim_ids(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &sims);
    let ticks = run_to_end(&ctx, m);

    let dealt = sims.len() * STARTING_RACK_SIZE as usize;
    assert_eq!(ticks, 98 - dealt, "one auction per remaining tile");
    let state = get_match(&ctx, m);
    assert_eq!(state.status, MatchStatus::Ended);
    assert_eq!(state.ended_at, Some(ctx.clock.now()));
    assert_eq!(state.current_auction_id, None);
    assert_eq!(state.bag_total, 0);
    assert!(
        ctx.db
            .auction()
            .auction_by_match()
            .filter(m)
            .all(|a| a.status == AuctionStatus::Closed)
    );
}

#[test]
fn every_tile_is_accounted_for_at_the_end_of_a_match() {
    let ctx = new_db();
    let sims = sim_ids(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &sims);
    run_to_end(&ctx, m);

    let held: u32 = ctx
        .db
        .holding()
        .holding_by_match()
        .filter(m)
        .map(|h| h.count)
        .sum();
    let played: usize = ctx
        .db
        .word_play()
        .play_by_match()
        .filter(m)
        .map(|w| w.word.len())
        .sum();
    let unsold = ctx
        .db
        .auction_result()
        .result_by_match()
        .filter(m)
        .filter(|r| r.winner_bot_id.is_none())
        .count();
    assert_eq!(held as usize + played + unsold, 98);
    assert!(played > 0, "sims should have played some words");
}

#[test]
fn balances_equal_start_minus_spend_plus_score() {
    let ctx = new_db();
    let sims = sim_ids(&ctx);
    let m = start_match(&ctx, AuctionType::FirstPrice, &sims);
    run_to_end(&ctx, m);

    for bot in sims {
        let spent: i64 = ctx
            .db
            .auction_result()
            .result_by_match()
            .filter(m)
            .filter(|r| r.winner_bot_id == Some(bot))
            .map(|r| r.paid)
            .sum();
        let p = participant(&ctx, m, bot);
        assert_eq!(p.balance, STARTING_BALANCE - spent + p.score, "bot {bot}");
        assert!(p.balance >= 0);
        let rewards: i64 = ctx
            .db
            .word_play()
            .play_by_match()
            .filter(m)
            .filter(|w| w.bot_id == bot)
            .map(|w| w.total_reward)
            .sum();
        assert_eq!(p.score, rewards);
    }
}

#[test]
fn ending_a_match_publishes_its_top_bids() {
    let ctx = new_db();
    let sims = sim_ids(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &sims);
    run_to_end(&ctx, m);

    assert_eq!(
        ctx.db
            .auction_top_bid()
            .top_bid_by_match()
            .filter(m)
            .count(),
        0
    );
    let archived = ctx
        .db
        .auction_top_bid_archive()
        .archive_by_match()
        .filter(m)
        .count();
    assert_eq!(
        archived as u64,
        ctx.db.auction_result().result_by_match().filter(m).count() as u64
    );
}

#[test]
fn matches_are_deterministic_for_a_given_seed() {
    let play = || {
        let ctx = new_db();
        let m = start_match(&ctx, AuctionType::Vickrey, &sim_ids(&ctx));
        run_to_end(&ctx, m);
        let mut words: Vec<_> = ctx
            .db
            .word_play()
            .iter()
            .map(|w| (w.id, w.bot_id, w.word))
            .collect();
        words.sort();
        words
    };
    assert_eq!(play(), play());
}

// A team can dissolve while its bot sits in the lobby. When the lobby then
// resolves, `start_match_with` has already inserted the Match and some
// participants before hitting the missing bot; its Err is discarded by
// `resolve_lobby`, so the half-built match stays Running forever with no
// auction, and every bot dealt into it can never join a lobby again.
#[test]
#[ignore = "bug: a bot deleted while in the lobby leaves a zombie Running match"]
fn a_bot_whose_team_dissolves_in_the_lobby_does_not_break_the_match() {
    let ctx = new_db();
    team_with_bot(&ctx, "alice", "Ann");
    team_with_bot(&ctx, "bob", "Ben");
    call(&ctx, "Ann", join_lobby).unwrap();
    call(&ctx, "Ben", join_lobby).unwrap();
    call(&ctx, "alice", leave_team).unwrap();

    let lobby_id = ctx
        .db
        .lobby()
        .lobby_by_status()
        .filter(LobbyStatus::Open)
        .next()
        .unwrap()
        .id;
    internal(&ctx, |tx| {
        lobby_timeout_tick(
            tx,
            LobbyTimeoutSchedule {
                scheduled_id: 0,
                scheduled_at: ScheduleAt::Time(tx.timestamp),
                lobby_id,
            },
        );
        Ok(())
    })
    .unwrap();

    for m in ctx.db.match_state().iter() {
        assert!(
            m.current_auction_id.is_some(),
            "match {} has no auction",
            m.id
        );
    }
    call(&ctx, "Ben", join_lobby).expect("Ben should not be stuck");
}

// TODO.md: "Gate `auction_tick` and `lobby_timeout_tick` to the scheduler."
#[test]
#[ignore = "TODO.md: scheduled reducers are callable by any client"]
fn clients_cannot_close_an_auction_early() {
    let ctx = new_db();
    let [ann, ben, _] = three_bots(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let a = current_auction(&ctx, m).id;
    let _ = call(&ctx, "Ann", |tx| {
        auction_tick(
            tx,
            AuctionSchedule {
                scheduled_id: 0,
                scheduled_at: ScheduleAt::Time(tx.timestamp),
                match_id: m,
            },
        );
        Ok(())
    });
    assert_eq!(
        ctx.db.auction().id().find(a).unwrap().status,
        AuctionStatus::Open
    );
}
