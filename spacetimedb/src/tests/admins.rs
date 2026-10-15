// init, connection lifecycle, identity linking, admins and sim bots.

use super::*;

#[test]
fn init_seeds_admin_sim_bots_and_a_lobby() {
    let ctx = new_db();

    let seed = Identity::from_hex(SEED_ADMIN_HEX[0]).unwrap();
    let admin = ctx.db.admin().human_identity().find(seed).unwrap();
    assert_eq!(admin.added_by, None);

    assert_eq!(sim_ids(&ctx).len(), 6);
    for bot in ctx.db.bot().iter() {
        assert!(bot.is_simulated);
        assert_eq!(bot.team_id, 0);
        let cred = ctx
            .db
            .bot_credential()
            .identity()
            .find(Identity::from_claims("sim", &bot.name))
            .unwrap();
        assert_eq!(cred.bot_id, bot.id);
    }

    let lobbies: Vec<Lobby> = ctx.db.lobby().iter().collect();
    assert_eq!(lobbies.len(), 1);
    assert_eq!(lobbies[0].status, LobbyStatus::Open);
    assert_eq!(lobbies[0].max_size, LOBBY_MAX_SIZE);
    assert_eq!(
        lobbies[0].closes_at,
        now() + Duration::from_secs(LOBBY_DURATION_SECONDS)
    );
    let timeout = ctx.db.lobby_timeout_schedule().iter().next().unwrap();
    assert_eq!(timeout.lobby_id, lobbies[0].id);
    assert_eq!(timeout.scheduled_at, ScheduleAt::Time(lobbies[0].closes_at));
}

#[test]
fn init_is_idempotent() {
    let ctx = new_db();
    internal(&ctx, |tx| {
        init(tx);
        Ok(())
    })
    .unwrap();

    assert_eq!(ctx.db.admin().count(), 1);
    assert_eq!(ctx.db.bot().count(), 6);
    assert_eq!(ctx.db.bot_credential().count(), 6);
    assert_eq!(ctx.db.lobby().count(), 1);
}

#[test]
fn connecting_and_disconnecting_tracks_bot_credentials() {
    let ctx = new_db();
    let bot_id = team_with_bot(&ctx, "alice", "Robo");
    ctx.clock
        .advance(spacetimedb::TimeDuration::from_micros(5_000_000));

    call(&ctx, "Robo", |tx| {
        client_disconnected(tx);
        Ok(())
    })
    .unwrap();
    let cred = ctx
        .db
        .bot_credential()
        .identity()
        .find(identity("Robo"))
        .unwrap();
    assert_eq!(cred.bot_id, bot_id);
    assert!(!cred.connected);
    assert_eq!(cred.last_seen, ctx.clock.now());

    call(&ctx, "Robo", |tx| {
        client_connected(tx);
        Ok(())
    })
    .unwrap();
    assert!(
        ctx.db
            .bot_credential()
            .identity()
            .find(identity("Robo"))
            .unwrap()
            .connected
    );
}

#[test]
fn connecting_without_a_credential_writes_nothing() {
    let ctx = new_db();
    let before = ctx.db.bot_credential().count();
    call(&ctx, "stranger", |tx| {
        client_connected(tx);
        Ok(())
    })
    .unwrap();
    assert_eq!(ctx.db.bot_credential().count(), before);
}

#[test]
fn connect_id_links_a_web_identity_to_the_caller() {
    let ctx = new_db();
    call(&ctx, "alice", |tx| {
        connect_id(tx, identity("alice-browser"))
    })
    .unwrap();

    let link = ctx
        .db
        .human_link()
        .web_identity()
        .find(identity("alice-browser"))
        .unwrap();
    assert_eq!(link.human_identity, identity("alice"));

    // Linking again is a no-op.
    call(&ctx, "alice", |tx| {
        connect_id(tx, identity("alice-browser"))
    })
    .unwrap();
    assert_eq!(ctx.db.human_link().count(), 1);
}

#[test]
fn connect_id_refuses_self_links_and_stealing() {
    let ctx = new_db();
    let err = call(&ctx, "alice", |tx| connect_id(tx, identity("alice"))).unwrap_err();
    assert!(err.contains("same as your identity"), "{err}");

    call(&ctx, "alice", |tx| connect_id(tx, identity("browser"))).unwrap();
    let err = call(&ctx, "mallory", |tx| connect_id(tx, identity("browser"))).unwrap_err();
    assert!(err.contains("already linked"), "{err}");
    assert_eq!(
        ctx.db
            .human_link()
            .web_identity()
            .find(identity("browser"))
            .unwrap()
            .human_identity,
        identity("alice")
    );
}

#[test]
fn bootstrap_admin_only_works_on_an_empty_admin_table() {
    let ctx = empty_db();
    call(&ctx, "alice", bootstrap_admin).unwrap();
    assert!(
        ctx.db
            .admin()
            .human_identity()
            .find(identity("alice"))
            .is_some()
    );

    let err = call(&ctx, "bob", bootstrap_admin).unwrap_err();
    assert!(err.contains("Admins already exist"), "{err}");
    assert_eq!(ctx.db.admin().count(), 1);
}

#[test]
fn bootstrap_admin_resolves_a_linked_browser_to_its_human() {
    let ctx = empty_db();
    call(&ctx, "alice", |tx| connect_id(tx, identity("browser"))).unwrap();
    call(&ctx, "browser", bootstrap_admin).unwrap();
    assert!(
        ctx.db
            .admin()
            .human_identity()
            .find(identity("alice"))
            .is_some()
    );
    assert!(
        ctx.db
            .admin()
            .human_identity()
            .find(identity("browser"))
            .is_none()
    );
}

#[test]
fn admins_can_add_and_remove_admins() {
    let ctx = new_db();
    make_admin(&ctx, "alice");

    call(&ctx, "alice", |tx| add_admin(tx, identity("bob"))).unwrap();
    let bob = ctx
        .db
        .admin()
        .human_identity()
        .find(identity("bob"))
        .unwrap();
    assert_eq!(bob.added_by, Some(identity("alice")));

    let err = call(&ctx, "alice", |tx| add_admin(tx, identity("bob"))).unwrap_err();
    assert_eq!(err, "Already an admin");

    call(&ctx, "bob", |tx| remove_admin(tx, identity("alice"))).unwrap();
    assert!(
        ctx.db
            .admin()
            .human_identity()
            .find(identity("alice"))
            .is_none()
    );

    let err = call(&ctx, "bob", |tx| remove_admin(tx, identity("nobody"))).unwrap_err();
    assert_eq!(err, "Not an admin");
}

#[test]
fn admins_cannot_remove_themselves() {
    let ctx = new_db();
    make_admin(&ctx, "alice");
    let err = call(&ctx, "alice", |tx| remove_admin(tx, identity("alice"))).unwrap_err();
    assert_eq!(err, "You can't remove yourself");
}

#[test]
fn admin_reducers_reject_non_admins() {
    let ctx = new_db();
    let checks: Vec<(&str, Result<(), String>)> = vec![
        (
            "add_admin",
            call(&ctx, "eve", |tx| add_admin(tx, identity("eve"))),
        ),
        (
            "remove_admin",
            call(&ctx, "eve", |tx| {
                remove_admin(tx, Identity::from_hex(SEED_ADMIN_HEX[0]).unwrap())
            }),
        ),
        (
            "spawn_simulated_bot",
            call(&ctx, "eve", |tx| {
                spawn_simulated_bot(tx, "Evil".into(), BotStrategy::Aggressive)
            }),
        ),
        (
            "start_tournament",
            call(&ctx, "eve", |tx| {
                start_tournament(tx, 1, 2, 2, AuctionType::Vickrey)
            }),
        ),
        ("backfill_elo", call(&ctx, "eve", backfill_elo)),
        (
            "backfill_top_bid_archive",
            call(&ctx, "eve", |tx| backfill_top_bid_archive(tx, 10)),
        ),
    ];
    for (name, result) in checks {
        assert_eq!(result, Err("Admin only".into()), "{name}");
    }
    assert_eq!(ctx.db.admin().count(), 1);
    assert_eq!(ctx.db.bot().count(), 6);
    assert_eq!(ctx.db.tournament().count(), 0);
}

#[test]
fn a_linked_browser_acts_with_its_humans_admin_rights() {
    let ctx = new_db();
    make_admin(&ctx, "alice");
    call(&ctx, "alice", |tx| connect_id(tx, identity("browser"))).unwrap();

    call(&ctx, "browser", |tx| add_admin(tx, identity("bob"))).unwrap();
    let bob = ctx
        .db
        .admin()
        .human_identity()
        .find(identity("bob"))
        .unwrap();
    assert_eq!(bob.added_by, Some(identity("alice")));
}

#[test]
fn spawn_simulated_bot_creates_a_bot_with_a_sim_credential() {
    let ctx = new_db();
    make_admin(&ctx, "alice");
    call(&ctx, "alice", |tx| {
        spawn_simulated_bot(tx, "  Zed-sim  ".into(), BotStrategy::Cheapskate)
    })
    .unwrap();

    let bot = bot_named(&ctx, "Zed-sim");
    assert!(bot.is_simulated);
    assert_eq!(bot.strategy, BotStrategy::Cheapskate);
    let cred = ctx
        .db
        .bot_credential()
        .identity()
        .find(Identity::from_claims("sim", "Zed-sim"))
        .unwrap();
    assert_eq!(cred.bot_id, bot.id);
}

#[test]
fn spawn_simulated_bot_validates_its_input() {
    let ctx = new_db();
    make_admin(&ctx, "alice");
    let spawn = |name: &str, strategy| {
        let name = name.to_string();
        call(&ctx, "alice", move |tx| {
            spawn_simulated_bot(tx, name, strategy)
        })
    };
    assert!(
        spawn("   ", BotStrategy::Cheapskate)
            .unwrap_err()
            .contains("1-32")
    );
    assert!(
        spawn(&"x".repeat(33), BotStrategy::Cheapskate)
            .unwrap_err()
            .contains("1-32")
    );
    assert!(
        spawn("Human-sim", BotStrategy::Human)
            .unwrap_err()
            .contains("Human strategy")
    );
    assert_eq!(
        spawn("Cheapo-sim", BotStrategy::Cheapskate),
        Err("Name already taken".into())
    );
    assert_eq!(ctx.db.bot().count(), 6);
}
