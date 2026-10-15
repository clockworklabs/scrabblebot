// The lobby: joining, filling up, timing out and padding with sims.

use super::*;

fn open_lobby(ctx: &TestContext) -> Lobby {
    let open: Vec<Lobby> = ctx
        .db
        .lobby()
        .lobby_by_status()
        .filter(LobbyStatus::Open)
        .collect();
    assert_eq!(open.len(), 1, "expected exactly one open lobby");
    open.into_iter().next().unwrap()
}

fn members(ctx: &TestContext, lobby_id: u64) -> Vec<u64> {
    let mut ids: Vec<u64> = ctx
        .db
        .lobby_member()
        .lm_by_lobby()
        .filter(lobby_id)
        .map(|m| m.bot_id)
        .collect();
    ids.sort();
    ids
}

fn join(ctx: &TestContext, bot: &str) -> Result<(), String> {
    call(ctx, bot, join_lobby)
}

/// Six real bots, Bot0..Bot5, each on its own team.
fn real_bots(ctx: &TestContext, n: usize) -> Vec<u64> {
    (0..n)
        .map(|i| team_with_bot(ctx, &format!("owner{i}"), &format!("Bot{i}")))
        .collect()
}

fn match_roster(ctx: &TestContext, match_id: u64) -> Vec<u64> {
    let mut ids: Vec<u64> = ctx
        .db
        .match_participant()
        .mp_by_match()
        .filter(match_id)
        .map(|p| p.bot_id)
        .collect();
    ids.sort();
    ids
}

#[test]
fn only_bots_can_join() {
    let ctx = new_db();
    assert_eq!(
        join(&ctx, "stranger"),
        Err("Your identity is not a credential for any bot".into())
    );
}

#[test]
fn joining_is_idempotent() {
    let ctx = new_db();
    let bot = team_with_bot(&ctx, "alice", "Robo");
    join(&ctx, "Robo").unwrap();
    join(&ctx, "Robo").unwrap();
    assert_eq!(members(&ctx, open_lobby(&ctx).id), vec![bot]);
}

#[test]
fn a_lobby_full_of_real_bots_starts_a_match_at_once() {
    let ctx = new_db();
    let mut bots = real_bots(&ctx, LOBBY_MAX_SIZE as usize);
    let lobby = open_lobby(&ctx);
    for i in 0..bots.len() {
        join(&ctx, &format!("Bot{i}")).unwrap();
    }

    let resolved = ctx.db.lobby().id().find(lobby.id).unwrap();
    assert_eq!(resolved.status, LobbyStatus::Resolved);
    let match_id = resolved
        .resolved_match_id
        .expect("lobby should record its match");
    bots.sort();
    assert_eq!(match_roster(&ctx, match_id), bots, "no sims padded in");
    assert_eq!(get_match(&ctx, match_id).auction_type, AuctionType::Vickrey);

    let next = open_lobby(&ctx);
    assert_ne!(next.id, lobby.id);
    assert!(members(&ctx, next.id).is_empty());
}

#[test]
fn sims_in_the_lobby_do_not_count_towards_filling_it() {
    let ctx = new_db();
    real_bots(&ctx, LOBBY_MAX_SIZE as usize - 1);
    for i in 0..LOBBY_MAX_SIZE - 1 {
        join(&ctx, &format!("Bot{i}")).unwrap();
    }
    ctx.with_reducer_tx(as_claims("sim", "Cheapo-sim"), join_lobby)
        .unwrap();

    let lobby = open_lobby(&ctx);
    assert_eq!(members(&ctx, lobby.id).len(), LOBBY_MAX_SIZE as usize);
    assert_eq!(ctx.db.match_state().count(), 0);
}

#[test]
fn timing_out_pads_the_lobby_with_distinct_sims() {
    let ctx = new_db();
    let real = real_bots(&ctx, 2);
    join(&ctx, "Bot0").unwrap();
    join(&ctx, "Bot1").unwrap();
    let lobby = open_lobby(&ctx);

    lobby_timeout(&ctx, lobby.id);

    let match_id = ctx
        .db
        .lobby()
        .id()
        .find(lobby.id)
        .unwrap()
        .resolved_match_id
        .unwrap();
    let roster = match_roster(&ctx, match_id);
    assert_eq!(roster.len(), LOBBY_MAX_SIZE as usize);
    for bot in &real {
        assert!(roster.contains(bot));
    }
    let sims: Vec<_> = roster
        .iter()
        .filter(|id| sim_ids(&ctx).contains(id))
        .collect();
    assert_eq!(sims.len(), 4);
    assert_ne!(open_lobby(&ctx).id, lobby.id);
}

#[test]
fn an_empty_lobby_times_out_into_an_all_sim_match() {
    let ctx = new_db();
    let lobby = open_lobby(&ctx);
    lobby_timeout(&ctx, lobby.id);

    let match_id = ctx
        .db
        .lobby()
        .id()
        .find(lobby.id)
        .unwrap()
        .resolved_match_id
        .unwrap();
    assert_eq!(match_roster(&ctx, match_id), sim_ids(&ctx));
}

#[test]
fn a_lobby_that_cannot_reach_two_players_is_cancelled() {
    let ctx = empty_db();
    team_with_bot(&ctx, "alice", "Robo");
    join(&ctx, "Robo").unwrap();
    let lobby = open_lobby(&ctx);

    lobby_timeout(&ctx, lobby.id);

    let cancelled = ctx.db.lobby().id().find(lobby.id).unwrap();
    assert_eq!(cancelled.status, LobbyStatus::Cancelled);
    assert_eq!(cancelled.resolved_match_id, None);
    assert_eq!(ctx.db.match_state().count(), 0);
    let next = open_lobby(&ctx);
    assert_ne!(next.id, lobby.id);
    assert_eq!(
        ctx.db
            .lobby_timeout_schedule()
            .iter()
            .filter(|s| s.lobby_id == next.id)
            .count(),
        1
    );
}

#[test]
fn a_late_timeout_for_a_resolved_lobby_does_nothing() {
    let ctx = new_db();
    real_bots(&ctx, LOBBY_MAX_SIZE as usize);
    let lobby = open_lobby(&ctx);
    for i in 0..LOBBY_MAX_SIZE {
        join(&ctx, &format!("Bot{i}")).unwrap();
    }
    let next = open_lobby(&ctx);

    lobby_timeout(&ctx, lobby.id);
    lobby_timeout(&ctx, 9999);

    assert_eq!(ctx.db.match_state().count(), 1);
    assert_eq!(open_lobby(&ctx).id, next.id);
}

#[test]
fn bots_in_a_running_match_cannot_join() {
    let ctx = new_db();
    let bot = team_with_bot(&ctx, "alice", "Robo");
    start_match(&ctx, AuctionType::Vickrey, &[bot, sim_ids(&ctx)[0]]);
    assert_eq!(
        join(&ctx, "Robo"),
        Err("You're already in a running match".into())
    );
}

#[test]
fn bots_can_rejoin_once_their_match_ends() {
    let ctx = new_db();
    let bot = team_with_bot(&ctx, "alice", "Robo");
    let m = start_match(&ctx, AuctionType::Vickrey, &[bot, sim_ids(&ctx)[0]]);
    run_to_end(&ctx, m);
    join(&ctx, "Robo").unwrap();
}

#[test]
fn a_dissolved_teams_bot_leaves_the_lobby() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    join(&ctx, "Ann").unwrap();

    call(&ctx, "alice", leave_team).unwrap();

    assert!(
        ctx.db
            .lobby_member()
            .lm_by_bot()
            .filter(ann)
            .next()
            .is_none()
    );
}

#[test]
fn a_bot_whose_team_dissolves_in_the_lobby_does_not_break_the_match() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    let ben = team_with_bot(&ctx, "bob", "Ben");
    join(&ctx, "Ann").unwrap();
    join(&ctx, "Ben").unwrap();
    call(&ctx, "alice", leave_team).unwrap();
    let lobby = open_lobby(&ctx);

    lobby_timeout(&ctx, lobby.id);

    let m = ctx
        .db
        .lobby()
        .id()
        .find(lobby.id)
        .unwrap()
        .resolved_match_id
        .unwrap();
    let roster = match_roster(&ctx, m);
    assert!(roster.contains(&ben) && !roster.contains(&ann));
    assert_eq!(roster.len(), LOBBY_MAX_SIZE as usize);
    assert!(get_match(&ctx, m).current_auction_id.is_some());
    run_to_end(&ctx, m);
    join(&ctx, "Ben").expect("Ben should be free to play again");
}

#[test]
fn lobby_members_whose_bot_is_gone_are_skipped() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    join(&ctx, "Ann").unwrap();
    let lobby = open_lobby(&ctx);
    // A stale row, e.g. from before leave_team cleaned up lobbies.
    ctx.db.lobby_member().insert(LobbyMember {
        id: 0,
        lobby_id: lobby.id,
        bot_id: 9999,
        joined_at: now(),
    });

    lobby_timeout(&ctx, lobby.id);

    let resolved = ctx.db.lobby().id().find(lobby.id).unwrap();
    assert_eq!(resolved.status, LobbyStatus::Resolved);
    let roster = match_roster(&ctx, resolved.resolved_match_id.unwrap());
    assert!(roster.contains(&ann) && !roster.contains(&9999));
    assert_eq!(roster.len(), LOBBY_MAX_SIZE as usize);
}

#[test]
fn clients_cannot_force_a_lobby_timeout() {
    let ctx = new_db();
    team_with_bot(&ctx, "alice", "Robo");
    let lobby = open_lobby(&ctx);

    for who in ["mallory", "Robo"] {
        let err = call(&ctx, who, |tx| lobby_timeout_tick(tx, lobby_job(lobby.id))).unwrap_err();
        assert_eq!(err, "Only the scheduler may call this");
    }
    assert_eq!(open_lobby(&ctx).id, lobby.id, "lobby should still be open");
}
