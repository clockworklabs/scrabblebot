// Tournaments: Swiss rounds, then a bracket, then a best-of-3 final.

use super::*;

fn start(ctx: &TestContext, rounds: u32, top_cut: u32, size: u32) -> Result<u64, String> {
    call(ctx, "admin", |tx| {
        start_tournament(tx, rounds, top_cut, size, AuctionType::Vickrey)
    })?;
    Ok(ctx.db.tournament().iter().map(|t| t.id).max().unwrap())
}

fn admin_db() -> TestContext {
    let ctx = new_db();
    make_admin(&ctx, "admin");
    ctx
}

fn tournament(ctx: &TestContext, id: u64) -> Tournament {
    ctx.db.tournament().id().find(id).unwrap()
}

fn tmatches(ctx: &TestContext, id: u64, phase: TournamentPhase) -> Vec<TournamentMatch> {
    let mut ms: Vec<_> = ctx
        .db
        .tournament_match()
        .tm_by_tournament()
        .filter(id)
        .filter(|m| m.phase == phase)
        .collect();
    ms.sort_by_key(|m| m.id);
    ms
}

fn entries(ctx: &TestContext, id: u64) -> Vec<TournamentEntry> {
    let mut es: Vec<_> = ctx
        .db
        .tournament_entry()
        .te_by_tournament()
        .filter(id)
        .collect();
    es.sort_by_key(|e| e.bot_id);
    es
}

fn running_matches(ctx: &TestContext) -> Vec<u64> {
    let mut ids: Vec<u64> = ctx
        .db
        .match_state()
        .match_by_status()
        .filter(MatchStatus::Running)
        .map(|m| m.id)
        .collect();
    ids.sort();
    ids
}

/// Play every running match to the end until nothing is left running.
fn play_out(ctx: &TestContext) {
    for _ in 0..50 {
        let running = running_matches(ctx);
        if running.is_empty() {
            return;
        }
        for m in running {
            run_to_end(ctx, m);
        }
    }
    panic!("tournament never finished");
}

#[test]
fn start_tournament_validates_its_settings() {
    let ctx = admin_db();
    assert_eq!(
        start(&ctx, 1, 2, 1),
        Err("Tournament match_size must be >= 2".into())
    );
    assert_eq!(
        start(&ctx, 0, 2, 2),
        Err("Need at least 1 Swiss round".into())
    );
    assert_eq!(start(&ctx, 1, 1, 2), Err("top_cut must be >= 2".into()));
    assert_eq!(
        start(&ctx, 1, 2, 7),
        Err("Need at least 7 registered bots to start".into())
    );
    assert_eq!(ctx.db.tournament().count(), 0);
}

#[test]
fn starting_enters_every_bot_and_pairs_round_one() {
    let ctx = admin_db();
    let t = start(&ctx, 2, 4, 3).unwrap();

    let tour = tournament(&ctx, t);
    assert_eq!(
        (tour.status, tour.current_round),
        (TournamentStatus::Swiss, 1)
    );
    let es = entries(&ctx, t);
    assert_eq!(
        es.iter().map(|e| e.bot_id).collect::<Vec<_>>(),
        sim_ids(&ctx)
    );
    assert!(es.iter().all(|e| e.swiss_points == 0 && !e.eliminated));

    let round1 = tmatches(&ctx, t, TournamentPhase::Swiss);
    assert_eq!(round1.len(), 2);
    let mut seated: Vec<u64> = round1
        .iter()
        .flat_map(|tm| {
            ctx.db
                .match_participant()
                .mp_by_match()
                .filter(tm.match_id)
                .map(|p| p.bot_id)
        })
        .collect();
    seated.sort();
    assert_eq!(seated, sim_ids(&ctx), "each bot plays exactly once");
}

#[test]
fn swiss_matches_award_points_by_placing() {
    let ctx = admin_db();
    let t = start(&ctx, 2, 4, 3).unwrap();
    let first = tmatches(&ctx, t, TournamentPhase::Swiss)[0].match_id;
    run_to_end(&ctx, first);

    let mut placed: Vec<MatchParticipant> = ctx
        .db
        .match_participant()
        .mp_by_match()
        .filter(first)
        .collect();
    placed.sort_by_key(|p| std::cmp::Reverse(p.score));
    let points: Vec<i32> = placed
        .iter()
        .map(|p| {
            entries(&ctx, t)
                .into_iter()
                .find(|e| e.bot_id == p.bot_id)
                .unwrap()
                .swiss_points
        })
        .collect();
    assert_eq!(points, vec![3, 2, 1]);
    assert_eq!(
        tournament(&ctx, t).current_round,
        1,
        "round 1 isn't over yet"
    );
}

#[test]
fn the_next_swiss_round_starts_when_the_last_match_ends() {
    let ctx = admin_db();
    let t = start(&ctx, 2, 4, 3).unwrap();
    for tm in tmatches(&ctx, t, TournamentPhase::Swiss) {
        run_to_end(&ctx, tm.match_id);
    }
    assert_eq!(tournament(&ctx, t).current_round, 2);
    let round2: Vec<_> = tmatches(&ctx, t, TournamentPhase::Swiss)
        .into_iter()
        .filter(|m| m.round == 2)
        .collect();
    assert_eq!(round2.len(), 2);
}

#[test]
fn a_full_tournament_runs_from_swiss_to_a_single_champion() {
    let ctx = admin_db();
    let t = start(&ctx, 2, 4, 3).unwrap();
    play_out(&ctx);

    let tour = tournament(&ctx, t);
    assert_eq!(tour.status, TournamentStatus::Ended);
    assert!(tour.ended_at.is_some());

    assert_eq!(tmatches(&ctx, t, TournamentPhase::Swiss).len(), 4);
    // Bracket: 4 → 3 → 2, one elimination per match.
    assert_eq!(tmatches(&ctx, t, TournamentPhase::Bracket).len(), 2);
    let finals = tmatches(&ctx, t, TournamentPhase::Final);
    assert_eq!(
        finals.iter().map(|m| m.round).collect::<Vec<_>>(),
        vec![1, 2, 3]
    );

    let alive: Vec<_> = entries(&ctx, t)
        .into_iter()
        .filter(|e| !e.eliminated)
        .collect();
    assert_eq!(alive.len(), 1, "one champion");
    // The champion had the best aggregate across the three finals.
    let champion = alive[0].bot_id;
    let finalists: Vec<u64> = ctx
        .db
        .match_participant()
        .mp_by_match()
        .filter(finals[0].match_id)
        .map(|p| p.bot_id)
        .collect();
    assert_eq!(finalists.len(), 2);
    let total = |bot: u64| -> i64 {
        finals
            .iter()
            .map(|f| participant(&ctx, f.match_id, bot).score)
            .sum()
    };
    for bot in finalists {
        assert!(total(champion) >= total(bot));
    }
}

#[test]
fn the_top_cut_keeps_the_best_swiss_records() {
    let ctx = admin_db();
    let t = start(&ctx, 1, 4, 3).unwrap();
    for tm in tmatches(&ctx, t, TournamentPhase::Swiss) {
        run_to_end(&ctx, tm.match_id);
    }

    assert_eq!(tournament(&ctx, t).status, TournamentStatus::Bracket);
    let es = entries(&ctx, t);
    let kept: Vec<_> = es.iter().filter(|e| !e.eliminated).collect();
    let cut: Vec<_> = es.iter().filter(|e| e.eliminated).collect();
    assert_eq!(kept.len(), 4);
    for k in &kept {
        for c in &cut {
            assert!(k.swiss_points >= c.swiss_points);
        }
    }
    let bracket = tmatches(&ctx, t, TournamentPhase::Bracket);
    assert_eq!(bracket.len(), 1);
    assert_eq!(
        ctx.db
            .match_participant()
            .mp_by_match()
            .filter(bracket[0].match_id)
            .count(),
        4
    );
}

// `pair_into_matches` only seats full tables, so with 7 bots and a match
// size of 3 one bot sits out every Swiss round with zero points.
#[test]
#[ignore = "bug: entrants that don't fill a table never play in Swiss rounds"]
fn every_entrant_plays_in_round_one() {
    let ctx = admin_db();
    call(&ctx, "admin", |tx| {
        spawn_simulated_bot(tx, "Extra-sim".into(), BotStrategy::Cheapskate)
    })
    .unwrap();
    let t = start(&ctx, 1, 2, 3).unwrap();
    let seated: usize = tmatches(&ctx, t, TournamentPhase::Swiss)
        .iter()
        .map(|tm| {
            ctx.db
                .match_participant()
                .mp_by_match()
                .filter(tm.match_id)
                .count()
        })
        .sum();
    assert_eq!(seated, 7);
}
