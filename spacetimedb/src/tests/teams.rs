// Teams, membership and bot credential provisioning.

use super::*;

fn create(ctx: &TestContext, who: &str, team: &str, bot: &str) -> Result<(), String> {
    let (team, bot) = (team.to_string(), bot.to_string());
    call(ctx, who, move |tx| create_team(tx, team, bot))
}

fn member(ctx: &TestContext, who: &str) -> Option<TeamMember> {
    ctx.db.team_member().user().find(identity(who))
}

#[test]
fn create_team_makes_a_team_its_bot_and_an_owner() {
    let ctx = new_db();
    create(&ctx, "alice", "  The Alices  ", " Robo ").unwrap();

    let team = ctx.db.team().name().find("The Alices".to_string()).unwrap();
    let bot = bot_named(&ctx, "Robo");
    assert_eq!(bot.team_id, team.id);
    assert!(!bot.is_simulated);
    assert_eq!(bot.strategy, BotStrategy::Human);
    let m = member(&ctx, "alice").unwrap();
    assert_eq!((m.team_id, m.role), (team.id, TeamRole::Owner));
    assert_eq!(
        ctx.db.bot_credential().cred_by_bot().filter(bot.id).count(),
        0
    );
}

#[test]
fn create_team_validates_names() {
    let ctx = new_db();
    let cases = [
        ("", "Robo", "Team name must be 1-48 characters"),
        (&"t".repeat(49), "Robo", "Team name must be 1-48 characters"),
        ("Team", "  ", "Bot name must be 1-32 characters"),
        ("Team", &"b".repeat(33), "Bot name must be 1-32 characters"),
        ("Team", "Cheapo-sim", "Bot name already taken"),
    ];
    for (team, bot, expected) in cases {
        assert_eq!(
            create(&ctx, "alice", team, bot),
            Err(expected.into()),
            "{team:?}/{bot:?}"
        );
    }
    assert_eq!(ctx.db.team().count(), 0);
    assert_eq!(ctx.db.team_member().count(), 0);
}

#[test]
fn create_team_rejects_duplicates_and_double_membership() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    assert_eq!(
        create(&ctx, "bob", "Team", "Other"),
        Err("Team name already taken".into())
    );
    assert_eq!(
        create(&ctx, "alice", "Team 2", "Other"),
        Err("You're already on a team".into())
    );
    assert_eq!(ctx.db.team().count(), 1);
    assert_eq!(ctx.db.bot().count(), 7);
}

#[test]
fn join_team_adds_a_member() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "bob", |tx| join_team(tx, " Team ".into())).unwrap();

    let bob = member(&ctx, "bob").unwrap();
    assert_eq!(bob.role, TeamRole::Member);
    assert_eq!(bob.team_id, member(&ctx, "alice").unwrap().team_id);

    assert_eq!(
        call(&ctx, "bob", |tx| join_team(tx, "Team".into())),
        Err("You're already on a team".into())
    );
    assert_eq!(
        call(&ctx, "carol", |tx| join_team(tx, "Nope".into())),
        Err("No such team".into())
    );
}

#[test]
fn leaving_keeps_the_team_while_members_remain() {
    let ctx = new_db();
    let bot_id = team_with_bot(&ctx, "alice", "Robo");
    let team_id = member(&ctx, "alice").unwrap().team_id;
    call(&ctx, "bob", |tx| join_team(tx, "Team Robo".into())).unwrap();

    call(&ctx, "alice", leave_team).unwrap();

    assert!(member(&ctx, "alice").is_none());
    assert!(ctx.db.team().id().find(team_id).is_some());
    assert!(ctx.db.bot().id().find(bot_id).is_some());
    assert_eq!(
        call(&ctx, "alice", leave_team),
        Err("You're not on a team".into())
    );
}

#[test]
fn the_last_member_leaving_dissolves_the_team_bot_and_credentials() {
    let ctx = new_db();
    let bot_id = team_with_bot(&ctx, "alice", "Robo");
    let team_id = member(&ctx, "alice").unwrap().team_id;

    call(&ctx, "alice", leave_team).unwrap();

    assert!(ctx.db.team().id().find(team_id).is_none());
    assert!(ctx.db.bot().id().find(bot_id).is_none());
    assert_eq!(
        ctx.db.bot_credential().cred_by_bot().filter(bot_id).count(),
        0
    );
    // The sims are untouched.
    assert_eq!(ctx.db.bot().count(), 6);
}

#[test]
fn owners_can_promote_teammates() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "bob", |tx| join_team(tx, "Team".into())).unwrap();

    call(&ctx, "alice", |tx| promote_to_owner(tx, identity("bob"))).unwrap();
    assert_eq!(member(&ctx, "bob").unwrap().role, TeamRole::Owner);
    assert_eq!(member(&ctx, "alice").unwrap().role, TeamRole::Owner);
}

#[test]
fn promotion_rules() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "bob", |tx| join_team(tx, "Team".into())).unwrap();
    call(&ctx, "carol", |tx| join_team(tx, "Team".into())).unwrap();
    create(&ctx, "dave", "Other", "Other").unwrap();

    let promote = |who: &str, target: &str| {
        let target = identity(target);
        call(&ctx, who, move |tx| promote_to_owner(tx, target))
    };
    assert_eq!(
        promote("bob", "carol"),
        Err("Only owners can promote".into())
    );
    assert_eq!(
        promote("alice", "dave"),
        Err("Target user is not on your team".into())
    );
    assert_eq!(
        promote("alice", "stranger"),
        Err("Target user is not on a team".into())
    );
    assert_eq!(
        promote("stranger", "alice"),
        Err("You're not on a team".into())
    );
    assert_eq!(member(&ctx, "carol").unwrap().role, TeamRole::Member);
}

#[test]
fn minting_a_nonce_requires_a_team() {
    let ctx = new_db();
    let err = call(&ctx, "alice", mint_credential_nonce).unwrap_err();
    assert!(err.contains("not on a team"), "{err}");
    assert_eq!(ctx.db.credential_nonce().count(), 0);
}

#[test]
fn minted_nonces_are_unique_codes_with_a_one_hour_ttl() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();

    let nonces = nonces_for(&ctx, "alice");
    assert_eq!(nonces.len(), 2);
    assert_ne!(nonces[0].code, nonces[1].code);
    for n in &nonces {
        assert_eq!(n.code.len(), 12);
        assert!(
            n.code
                .chars()
                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        );
        assert!(
            !n.code.contains(['I', 'O', '0', '1']),
            "ambiguous chars in {}",
            n.code
        );
        assert_eq!(n.bot_id, bot_named(&ctx, "Robo").id);
        assert_eq!(n.expires_at, now() + Duration::from_secs(NONCE_TTL_SECONDS));
    }
}

#[test]
fn any_team_member_can_mint_for_the_team_bot() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "bob", |tx| join_team(tx, "Team".into())).unwrap();
    call(&ctx, "bob", mint_credential_nonce).unwrap();
    assert_eq!(
        nonces_for(&ctx, "bob")[0].bot_id,
        bot_named(&ctx, "Robo").id
    );
}

#[test]
fn claiming_a_nonce_makes_the_caller_a_bot_credential() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    let code = nonces_for(&ctx, "alice")[0].code.clone();

    call(&ctx, "robo-process", |tx| {
        claim_credential(tx, code.clone())
    })
    .unwrap();

    let cred = ctx
        .db
        .bot_credential()
        .identity()
        .find(identity("robo-process"))
        .unwrap();
    assert_eq!(cred.bot_id, bot_named(&ctx, "Robo").id);
    assert!(cred.connected);
    assert!(nonces_for(&ctx, "alice").is_empty(), "nonce is single-use");

    let err = call(&ctx, "another", |tx| claim_credential(tx, code)).unwrap_err();
    assert_eq!(err, "No such nonce");
}

#[test]
fn an_identity_can_only_be_a_credential_for_one_bot() {
    let ctx = new_db();
    team_with_bot(&ctx, "alice", "Robo");
    create(&ctx, "bob", "Other", "Other").unwrap();
    call(&ctx, "bob", mint_credential_nonce).unwrap();
    let code = nonces_for(&ctx, "bob")[0].code.clone();

    let err = call(&ctx, "Robo", |tx| claim_credential(tx, code)).unwrap_err();
    assert_eq!(err, "Your identity is already a credential for a bot");
    assert_eq!(
        nonces_for(&ctx, "bob").len(),
        1,
        "failed claim leaves the nonce"
    );
}

#[test]
fn expired_nonces_are_rejected() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    let code = nonces_for(&ctx, "alice")[0].code.clone();

    ctx.clock
        .set(now() + Duration::from_secs(NONCE_TTL_SECONDS));
    let err = call(&ctx, "robo-process", |tx| claim_credential(tx, code)).unwrap_err();

    assert_eq!(err, "This nonce has expired");
    assert!(
        ctx.db
            .bot_credential()
            .identity()
            .find(identity("robo-process"))
            .is_none()
    );
}

// The expired-nonce branch deletes the row and then returns Err, which rolls
// the whole transaction back — so the cleanup never happens. Expired nonces
// pile up until something else removes them.
#[test]
#[ignore = "bug: expired nonce cleanup is rolled back by the Err return"]
fn expired_nonces_are_cleaned_up() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    let code = nonces_for(&ctx, "alice")[0].code.clone();

    ctx.clock
        .set(now() + Duration::from_secs(NONCE_TTL_SECONDS));
    let _ = call(&ctx, "robo-process", |tx| claim_credential(tx, code));

    assert!(nonces_for(&ctx, "alice").is_empty());
}

// `leave_team` deletes a dissolved team's bot and credentials but not its
// outstanding nonces, which can still be claimed — giving the claimant a
// credential for a bot that no longer exists.
#[test]
#[ignore = "bug: a dissolved team's unclaimed nonces can still be redeemed"]
fn dissolving_a_team_revokes_its_nonces() {
    let ctx = new_db();
    create(&ctx, "alice", "Team", "Robo").unwrap();
    call(&ctx, "alice", mint_credential_nonce).unwrap();
    let code = nonces_for(&ctx, "alice")[0].code.clone();
    call(&ctx, "alice", leave_team).unwrap();

    assert_eq!(
        call(&ctx, "robo-process", |tx| claim_credential(tx, code)),
        Err("No such nonce".into())
    );
}
