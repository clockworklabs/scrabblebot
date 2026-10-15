// ELO and OpenSkill (Weng-Lin) updates at match end, and the backfills.

use super::*;

/// A finished match between `bots` with the given final scores, rated as the
/// match-end hook would.
fn rate(ctx: &TestContext, scores: &[(u64, i64)]) -> u64 {
    let bots: Vec<u64> = scores.iter().map(|(b, _)| *b).collect();
    let m = start_match(ctx, AuctionType::Vickrey, &bots);
    for (bot, score) in scores {
        let p = participant(ctx, m, *bot);
        ctx.db
            .match_participant()
            .id()
            .update(MatchParticipant { score: *score, ..p });
    }
    let state = get_match(ctx, m);
    ctx.db.match_state().id().update(Match {
        status: MatchStatus::Ended,
        ended_at: Some(ctx.clock.now()),
        ..state
    });
    internal(ctx, |tx| {
        update_elo_at_match_end(tx, m);
        Ok(())
    })
    .unwrap();
    m
}

fn stats(ctx: &TestContext, bot: u64) -> BotStats {
    ctx.db.bot_stats().bot_id().find(bot).unwrap()
}

#[test]
fn a_win_moves_ratings_apart() {
    let ctx = new_db();
    let [a, b] = [sim_ids(&ctx)[0], sim_ids(&ctx)[1]];
    rate(&ctx, &[(a, 30), (b, 10)]);

    let (w, l) = (stats(&ctx, a), stats(&ctx, b));
    assert_eq!(
        (w.rating, l.rating),
        (1016, 984),
        "K=32, equal starting ratings"
    );
    assert!(w.openskill_mu > 25.0 && l.openskill_mu < 25.0);
    assert!(w.openskill_sigma < 25.0 / 3.0 && l.openskill_sigma < 25.0 / 3.0);
    assert_eq!((w.matches_played, w.wins, w.total_score), (1, 1, 30));
    assert_eq!((l.matches_played, l.wins, l.total_score), (1, 0, 10));
    assert_eq!(w.last_played, Some(now()));
}

#[test]
fn ratings_are_nearly_zero_sum_and_ordered_by_placing() {
    let ctx = new_db();
    let s = sim_ids(&ctx);
    rate(&ctx, &[(s[0], 5), (s[1], 50), (s[2], 20), (s[3], 20)]);

    let r: Vec<i32> = s[..4].iter().map(|b| stats(&ctx, *b).rating).collect();
    assert!(r[1] > r[2] && r[2] == r[3] && r[3] > r[0], "{r:?}");
    // Each bot's new rating is rounded on its own, so the pool can drift by
    // up to half a point per bot per match.
    let drift = r.iter().sum::<i32>() - 4000;
    assert!(drift.abs() <= 2, "drift {drift}");
}

#[test]
fn a_draw_leaves_equal_ratings_unchanged() {
    let ctx = new_db();
    let [a, b] = [sim_ids(&ctx)[0], sim_ids(&ctx)[1]];
    rate(&ctx, &[(a, 20), (b, 20)]);
    assert_eq!((stats(&ctx, a).rating, stats(&ctx, b).rating), (1000, 1000));
    assert!((stats(&ctx, a).openskill_mu - 25.0).abs() < 1e-9);
}

#[test]
fn everyone_tied_for_first_gets_a_win() {
    let ctx = new_db();
    let s = sim_ids(&ctx);
    rate(&ctx, &[(s[0], 20), (s[1], 20), (s[2], 5)]);
    let wins: Vec<u32> = s[..3].iter().map(|b| stats(&ctx, *b).wins).collect();
    assert_eq!(wins, vec![1, 1, 0]);
}

#[test]
fn stats_accumulate_over_matches() {
    let ctx = new_db();
    let [a, b] = [sim_ids(&ctx)[0], sim_ids(&ctx)[1]];
    rate(&ctx, &[(a, 30), (b, 10)]);
    rate(&ctx, &[(a, 5), (b, 10)]);

    let s = stats(&ctx, a);
    assert_eq!((s.matches_played, s.wins, s.total_score), (2, 1, 35));
    assert!(
        s.rating < 1000,
        "losing to a lower-rated bot costs more than the win earned"
    );
}

#[test]
fn a_solo_match_is_not_rated() {
    let ctx = new_db();
    let a = sim_ids(&ctx)[0];
    rate(&ctx, &[(a, 30)]);
    assert!(ctx.db.bot_stats().bot_id().find(a).is_none());
}

#[test]
fn finishing_a_real_match_rates_everyone_in_it() {
    let ctx = new_db();
    let sims = sim_ids(&ctx);
    let m = start_match(&ctx, AuctionType::Vickrey, &sims);
    run_to_end(&ctx, m);

    let top = sims
        .iter()
        .map(|b| participant(&ctx, m, *b).score)
        .max()
        .unwrap();
    for bot in &sims {
        let s = stats(&ctx, *bot);
        let score = participant(&ctx, m, *bot).score;
        assert_eq!(s.matches_played, 1);
        assert_eq!(s.total_score, score);
        assert_eq!(s.wins, u32::from(score == top), "bot {bot}");
    }
}

#[test]
fn backfill_elo_replays_history_to_the_same_result() {
    let ctx = new_db();
    make_admin(&ctx, "alice");
    let sims = sim_ids(&ctx);
    for roster in [&sims[..3], &sims[2..], &sims[1..5]] {
        let m = start_match(&ctx, AuctionType::Vickrey, roster);
        run_to_end(&ctx, m);
    }
    let mut live: Vec<BotStats> = ctx.db.bot_stats().iter().collect();
    live.sort_by_key(|s| s.bot_id);

    // Corrupt the stats, then rebuild them.
    for s in live.clone() {
        ctx.db.bot_stats().bot_id().update(BotStats {
            rating: 1,
            wins: 99,
            ..s
        });
    }
    call(&ctx, "alice", backfill_elo).unwrap();

    let mut rebuilt: Vec<BotStats> = ctx.db.bot_stats().iter().collect();
    rebuilt.sort_by_key(|s| s.bot_id);
    let key = |s: &BotStats| {
        (
            s.bot_id,
            s.rating,
            s.matches_played,
            s.wins,
            s.total_score,
            s.openskill_mu.to_bits(),
            s.openskill_sigma.to_bits(),
        )
    };
    assert_eq!(
        live.iter().map(key).collect::<Vec<_>>(),
        rebuilt.iter().map(key).collect::<Vec<_>>()
    );
}

#[test]
fn backfill_top_bid_archive_moves_ended_matches_in_chunks() {
    let ctx = new_db();
    make_admin(&ctx, "alice");
    let ann = team_with_bot(&ctx, "alice", "Ann");
    let ended = start_match(&ctx, AuctionType::Vickrey, &[ann, sim_ids(&ctx)[0]]);
    let running = start_match(&ctx, AuctionType::Vickrey, &[ann, sim_ids(&ctx)[1]]);
    let state = get_match(&ctx, ended);
    ctx.db.match_state().id().update(Match {
        status: MatchStatus::Ended,
        ..state
    });
    // Legacy rows from before matches archived themselves.
    for (auction_id, match_id) in [(101, ended), (102, ended), (103, ended), (201, running)] {
        ctx.db.auction_top_bid().insert(AuctionTopBid {
            auction_id,
            match_id,
            top_bid: 7,
            visible: true,
        });
    }

    assert_eq!(
        call(&ctx, "alice", |tx| backfill_top_bid_archive(tx, 0)),
        Err("max_rows must be > 0".into())
    );
    call(&ctx, "alice", |tx| backfill_top_bid_archive(tx, 2)).unwrap();
    assert_eq!(ctx.db.auction_top_bid_archive().count(), 2);
    call(&ctx, "alice", |tx| backfill_top_bid_archive(tx, 2)).unwrap();
    call(&ctx, "alice", |tx| backfill_top_bid_archive(tx, 2)).unwrap();

    assert_eq!(ctx.db.auction_top_bid_archive().count(), 3);
    let left: Vec<u64> = ctx
        .db
        .auction_top_bid()
        .iter()
        .map(|t| t.auction_id)
        .collect();
    assert_eq!(left, vec![201], "running matches stay private");
}
