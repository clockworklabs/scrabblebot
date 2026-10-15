// Per-caller views: what each identity is allowed to see.

use super::*;

fn view(ctx: &TestContext, subject: &str) -> ViewContext {
    ctx.view_context(client(subject))
}

#[test]
fn my_rack_shows_only_the_callers_tiles_across_matches() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    let ben = team_with_bot(&ctx, "bob", "Ben");
    let m1 = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let m2 = start_match(&ctx, AuctionType::Vickrey, &[ann, sim_ids(&ctx)[0]]);

    let tiles = my_rack(&view(&ctx, "Ann"));
    assert!(tiles.iter().all(|h| h.bot_id == ann));
    let total: u32 = tiles.iter().map(|h| h.count).sum();
    assert_eq!(total, 2 * STARTING_RACK_SIZE);
    assert!(tiles.iter().any(|h| h.match_id == m1));
    assert!(tiles.iter().any(|h| h.match_id == m2));

    assert!(
        my_rack(&view(&ctx, "alice")).is_empty(),
        "the human isn't the bot"
    );
    assert!(my_rack(&ctx.view_context(TestAuth::internal())).is_empty());
}

#[test]
fn my_team_summarises_the_callers_team() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    call(&ctx, "bob", |tx| join_team(tx, "Team Ann".into())).unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    let code = nonces_for(&ctx, "alice")[0].code.clone();
    call(&ctx, "ann-2", |tx| claim_credential(tx, code)).unwrap();

    let t = my_team(&view(&ctx, "alice")).unwrap();
    assert_eq!(
        (t.team_name.as_str(), t.bot_id, t.bot_name.as_str()),
        ("Team Ann", ann, "Ann")
    );
    assert_eq!(t.role, TeamRole::Owner);
    assert_eq!(t.credential_count, 2);

    assert_eq!(my_team(&view(&ctx, "bob")).unwrap().role, TeamRole::Member);
    assert!(my_team(&view(&ctx, "stranger")).is_none());
}

#[test]
fn views_resolve_a_linked_browser_to_its_human() {
    let ctx = new_db();
    team_with_bot(&ctx, "alice", "Ann");
    make_admin(&ctx, "alice");
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    call(&ctx, "alice", |tx| connect_id(tx, identity("browser"))).unwrap();

    let v = view(&ctx, "browser");
    assert_eq!(my_team(&v).unwrap().bot_name, "Ann");
    assert_eq!(my_nonces(&v).len(), 1);
    assert_eq!(my_admin(&v).unwrap().human_identity, identity("alice"));
}

#[test]
fn my_nonces_only_shows_the_callers_own() {
    let ctx = new_db();
    team_with_bot(&ctx, "alice", "Ann");
    call(&ctx, "bob", |tx| join_team(tx, "Team Ann".into())).unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    call(&ctx, "bob", mint_credential_nonce).unwrap();
    call(&ctx, "bob", mint_credential_nonce).unwrap();

    assert_eq!(my_nonces(&view(&ctx, "alice")).len(), 1);
    assert_eq!(my_nonces(&view(&ctx, "bob")).len(), 2);
    assert!(my_nonces(&view(&ctx, "stranger")).is_empty());
}

#[test]
fn my_admin_is_only_set_for_admins() {
    let ctx = new_db();
    make_admin(&ctx, "alice");
    assert!(my_admin(&view(&ctx, "alice")).is_some());
    assert!(my_admin(&view(&ctx, "bob")).is_none());
}

#[test]
fn live_top_bids_are_hidden_from_bots() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, sim_ids(&ctx)[0]]);
    tick(&ctx, m);
    tick(&ctx, m);

    let spectator = visible_auction_top_bids(&view(&ctx, "spectator"));
    assert_eq!(spectator.len(), 2);
    assert!(spectator.iter().all(|t| t.match_id == m));

    assert!(visible_auction_top_bids(&view(&ctx, "Ann")).is_empty());
    let sim = ctx.view_context(as_claims("sim", "Cheapo-sim"));
    assert!(visible_auction_top_bids(&sim).is_empty());
}

#[test]
fn finished_matches_drop_out_of_the_live_top_bids() {
    let ctx = new_db();
    let sims = sim_ids(&ctx);
    let finished = start_match(&ctx, AuctionType::Vickrey, &sims[..2]);
    run_to_end(&ctx, finished);
    let live = start_match(&ctx, AuctionType::Vickrey, &sims[2..4]);
    tick(&ctx, live);

    let bids = visible_auction_top_bids(&view(&ctx, "spectator"));
    assert_eq!(bids.len(), 1);
    assert_eq!(bids[0].match_id, live);
}

// TODO.md: AuctionResult is public, and its `paid` exposes the runner-up's bid
// under Vickrey. That's by design; this pins down that `top_bid` itself is
// not in the public result table.
#[test]
fn auction_results_do_not_reveal_the_top_bid() {
    let ctx = new_db();
    let ann = team_with_bot(&ctx, "alice", "Ann");
    let ben = team_with_bot(&ctx, "bob", "Ben");
    let m = start_match(&ctx, AuctionType::Vickrey, &[ann, ben]);
    let a = current_auction(&ctx, m).id;
    call(&ctx, "Ann", |tx| submit_bid(tx, a, 40)).unwrap();
    call(&ctx, "Ben", |tx| submit_bid(tx, a, 3)).unwrap();
    tick(&ctx, m);

    let r = ctx.db.auction_result().auction_id().find(a).unwrap();
    assert_eq!(r.paid, 3);
    assert_eq!(
        ctx.db
            .auction_top_bid()
            .auction_id()
            .find(a)
            .unwrap()
            .top_bid,
        40
    );
}
