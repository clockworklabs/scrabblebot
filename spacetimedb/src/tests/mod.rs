// Native unit tests. Each test builds its own in-memory database from this
// module's schema via `spacetimedb::test_utils`, calls reducers directly and
// inspects the tables (private ones included). See `cargo test`.

mod admins;
mod auctions;
mod lobbies;
mod pure;
mod ratings;
mod teams;
mod tournaments;
mod views;
mod words;

use std::cell::Cell;

use super::*;
use spacetimedb::ConnectionId;
use spacetimedb::test_utils::{TestAuth, TestContext};

pub const ISSUER: &str = "https://auth.example.com";

// 12/10/2026 12:00:00 UTC.
pub const NOW_MICROS: i64 = 1_791_806_400_000_000;

pub fn now() -> Timestamp {
    Timestamp::from_micros_since_unix_epoch(NOW_MICROS)
}

/// A fresh, empty database with the clock at `now()`. No `init`.
pub fn empty_db() -> TestContext {
    let ctx = TestContext::new().expect("test context should initialise");
    ctx.clock.set(now());
    ctx
}

/// A fresh database after `init`: seed admin, six sim bots, one open lobby.
pub fn new_db() -> TestContext {
    let ctx = empty_db();
    internal(&ctx, |tx| {
        init(tx);
        Ok(())
    })
    .unwrap();
    ctx
}

thread_local! {
    static NEXT_CONNECTION: Cell<u128> = const { Cell::new(1) };
}

/// A client signed in as `subject` with our test issuer.
pub fn client(subject: &str) -> TestAuth {
    as_claims(ISSUER, subject)
}

/// A client whose token carries exactly these `iss`/`sub` claims. Sim bots'
/// credentials are `Identity::from_claims("sim", name)`, so
/// `as_claims("sim", "Cheapo-sim")` acts as that sim bot.
pub fn as_claims(issuer: &str, subject: &str) -> TestAuth {
    let conn = NEXT_CONNECTION.with(|c| {
        let n = c.get();
        c.set(n + 1);
        n
    });
    let payload = format!(r#"{{"iss":"{issuer}","sub":"{subject}"}}"#);
    TestAuth::from_jwt_payload(payload, ConnectionId::from_u128(conn)).unwrap()
}

/// The identity `client(subject)` will have.
pub fn identity(subject: &str) -> Identity {
    Identity::from_claims(ISSUER, subject)
}

/// Run `body` as the client `subject`.
pub fn call<T>(
    ctx: &TestContext,
    subject: &str,
    body: impl FnOnce(&ReducerContext) -> Result<T, String>,
) -> Result<T, String> {
    ctx.with_reducer_tx(client(subject), body)
}

/// Run `body` as the database itself (init, scheduled reducers).
pub fn internal<T>(
    ctx: &TestContext,
    body: impl FnOnce(&ReducerContext) -> Result<T, String>,
) -> Result<T, String> {
    ctx.with_reducer_tx(TestAuth::internal(), body)
}

/// Make `subject` an admin by writing the row directly.
pub fn make_admin(ctx: &TestContext, subject: &str) {
    ctx.db.admin().insert(Admin {
        human_identity: identity(subject),
        added_at: now(),
        added_by: None,
    });
}

/// Create a team owned by `owner` with a bot named `bot_name`, and give the
/// bot a credential whose identity is `client(bot_name)`. Returns the bot id.
pub fn team_with_bot(ctx: &TestContext, owner: &str, bot_name: &str) -> u64 {
    call(ctx, owner, |tx| {
        create_team(tx, format!("Team {bot_name}"), bot_name.to_string())
    })
    .unwrap();
    call(ctx, owner, mint_credential_nonce).unwrap();
    let code = nonces_for(ctx, owner).pop().unwrap().code;
    call(ctx, bot_name, |tx| claim_credential(tx, code)).unwrap();
    bot_named(ctx, bot_name).id
}

pub fn bot_named(ctx: &TestContext, name: &str) -> Bot {
    ctx.db
        .bot()
        .name()
        .find(name.to_string())
        .unwrap_or_else(|| panic!("no bot named {name}"))
}

pub fn nonces_for(ctx: &TestContext, subject: &str) -> Vec<CredentialNonce> {
    let mut nonces: Vec<_> = ctx
        .db
        .credential_nonce()
        .nonce_by_creator()
        .filter(identity(subject))
        .collect();
    nonces.sort_by_key(|n| n.id);
    nonces
}

/// Start a match directly, bypassing the lobby. Returns the match id.
pub fn start_match(ctx: &TestContext, auction_type: AuctionType, bots: &[u64]) -> u64 {
    let roster = bots.to_vec();
    internal(ctx, |tx| start_match_with(tx, auction_type, roster)).unwrap();
    ctx.db.match_state().iter().map(|m| m.id).max().unwrap()
}

pub fn get_match(ctx: &TestContext, match_id: u64) -> Match {
    ctx.db.match_state().id().find(match_id).unwrap()
}

pub fn current_auction(ctx: &TestContext, match_id: u64) -> Auction {
    let id = get_match(ctx, match_id).current_auction_id.unwrap();
    ctx.db.auction().id().find(id).unwrap()
}

pub fn participant(ctx: &TestContext, match_id: u64, bot_id: u64) -> MatchParticipant {
    ctx.db
        .match_participant()
        .mp_by_match()
        .filter(match_id)
        .find(|p| p.bot_id == bot_id)
        .unwrap()
}

/// The bot's rack in a match, as sorted (letter, count) pairs.
pub fn rack(ctx: &TestContext, match_id: u64, bot_id: u64) -> Vec<(String, u32)> {
    let mut r: Vec<_> = ctx
        .db
        .holding()
        .holding_by_match_bot()
        .filter((match_id, bot_id))
        .map(|h| (h.letter, h.count))
        .collect();
    r.sort();
    r
}

/// Replace the bot's rack in a match with exactly `letters`.
pub fn set_rack(ctx: &TestContext, match_id: u64, bot_id: u64, letters: &str) {
    let old: Vec<u64> = ctx
        .db
        .holding()
        .holding_by_match_bot()
        .filter((match_id, bot_id))
        .map(|h| h.id)
        .collect();
    for id in old {
        ctx.db.holding().id().delete(id);
    }
    let mut counts = std::collections::BTreeMap::new();
    for c in letters.chars() {
        *counts.entry(c).or_insert(0u32) += 1;
    }
    for (c, count) in counts {
        ctx.db.holding().insert(Holding {
            id: 0,
            match_id,
            bot_id,
            letter: c.to_string(),
            count,
        });
    }
}

/// The schedule row that closes `match_id`'s current auction.
pub fn auction_job(match_id: u64) -> AuctionSchedule {
    AuctionSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(now()),
        match_id,
    }
}

/// The schedule row that times out `lobby_id`.
pub fn lobby_job(lobby_id: u64) -> LobbyTimeoutSchedule {
    LobbyTimeoutSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(now()),
        lobby_id,
    }
}

/// Close the current auction as the scheduler would.
pub fn tick(ctx: &TestContext, match_id: u64) {
    internal(ctx, |tx| auction_tick(tx, auction_job(match_id))).unwrap();
}

/// Time out a lobby as the scheduler would.
pub fn lobby_timeout(ctx: &TestContext, lobby_id: u64) {
    internal(ctx, |tx| lobby_timeout_tick(tx, lobby_job(lobby_id))).unwrap();
}

/// Tick the match until the bag runs out. Returns the number of ticks.
pub fn run_to_end(ctx: &TestContext, match_id: u64) -> usize {
    let mut ticks = 0;
    while get_match(ctx, match_id).status == MatchStatus::Running {
        ctx.clock.advance(spacetimedb::TimeDuration::from_micros(
            AUCTION_DURATION_MS as i64 * 1000,
        ));
        tick(ctx, match_id);
        ticks += 1;
        assert!(ticks <= 200, "match {match_id} never ended");
    }
    ticks
}

pub fn sim_ids(ctx: &TestContext) -> Vec<u64> {
    let mut ids: Vec<u64> = ctx
        .db
        .bot()
        .iter()
        .filter(|b| b.is_simulated)
        .map(|b| b.id)
        .collect();
    ids.sort();
    ids
}
