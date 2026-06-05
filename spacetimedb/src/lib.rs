mod dictionary;
mod letters;

use std::time::Duration;

use rand::Rng;
use spacetimedb::{
    reducer, table, view, Identity, ReducerContext, ScheduleAt, SpacetimeType, Table, Timestamp,
    ViewContext,
};

const STARTING_BALANCE: i64 = 100;
const AUCTION_DURATION_MS: u64 = 1000;
const AUCTION_RESERVE: i64 = 1;
// One hour. Long enough to copy a nonce into a bot config without hurry.
const NONCE_TTL_SECONDS: u64 = 60 * 60;

// ---------- Enums ----------

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum MatchStatus {
    Lobby,
    Running,
    Ended,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AuctionStatus {
    Open,
    Closed,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum AuctionType {
    FirstPrice,
    Vickrey,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum BotStrategy {
    Human,
    Cheapskate,
    ValueBidder,
    Aggressive,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum TournamentStatus {
    Lobby,
    Swiss,
    Bracket,
    Final,
    Ended,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum TournamentPhase {
    Swiss,
    Bracket,
    Final,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum TeamRole {
    Owner,
    Member,
}

// View return type — the caller's team summary.
#[derive(SpacetimeType, Clone, Debug)]
pub struct MyTeam {
    pub team_id: u64,
    pub team_name: String,
    pub bot_id: u64,
    pub bot_name: String,
    pub role: TeamRole,
    pub credential_count: u32,
}

// ---------- Tables ----------

// Bot is a persona, independent of any identity that controls it. Many
// `BotCredential` rows may exist for the same bot; each one is a token a
// human team member can give to a bot process so it can play the game.
#[table(
    accessor = bot,
    public,
    index(accessor = bot_by_team, btree(columns = [team_id]))
)]
#[derive(Clone)]
pub struct Bot {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub name: String,
    // 0 for simulated bots and other system-owned personas (no team).
    pub team_id: u64,
    pub is_simulated: bool,
    pub strategy: BotStrategy,
    pub created_at: Timestamp,
}

// One row per credential authorized to act as a bot. Multiple credentials
// per bot are allowed (the team adds new ones over time; old ones keep
// working).
#[table(
    accessor = bot_credential,
    public,
    index(accessor = cred_by_bot, btree(columns = [bot_id]))
)]
#[derive(Clone)]
pub struct BotCredential {
    #[primary_key]
    pub identity: Identity,
    pub bot_id: u64,
    pub connected: bool,
    pub last_seen: Timestamp,
}

// Links a website's anonymous identity to a developer's spacetimedb.com
// identity. Written by the `connect_id` reducer (called from CLI authed as
// the spacetime.com user). One human can link many web identities; each web
// identity links to exactly one human.
#[table(
    accessor = human_link,
    public,
    index(accessor = link_by_human, btree(columns = [human_identity]))
)]
#[derive(Clone)]
pub struct HumanLink {
    #[primary_key]
    pub web_identity: Identity,
    pub human_identity: Identity,
    pub linked_at: Timestamp,
}

// Single-use credential claim code, minted by a team member. Private (not
// subscribable) — the creator reads their own via the `my_nonces` view.
#[table(
    accessor = credential_nonce,
    index(accessor = nonce_by_code, btree(columns = [code])),
    index(accessor = nonce_by_creator, btree(columns = [creator]))
)]
#[derive(Clone)]
pub struct CredentialNonce {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub code: String,
    pub bot_id: u64,
    // The human (resolved spacetime.com identity) who minted this nonce.
    pub creator: Identity,
    pub expires_at: Timestamp,
}

// Team — group of humans, owns exactly one Bot (Bot.team_id points back).
#[table(accessor = team, public)]
#[derive(Clone)]
pub struct Team {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[unique]
    pub name: String,
    pub created_at: Timestamp,
}

#[table(
    accessor = team_member,
    public,
    index(accessor = tmember_by_team, btree(columns = [team_id]))
)]
#[derive(Clone)]
pub struct TeamMember {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub team_id: u64,
    // Spacetime.com identity (the human).
    #[unique]
    pub user: Identity,
    pub role: TeamRole,
    pub joined_at: Timestamp,
}

// Match — one row per match. id is auto_inc.
#[table(
    accessor = match_state,
    public,
    index(accessor = match_by_status, btree(columns = [status]))
)]
#[derive(Clone)]
pub struct Match {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub status: MatchStatus,
    pub current_round: u32,
    pub current_auction_id: Option<u64>,
    pub bag_total: u32,
    pub auction_type: AuctionType,
    pub created_at: Timestamp,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
}

// Per-match balance and score for one bot in one match.
#[table(
    accessor = match_participant,
    public,
    index(accessor = mp_by_match, btree(columns = [match_id])),
    index(accessor = mp_by_bot, btree(columns = [bot_id]))
)]
#[derive(Clone)]
pub struct MatchParticipant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot_id: u64,
    pub balance: i64,
    pub score: i64,
}

// Private — each match has its own bag.
#[table(
    accessor = bag_letter,
    index(accessor = bag_by_match, btree(columns = [match_id]))
)]
#[derive(Clone)]
pub struct BagLetter {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub letter: String,
    pub remaining: u32,
}

// Private — each bot sees only its own rack via `my_rack`.
#[table(
    accessor = holding,
    index(accessor = holding_by_bot, btree(columns = [bot_id])),
    index(accessor = holding_by_match, btree(columns = [match_id]))
)]
#[derive(Clone)]
pub struct Holding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot_id: u64,
    pub letter: String,
    pub count: u32,
}

#[table(
    accessor = auction,
    public,
    index(accessor = auction_by_match, btree(columns = [match_id])),
    index(accessor = auction_by_status, btree(columns = [status]))
)]
#[derive(Clone)]
pub struct Auction {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub letter: String,
    pub opens_at: Timestamp,
    pub closes_at: Timestamp,
    pub status: AuctionStatus,
}

// Private — bots cannot subscribe and so cannot see competing bids.
#[table(
    accessor = pending_bid,
    index(accessor = bid_by_auction, btree(columns = [auction_id]))
)]
#[derive(Clone)]
pub struct PendingBid {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub auction_id: u64,
    pub bidder_bot_id: u64,
    pub amount: i64,
    pub submitted_at: Timestamp,
}

#[table(
    accessor = auction_result,
    public,
    index(accessor = result_by_match, btree(columns = [match_id]))
)]
#[derive(Clone)]
pub struct AuctionResult {
    #[primary_key]
    pub auction_id: u64,
    pub match_id: u64,
    pub letter: String,
    pub winner_bot_id: Option<u64>,
    pub top_bid: i64,
    pub paid: i64,
    pub closed_at: Timestamp,
}

#[table(
    accessor = word_play,
    public,
    index(accessor = play_by_match, btree(columns = [match_id])),
    index(accessor = play_by_bot, btree(columns = [bot_id]))
)]
#[derive(Clone)]
pub struct WordPlay {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot_id: u64,
    pub word: String,
    pub base_score: i64,
    pub bonus: i64,
    pub total_reward: i64,
    pub played_at: Timestamp,
}

#[table(accessor = auction_schedule, scheduled(auction_tick))]
#[derive(Clone)]
pub struct AuctionSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
    pub match_id: u64,
}

// Per-bot aggregate stats across all matches. ELO rating + counters.
#[table(accessor = bot_stats, public)]
#[derive(Clone)]
pub struct BotStats {
    #[primary_key]
    pub bot_id: u64,
    pub rating: i32, // ELO; new bots start at 1000
    pub matches_played: u32,
    pub wins: u32,
    pub total_score: i64,
    pub last_played: Option<Timestamp>,
}

#[table(accessor = matchmaker_config, public)]
#[derive(Clone)]
pub struct MatchmakerConfig {
    #[primary_key]
    pub id: u32,
    pub enabled: bool,
    pub match_size_min: u32,
    pub match_size_max: u32,
    pub interval_ms: u64,
    pub auction_type: AuctionType,
}

#[table(accessor = matchmaker_schedule, scheduled(matchmaker_tick))]
#[derive(Clone)]
pub struct MatchmakerSchedule {
    #[primary_key]
    #[auto_inc]
    pub scheduled_id: u64,
    pub scheduled_at: ScheduleAt,
}

#[table(accessor = tournament, public)]
#[derive(Clone)]
pub struct Tournament {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub status: TournamentStatus,
    pub swiss_rounds_total: u32,
    pub current_round: u32,
    pub top_cut: u32,
    pub match_size: u32,
    pub auction_type: AuctionType,
    pub created_at: Timestamp,
    pub ended_at: Option<Timestamp>,
}

#[table(
    accessor = tournament_entry,
    public,
    index(accessor = te_by_tournament, btree(columns = [tournament_id])),
    index(accessor = te_by_bot, btree(columns = [bot_id]))
)]
#[derive(Clone)]
pub struct TournamentEntry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub tournament_id: u64,
    pub bot_id: u64,
    pub swiss_points: i32,
    pub eliminated: bool,
}

#[table(
    accessor = tournament_match,
    public,
    index(accessor = tm_by_tournament, btree(columns = [tournament_id])),
    index(accessor = tm_by_match, btree(columns = [match_id]))
)]
#[derive(Clone)]
pub struct TournamentMatch {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub tournament_id: u64,
    pub match_id: u64,
    pub round: u32,
    pub phase: TournamentPhase,
}

// ---------- Views ----------

// A bot sees only its own letters (across any matches it's in). Clients
// filter by match_id on their side.
#[view(accessor = my_rack, public)]
fn my_rack(ctx: &ViewContext) -> Vec<Holding> {
    let Some(cred) = ctx.db.bot_credential().identity().find(ctx.sender()) else {
        return vec![];
    };
    ctx.db
        .holding()
        .holding_by_bot()
        .filter(cred.bot_id)
        .collect()
}

// my_team: the calling human's team. Resolves browser identities via
// HumanLink to the underlying spacetimedb.com identity.
#[view(accessor = my_team, public)]
fn my_team(ctx: &ViewContext) -> Option<MyTeam> {
    let human = resolve_human_view(ctx);
    let member = ctx.db.team_member().user().find(human)?;
    let team = ctx.db.team().id().find(member.team_id)?;
    let bot = ctx.db.bot().bot_by_team().filter(team.id).next()?;
    let credential_count = ctx
        .db
        .bot_credential()
        .cred_by_bot()
        .filter(bot.id)
        .count() as u32;
    Some(MyTeam {
        team_id: team.id,
        team_name: team.name,
        bot_id: bot.id,
        bot_name: bot.name,
        role: member.role,
        credential_count,
    })
}

// Nonces the caller has minted. Private to the caller.
#[view(accessor = my_nonces, public)]
fn my_nonces(ctx: &ViewContext) -> Vec<CredentialNonce> {
    let human = resolve_human_view(ctx);
    ctx.db
        .credential_nonce()
        .nonce_by_creator()
        .filter(human)
        .collect()
}

fn resolve_human_view(ctx: &ViewContext) -> Identity {
    if let Some(link) = ctx.db.human_link().web_identity().find(ctx.sender()) {
        link.human_identity
    } else {
        ctx.sender()
    }
}

fn resolve_human(ctx: &ReducerContext) -> Identity {
    if let Some(link) = ctx.db.human_link().web_identity().find(ctx.sender()) {
        link.human_identity
    } else {
        ctx.sender()
    }
}

fn caller_bot_id(ctx: &ReducerContext) -> Option<u64> {
    ctx.db
        .bot_credential()
        .identity()
        .find(ctx.sender())
        .map(|c| c.bot_id)
}

// ---------- Lifecycle ----------

#[reducer(init)]
pub fn init(_ctx: &ReducerContext) {}

#[reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    if let Some(cred) = ctx.db.bot_credential().identity().find(ctx.sender()) {
        ctx.db.bot_credential().identity().update(BotCredential {
            connected: true,
            last_seen: ctx.timestamp,
            ..cred
        });
    }
}

#[reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    if let Some(cred) = ctx.db.bot_credential().identity().find(ctx.sender()) {
        ctx.db.bot_credential().identity().update(BotCredential {
            connected: false,
            last_seen: ctx.timestamp,
            ..cred
        });
    }
}

// ---------- Identity linking ----------

// CLI flow: spacetime call wordsmith connect_id <web_identity>
// ctx.sender here is the human (spacetime.com identity). The argument is
// the anon web identity the user wants to link.
#[reducer]
pub fn connect_id(ctx: &ReducerContext, web_identity: Identity) -> Result<(), String> {
    let human = ctx.sender();
    if web_identity == human {
        return Err("web identity is the same as your identity — nothing to link".into());
    }
    if let Some(existing) = ctx.db.human_link().web_identity().find(web_identity) {
        if existing.human_identity == human {
            return Ok(()); // idempotent
        }
        return Err(
            "That web identity is already linked to a different account. \
             Reset the browser identity first and try again."
                .into(),
        );
    }
    ctx.db.human_link().insert(HumanLink {
        web_identity,
        human_identity: human,
        linked_at: ctx.timestamp,
    });
    log::info!("Linked web identity to human {}", human.to_hex());
    Ok(())
}

// ---------- Teams ----------

// Create a team with the caller as Owner, plus the team's bot row. The bot
// gets no credentials yet — the team must mint a credential nonce next.
#[reducer]
pub fn create_team(
    ctx: &ReducerContext,
    team_name: String,
    bot_name: String,
) -> Result<(), String> {
    let team_name = team_name.trim().to_string();
    let bot_name = bot_name.trim().to_string();
    if team_name.is_empty() || team_name.len() > 48 {
        return Err("Team name must be 1-48 characters".into());
    }
    if bot_name.is_empty() || bot_name.len() > 32 {
        return Err("Bot name must be 1-32 characters".into());
    }
    let human = resolve_human(ctx);
    if ctx.db.team().name().find(team_name.clone()).is_some() {
        return Err("Team name already taken".into());
    }
    if ctx.db.team_member().user().find(human).is_some() {
        return Err("You're already on a team".into());
    }
    if ctx.db.bot().name().find(bot_name.clone()).is_some() {
        return Err("Bot name already taken".into());
    }

    let team = ctx.db.team().insert(Team {
        id: 0,
        name: team_name.clone(),
        created_at: ctx.timestamp,
    });
    let bot = ctx.db.bot().insert(Bot {
        id: 0,
        name: bot_name.clone(),
        team_id: team.id,
        is_simulated: false,
        strategy: BotStrategy::Human,
        created_at: ctx.timestamp,
    });
    ctx.db.team_member().insert(TeamMember {
        id: 0,
        team_id: team.id,
        user: human,
        role: TeamRole::Owner,
        joined_at: ctx.timestamp,
    });
    log::info!(
        "Team '{}' (id {}) created with bot '{}' (id {})",
        team_name,
        team.id,
        bot_name,
        bot.id
    );
    Ok(())
}

#[reducer]
pub fn join_team(ctx: &ReducerContext, team_name: String) -> Result<(), String> {
    let team_name = team_name.trim().to_string();
    let team = ctx.db.team().name().find(team_name.clone()).ok_or("No such team")?;
    let human = resolve_human(ctx);
    if ctx.db.team_member().user().find(human).is_some() {
        return Err("You're already on a team".into());
    }
    ctx.db.team_member().insert(TeamMember {
        id: 0,
        team_id: team.id,
        user: human,
        role: TeamRole::Member,
        joined_at: ctx.timestamp,
    });
    log::info!("Human {} joined team '{}'", human.to_hex(), team_name);
    Ok(())
}

#[reducer]
pub fn leave_team(ctx: &ReducerContext) -> Result<(), String> {
    let human = resolve_human(ctx);
    let me = ctx
        .db
        .team_member()
        .user()
        .find(human)
        .ok_or("You're not on a team")?;
    let team_id = me.team_id;
    ctx.db.team_member().id().delete(me.id);
    let remaining = ctx
        .db
        .team_member()
        .tmember_by_team()
        .filter(team_id)
        .count();
    if remaining == 0 {
        // Delete the team's bot too (along with any stats/credentials).
        let bot_ids: Vec<u64> = ctx
            .db
            .bot()
            .iter()
            .filter(|b| b.team_id == team_id)
            .map(|b| b.id)
            .collect();
        for bid in bot_ids {
            let cred_ids: Vec<Identity> = ctx
                .db
                .bot_credential()
                .cred_by_bot()
                .filter(bid)
                .map(|c| c.identity)
                .collect();
            for cid in cred_ids {
                ctx.db.bot_credential().identity().delete(cid);
            }
            ctx.db.bot().id().delete(bid);
        }
        ctx.db.team().id().delete(team_id);
        log::info!("Team {} dissolved (no members left)", team_id);
    }
    Ok(())
}

#[reducer]
pub fn promote_to_owner(
    ctx: &ReducerContext,
    target_user: Identity,
) -> Result<(), String> {
    let human = resolve_human(ctx);
    let me = ctx
        .db
        .team_member()
        .user()
        .find(human)
        .ok_or("You're not on a team")?;
    if me.role != TeamRole::Owner {
        return Err("Only owners can promote".into());
    }
    let target = ctx
        .db
        .team_member()
        .user()
        .find(target_user)
        .ok_or("Target user is not on a team")?;
    if target.team_id != me.team_id {
        return Err("Target user is not on your team".into());
    }
    ctx.db.team_member().id().update(TeamMember {
        role: TeamRole::Owner,
        ..target
    });
    Ok(())
}

// ---------- Credential provisioning ----------

// A team member mints a single-use nonce that can be redeemed by any client
// to receive a fresh credential for their team's bot.
#[reducer]
pub fn mint_credential_nonce(ctx: &ReducerContext) -> Result<(), String> {
    let human = resolve_human(ctx);
    let member = ctx
        .db
        .team_member()
        .user()
        .find(human)
        .ok_or("You're not on a team — create or join one first")?;
    let bot = ctx
        .db
        .bot()
        .iter()
        .find(|b| b.team_id == member.team_id)
        .ok_or("Your team has no bot")?;
    let code = generate_nonce_code(ctx);
    let expires_at = ctx.timestamp + Duration::from_secs(NONCE_TTL_SECONDS);
    ctx.db.credential_nonce().insert(CredentialNonce {
        id: 0,
        code: code.clone(),
        bot_id: bot.id,
        creator: human,
        expires_at,
    });
    log::info!(
        "Nonce minted for bot {} (expires in {}s)",
        bot.id,
        NONCE_TTL_SECONDS
    );
    Ok(())
}

// A freshly-connected client (no token yet, OR a token unrelated to a bot)
// redeems a nonce. The client's identity becomes a new credential for the
// nonce's bot. The nonce is then deleted.
#[reducer]
pub fn claim_credential(ctx: &ReducerContext, code: String) -> Result<(), String> {
    let nonce = ctx
        .db
        .credential_nonce()
        .code()
        .find(code.clone())
        .ok_or("No such nonce")?;
    if ctx.timestamp >= nonce.expires_at {
        // Clean it up.
        ctx.db.credential_nonce().id().delete(nonce.id);
        return Err("This nonce has expired".into());
    }
    // Is the caller already a credential for ANY bot? Disallow — a fresh
    // client (no prior credential) must claim.
    if ctx.db.bot_credential().identity().find(ctx.sender()).is_some() {
        return Err("Your identity is already a credential for a bot".into());
    }
    ctx.db.bot_credential().insert(BotCredential {
        identity: ctx.sender(),
        bot_id: nonce.bot_id,
        connected: true,
        last_seen: ctx.timestamp,
    });
    ctx.db.credential_nonce().id().delete(nonce.id);
    log::info!("Credential claimed for bot {}", nonce.bot_id);
    Ok(())
}

fn generate_nonce_code(ctx: &ReducerContext) -> String {
    // Random 12-character alphanumeric code. Deterministic in transaction
    // via ctx.rng. ~57 bits of entropy — fine for a single-use code with
    // short TTL.
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut out = String::with_capacity(12);
    for _ in 0..12 {
        let i = ctx.rng().gen_range(0..CHARS.len());
        out.push(CHARS[i] as char);
    }
    out
}

// ---------- Simulated bot ----------

#[reducer]
pub fn spawn_simulated_bot(
    ctx: &ReducerContext,
    name: String,
    strategy: BotStrategy,
) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err("Name must be 1-32 characters".into());
    }
    if matches!(strategy, BotStrategy::Human) {
        return Err("Simulated bots cannot use the Human strategy".into());
    }
    if ctx.db.bot().name().find(trimmed.to_string()).is_some() {
        return Err("Name already taken".into());
    }
    // Sim bots don't belong to a team and aren't player-owned. They get a
    // fabricated credential identity so the auction/word path stays uniform.
    let identity = Identity::from_claims("sim", trimmed);
    if ctx.db.bot_credential().identity().find(identity).is_some() {
        return Err("Simulated bot already exists".into());
    }
    let bot = ctx.db.bot().insert(Bot {
        id: 0,
        name: trimmed.to_string(),
        team_id: 0,
        is_simulated: true,
        strategy,
        created_at: ctx.timestamp,
    });
    ctx.db.bot_credential().insert(BotCredential {
        identity,
        bot_id: bot.id,
        connected: true,
        last_seen: ctx.timestamp,
    });
    log::info!("Simulated bot spawned: {} (id {})", trimmed, bot.id);
    Ok(())
}

// ---------- Match control ----------

#[reducer]
pub fn start_match(ctx: &ReducerContext, auction_type: AuctionType) -> Result<(), String> {
    let participants: Vec<u64> = ctx.db.bot().iter().map(|b| b.id).collect();
    start_match_with(ctx, auction_type, participants)
}

#[reducer]
pub fn start_match_for(
    ctx: &ReducerContext,
    auction_type: AuctionType,
    participants: Vec<u64>,
) -> Result<(), String> {
    start_match_with(ctx, auction_type, participants)
}

fn start_match_with(
    ctx: &ReducerContext,
    auction_type: AuctionType,
    participants: Vec<u64>,
) -> Result<(), String> {
    if participants.is_empty() {
        return Err("Need at least one participant".into());
    }
    let bag_total: u32 = letters::DEFAULT_BAG.iter().map(|(_, c)| c).sum();
    let m = ctx.db.match_state().insert(Match {
        id: 0,
        status: MatchStatus::Running,
        current_round: 1,
        current_auction_id: None,
        bag_total,
        auction_type,
        created_at: ctx.timestamp,
        started_at: Some(ctx.timestamp),
        ended_at: None,
    });
    let match_id = m.id;

    for bot_id in &participants {
        if ctx.db.bot().id().find(*bot_id).is_none() {
            return Err(format!("Unknown bot in roster: {}", bot_id));
        }
        ctx.db.match_participant().insert(MatchParticipant {
            id: 0,
            match_id,
            bot_id: *bot_id,
            balance: STARTING_BALANCE,
            score: 0,
        });
    }

    for (letter, count) in letters::DEFAULT_BAG.iter() {
        ctx.db.bag_letter().insert(BagLetter {
            id: 0,
            match_id,
            letter: letter.to_string(),
            remaining: *count,
        });
    }

    let first_letter = draw_letter(ctx, match_id).ok_or("Bag empty")?;
    let opens_at = ctx.timestamp;
    let closes_at = ctx.timestamp + Duration::from_millis(AUCTION_DURATION_MS);
    let auction = ctx.db.auction().insert(Auction {
        id: 0,
        match_id,
        letter: first_letter,
        opens_at,
        closes_at,
        status: AuctionStatus::Open,
    });

    let m = ctx.db.match_state().id().find(match_id).unwrap();
    ctx.db.match_state().id().update(Match {
        current_auction_id: Some(auction.id),
        ..m
    });

    ctx.db.auction_schedule().insert(AuctionSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(closes_at),
        match_id,
    });

    simulate_bids(ctx, &auction);

    log::info!(
        "Match {} started with {} participants",
        match_id,
        participants.len()
    );
    Ok(())
}

// ---------- Bidding ----------

#[reducer]
pub fn submit_bid(ctx: &ReducerContext, auction_id: u64, amount: i64) -> Result<(), String> {
    if amount < 0 {
        return Err("Bid must be non-negative".into());
    }
    let bot_id = caller_bot_id(ctx).ok_or("Your identity is not a credential for any bot")?;
    let auction = ctx
        .db
        .auction()
        .id()
        .find(auction_id)
        .ok_or("Unknown auction")?;
    if auction.status != AuctionStatus::Open {
        return Err("Auction closed".into());
    }
    if ctx.timestamp >= auction.closes_at {
        return Err("Auction window expired".into());
    }
    let participant =
        find_participant(ctx, auction.match_id, bot_id).ok_or("Not in this match")?;
    if participant.balance < amount {
        return Err("Insufficient balance".into());
    }

    let existing: Vec<u64> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(auction_id)
        .filter(|b| b.bidder_bot_id == bot_id)
        .map(|b| b.id)
        .collect();
    for id in existing {
        ctx.db.pending_bid().id().delete(id);
    }

    ctx.db.pending_bid().insert(PendingBid {
        id: 0,
        auction_id,
        bidder_bot_id: bot_id,
        amount,
        submitted_at: ctx.timestamp,
    });
    Ok(())
}

// ---------- Word play ----------

#[reducer]
pub fn submit_word(
    ctx: &ReducerContext,
    match_id: u64,
    word: String,
) -> Result<(), String> {
    let m = ctx
        .db
        .match_state()
        .id()
        .find(match_id)
        .ok_or("Unknown match")?;
    if m.status != MatchStatus::Running {
        return Err("Match not running".into());
    }
    let bot_id = caller_bot_id(ctx).ok_or("Your identity is not a credential for any bot")?;
    let participant =
        find_participant(ctx, match_id, bot_id).ok_or("Not in this match")?;

    let word_upper = word.to_ascii_uppercase();
    if word_upper.len() < 2 {
        return Err("Word must be at least 2 letters".into());
    }
    if !word_upper.chars().all(|c| c.is_ascii_uppercase()) {
        return Err("Word must be A-Z only".into());
    }
    if !dictionary::is_valid_word(&word_upper) {
        return Err(format!("'{}' is not in the dictionary", word_upper));
    }

    play_word(ctx, participant, &word_upper)
}

// ---------- Matchmaker ----------

#[reducer]
pub fn set_matchmaker_enabled(
    ctx: &ReducerContext,
    enabled: bool,
    match_size_min: u32,
    match_size_max: u32,
    interval_ms: u64,
    auction_type: AuctionType,
) -> Result<(), String> {
    if match_size_min < 2 || match_size_max < match_size_min {
        return Err("Need match_size_min >= 2 and max >= min".into());
    }
    if interval_ms < 1000 {
        return Err("Matchmaker interval must be >= 1000 ms".into());
    }
    let existing = ctx.db.matchmaker_config().id().find(0);
    if let Some(cfg) = existing {
        ctx.db.matchmaker_config().id().update(MatchmakerConfig {
            enabled,
            match_size_min,
            match_size_max,
            interval_ms,
            auction_type,
            ..cfg
        });
    } else {
        ctx.db.matchmaker_config().insert(MatchmakerConfig {
            id: 0,
            enabled,
            match_size_min,
            match_size_max,
            interval_ms,
            auction_type,
        });
    }
    if enabled && !is_matchmaker_scheduled(ctx) {
        ctx.db.matchmaker_schedule().insert(MatchmakerSchedule {
            scheduled_id: 0,
            scheduled_at: ScheduleAt::Time(
                ctx.timestamp + Duration::from_millis(interval_ms),
            ),
        });
    }
    Ok(())
}

fn is_matchmaker_scheduled(ctx: &ReducerContext) -> bool {
    ctx.db.matchmaker_schedule().iter().next().is_some()
}

#[reducer]
pub fn matchmaker_tick(ctx: &ReducerContext, _job: MatchmakerSchedule) {
    let cfg = match ctx.db.matchmaker_config().id().find(0) {
        Some(c) => c,
        None => return,
    };
    if !cfg.enabled {
        return;
    }

    let mut busy_bot_ids = std::collections::HashSet::new();
    let running_matches: Vec<u64> = ctx
        .db
        .match_state()
        .iter()
        .filter(|m| m.status == MatchStatus::Running)
        .map(|m| m.id)
        .collect();
    for mid in &running_matches {
        for p in ctx.db.match_participant().mp_by_match().filter(*mid) {
            busy_bot_ids.insert(p.bot_id);
        }
    }
    let mut available: Vec<u64> = ctx
        .db
        .bot()
        .iter()
        .filter(|b| !busy_bot_ids.contains(&b.id))
        .map(|b| b.id)
        .collect();

    if available.len() >= cfg.match_size_min as usize {
        let take = (cfg.match_size_max as usize).min(available.len());
        for i in (1..available.len()).rev() {
            let j = ctx.rng().gen_range(0..=i);
            available.swap(i, j);
        }
        let roster: Vec<u64> = available.into_iter().take(take).collect();
        let _ = start_match_with(ctx, cfg.auction_type.clone(), roster);
    }

    ctx.db.matchmaker_schedule().insert(MatchmakerSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(
            ctx.timestamp + Duration::from_millis(cfg.interval_ms),
        ),
    });
}

// ---------- Tournament ----------

#[reducer]
pub fn start_tournament(
    ctx: &ReducerContext,
    swiss_rounds_total: u32,
    top_cut: u32,
    match_size: u32,
    auction_type: AuctionType,
) -> Result<(), String> {
    if match_size < 2 {
        return Err("Tournament match_size must be >= 2".into());
    }
    if swiss_rounds_total < 1 {
        return Err("Need at least 1 Swiss round".into());
    }
    if top_cut < 2 {
        return Err("top_cut must be >= 2".into());
    }
    let bots: Vec<u64> = ctx.db.bot().iter().map(|b| b.id).collect();
    if bots.len() < match_size as usize {
        return Err(format!(
            "Need at least {} registered bots to start",
            match_size
        ));
    }
    let t = ctx.db.tournament().insert(Tournament {
        id: 0,
        status: TournamentStatus::Swiss,
        swiss_rounds_total,
        current_round: 0,
        top_cut,
        match_size,
        auction_type: auction_type.clone(),
        created_at: ctx.timestamp,
        ended_at: None,
    });
    for bot_id in &bots {
        ctx.db.tournament_entry().insert(TournamentEntry {
            id: 0,
            tournament_id: t.id,
            bot_id: *bot_id,
            swiss_points: 0,
            eliminated: false,
        });
    }
    start_swiss_round(ctx, t.id, 1)?;
    Ok(())
}

fn start_swiss_round(
    ctx: &ReducerContext,
    tournament_id: u64,
    round: u32,
) -> Result<(), String> {
    let t = ctx
        .db
        .tournament()
        .id()
        .find(tournament_id)
        .ok_or("Unknown tournament")?;
    ctx.db.tournament().id().update(Tournament {
        current_round: round,
        ..t.clone()
    });
    let mut entries: Vec<TournamentEntry> = ctx
        .db
        .tournament_entry()
        .te_by_tournament()
        .filter(tournament_id)
        .filter(|e| !e.eliminated)
        .collect();
    if round == 1 {
        for i in (1..entries.len()).rev() {
            let j = ctx.rng().gen_range(0..=i);
            entries.swap(i, j);
        }
    } else {
        entries.sort_by(|a, b| b.swiss_points.cmp(&a.swiss_points));
    }
    pair_into_matches(ctx, &t, &entries, round, TournamentPhase::Swiss)
}

fn pair_into_matches(
    ctx: &ReducerContext,
    t: &Tournament,
    entries: &[TournamentEntry],
    round: u32,
    phase: TournamentPhase,
) -> Result<(), String> {
    let match_size = t.match_size as usize;
    let mut i = 0;
    while i + match_size <= entries.len() {
        let roster: Vec<u64> = entries[i..i + match_size].iter().map(|e| e.bot_id).collect();
        let prev_matches: Vec<u64> = ctx.db.match_state().iter().map(|m| m.id).collect();
        start_match_with(ctx, t.auction_type.clone(), roster)?;
        let new_match_id = ctx
            .db
            .match_state()
            .iter()
            .map(|m| m.id)
            .filter(|id| !prev_matches.contains(id))
            .max()
            .unwrap_or(0);
        ctx.db.tournament_match().insert(TournamentMatch {
            id: 0,
            tournament_id: t.id,
            match_id: new_match_id,
            round,
            phase: phase.clone(),
        });
        i += match_size;
    }
    Ok(())
}

fn on_match_ended(ctx: &ReducerContext, match_id: u64) {
    update_elo_at_match_end(ctx, match_id);

    let Some(tm) = ctx
        .db
        .tournament_match()
        .tm_by_match()
        .filter(match_id)
        .next()
    else {
        return;
    };
    let Some(t) = ctx.db.tournament().id().find(tm.tournament_id) else {
        return;
    };

    let participants: Vec<MatchParticipant> = ctx
        .db
        .match_participant()
        .mp_by_match()
        .filter(match_id)
        .collect();
    let mut placed = participants;
    placed.sort_by(|a, b| b.score.cmp(&a.score));

    match tm.phase {
        TournamentPhase::Swiss => {
            let n = placed.len() as i32;
            for (idx, p) in placed.iter().enumerate() {
                let pts = n - idx as i32;
                let entry: Option<TournamentEntry> = ctx
                    .db
                    .tournament_entry()
                    .te_by_tournament()
                    .filter(t.id)
                    .find(|e| e.bot_id == p.bot_id);
                if let Some(e) = entry {
                    ctx.db.tournament_entry().id().update(TournamentEntry {
                        swiss_points: e.swiss_points + pts,
                        ..e
                    });
                }
            }
        }
        TournamentPhase::Bracket => {
            // Eliminate only the last-place bot.
            if let Some(last) = placed.last() {
                let entry: Option<TournamentEntry> = ctx
                    .db
                    .tournament_entry()
                    .te_by_tournament()
                    .filter(t.id)
                    .find(|e| e.bot_id == last.bot_id);
                if let Some(e) = entry {
                    ctx.db.tournament_entry().id().update(TournamentEntry {
                        eliminated: true,
                        ..e
                    });
                }
            }
        }
        TournamentPhase::Final => {
            // Finals are best-of-3, decided after all 3 games.
        }
    }

    if tm.phase == TournamentPhase::Final {
        let final_games_done = ctx
            .db
            .tournament_match()
            .tm_by_tournament()
            .filter(t.id)
            .filter(|m| m.phase == TournamentPhase::Final)
            .filter(|m| {
                ctx.db
                    .match_state()
                    .id()
                    .find(m.match_id)
                    .map(|mm| mm.status == MatchStatus::Ended)
                    .unwrap_or(false)
            })
            .count();
        if final_games_done < 3 {
            let _ = start_final_game(ctx, t.id, final_games_done as u32 + 1);
        } else {
            let finalists: Vec<u64> = ctx
                .db
                .tournament_entry()
                .te_by_tournament()
                .filter(t.id)
                .filter(|e| !e.eliminated)
                .map(|e| e.bot_id)
                .collect();
            let mut totals: Vec<(u64, i64)> = finalists
                .iter()
                .map(|b| (*b, aggregate_final_score(ctx, t.id, *b)))
                .collect();
            totals.sort_by(|a, b| b.1.cmp(&a.1));
            if let Some((loser, _)) = totals.last() {
                let entry: Option<TournamentEntry> = ctx
                    .db
                    .tournament_entry()
                    .te_by_tournament()
                    .filter(t.id)
                    .find(|e| e.bot_id == *loser);
                if let Some(e) = entry {
                    ctx.db.tournament_entry().id().update(TournamentEntry {
                        eliminated: true,
                        ..e
                    });
                }
            }
            ctx.db.tournament().id().update(Tournament {
                status: TournamentStatus::Ended,
                ended_at: Some(ctx.timestamp),
                ..t
            });
            log::info!("Tournament ended");
        }
        return;
    }

    let round_done = ctx
        .db
        .tournament_match()
        .tm_by_tournament()
        .filter(t.id)
        .filter(|m| m.round == tm.round && m.phase == tm.phase)
        .all(|m| {
            ctx.db
                .match_state()
                .id()
                .find(m.match_id)
                .map(|mm| mm.status == MatchStatus::Ended)
                .unwrap_or(false)
        });
    if !round_done {
        return;
    }
    advance_tournament(ctx, t.id);
}

fn aggregate_final_score(
    ctx: &ReducerContext,
    tournament_id: u64,
    bot_id: u64,
) -> i64 {
    let mut total: i64 = 0;
    let final_matches: Vec<u64> = ctx
        .db
        .tournament_match()
        .tm_by_tournament()
        .filter(tournament_id)
        .filter(|m| m.phase == TournamentPhase::Final)
        .map(|m| m.match_id)
        .collect();
    for mid in final_matches {
        let p = ctx
            .db
            .match_participant()
            .mp_by_match()
            .filter(mid)
            .find(|p| p.bot_id == bot_id);
        if let Some(p) = p {
            total += p.score;
        }
    }
    total
}

fn advance_tournament(ctx: &ReducerContext, tournament_id: u64) {
    let Some(t) = ctx.db.tournament().id().find(tournament_id) else {
        return;
    };
    match t.status {
        TournamentStatus::Swiss => {
            if t.current_round < t.swiss_rounds_total {
                let _ = start_swiss_round(ctx, t.id, t.current_round + 1);
            } else {
                let mut entries: Vec<TournamentEntry> = ctx
                    .db
                    .tournament_entry()
                    .te_by_tournament()
                    .filter(t.id)
                    .collect();
                entries.sort_by(|a, b| b.swiss_points.cmp(&a.swiss_points));
                let kept = t.top_cut as usize;
                for (i, e) in entries.iter().enumerate() {
                    if i >= kept {
                        ctx.db.tournament_entry().id().update(TournamentEntry {
                            eliminated: true,
                            ..e.clone()
                        });
                    }
                }
                ctx.db.tournament().id().update(Tournament {
                    status: TournamentStatus::Bracket,
                    current_round: 0,
                    ..t.clone()
                });
                let _ = start_elimination_round(ctx, t.id);
            }
        }
        TournamentStatus::Bracket => {
            let remaining = ctx
                .db
                .tournament_entry()
                .te_by_tournament()
                .filter(t.id)
                .filter(|e| !e.eliminated)
                .count();
            if remaining <= 1 {
                ctx.db.tournament().id().update(Tournament {
                    status: TournamentStatus::Ended,
                    ended_at: Some(ctx.timestamp),
                    ..t
                });
            } else if remaining == 2 {
                ctx.db.tournament().id().update(Tournament {
                    status: TournamentStatus::Final,
                    current_round: 0,
                    ..t.clone()
                });
                let _ = start_final_game(ctx, t.id, 1);
            } else {
                let _ = start_elimination_round(ctx, t.id);
            }
        }
        _ => {}
    }
}

fn start_elimination_round(
    ctx: &ReducerContext,
    tournament_id: u64,
) -> Result<(), String> {
    let t = ctx
        .db
        .tournament()
        .id()
        .find(tournament_id)
        .ok_or("Unknown tournament")?;
    let roster: Vec<u64> = ctx
        .db
        .tournament_entry()
        .te_by_tournament()
        .filter(t.id)
        .filter(|e| !e.eliminated)
        .map(|e| e.bot_id)
        .collect();
    if roster.len() < 2 {
        return Ok(());
    }
    let next_round = t.current_round + 1;
    ctx.db.tournament().id().update(Tournament {
        current_round: next_round,
        ..t.clone()
    });
    let prev_matches: Vec<u64> = ctx.db.match_state().iter().map(|m| m.id).collect();
    start_match_with(ctx, t.auction_type.clone(), roster)?;
    let new_match_id = ctx
        .db
        .match_state()
        .iter()
        .map(|m| m.id)
        .filter(|id| !prev_matches.contains(id))
        .max()
        .unwrap_or(0);
    ctx.db.tournament_match().insert(TournamentMatch {
        id: 0,
        tournament_id: t.id,
        match_id: new_match_id,
        round: next_round,
        phase: TournamentPhase::Bracket,
    });
    Ok(())
}

fn start_final_game(
    ctx: &ReducerContext,
    tournament_id: u64,
    game_num: u32,
) -> Result<(), String> {
    let t = ctx
        .db
        .tournament()
        .id()
        .find(tournament_id)
        .ok_or("Unknown tournament")?;
    let roster: Vec<u64> = ctx
        .db
        .tournament_entry()
        .te_by_tournament()
        .filter(t.id)
        .filter(|e| !e.eliminated)
        .map(|e| e.bot_id)
        .collect();
    if roster.len() < 2 {
        return Ok(());
    }
    let prev_matches: Vec<u64> = ctx.db.match_state().iter().map(|m| m.id).collect();
    start_match_with(ctx, t.auction_type.clone(), roster)?;
    let new_match_id = ctx
        .db
        .match_state()
        .iter()
        .map(|m| m.id)
        .filter(|id| !prev_matches.contains(id))
        .max()
        .unwrap_or(0);
    ctx.db.tournament_match().insert(TournamentMatch {
        id: 0,
        tournament_id: t.id,
        match_id: new_match_id,
        round: game_num,
        phase: TournamentPhase::Final,
    });
    log::info!("Final game {} started for tournament {}", game_num, t.id);
    Ok(())
}

// ---------- ELO ----------

fn get_or_init_stats(ctx: &ReducerContext, bot_id: u64) -> BotStats {
    ctx.db.bot_stats().bot_id().find(bot_id).unwrap_or(BotStats {
        bot_id,
        rating: 1000,
        matches_played: 0,
        wins: 0,
        total_score: 0,
        last_played: None,
    })
}

fn update_elo_at_match_end(ctx: &ReducerContext, match_id: u64) {
    let mut placed: Vec<MatchParticipant> = ctx
        .db
        .match_participant()
        .mp_by_match()
        .filter(match_id)
        .collect();
    if placed.len() < 2 {
        return;
    }
    placed.sort_by(|a, b| b.score.cmp(&a.score));

    let k: f64 = 32.0;
    let mut ratings: std::collections::HashMap<u64, f64> =
        std::collections::HashMap::new();
    for p in &placed {
        let s = get_or_init_stats(ctx, p.bot_id);
        ratings.insert(p.bot_id, s.rating as f64);
    }
    let mut deltas: std::collections::HashMap<u64, f64> =
        std::collections::HashMap::new();
    for i in 0..placed.len() {
        for j in (i + 1)..placed.len() {
            let a = placed[i].bot_id;
            let b = placed[j].bot_id;
            let ra = *ratings.get(&a).unwrap();
            let rb = *ratings.get(&b).unwrap();
            let expected_a = 1.0 / (1.0 + 10f64.powf((rb - ra) / 400.0));
            let (actual_a, actual_b) = if placed[i].score > placed[j].score {
                (1.0, 0.0)
            } else if placed[i].score < placed[j].score {
                (0.0, 1.0)
            } else {
                (0.5, 0.5)
            };
            let delta_a = k * (actual_a - expected_a);
            *deltas.entry(a).or_insert(0.0) += delta_a;
            *deltas.entry(b).or_insert(0.0) += -delta_a + k * (actual_b - (1.0 - expected_a));
        }
    }
    let opponents = (placed.len() - 1) as f64;
    for (idx, p) in placed.iter().enumerate() {
        let raw_delta = *deltas.get(&p.bot_id).unwrap_or(&0.0);
        let scaled = raw_delta / opponents;
        let new_rating = ((*ratings.get(&p.bot_id).unwrap() + scaled).round() as i32).max(0);
        let existing = get_or_init_stats(ctx, p.bot_id);
        let was_win = idx == 0;
        let stats = BotStats {
            rating: new_rating,
            matches_played: existing.matches_played + 1,
            wins: existing.wins + if was_win { 1 } else { 0 },
            total_score: existing.total_score + p.score,
            last_played: Some(ctx.timestamp),
            ..existing
        };
        if ctx.db.bot_stats().bot_id().find(p.bot_id).is_some() {
            ctx.db.bot_stats().bot_id().update(stats);
        } else {
            ctx.db.bot_stats().insert(stats);
        }
    }
}

// ---------- Auction tick (scheduled) ----------

#[reducer]
pub fn auction_tick(ctx: &ReducerContext, job: AuctionSchedule) {
    let match_id = job.match_id;
    let m = match ctx.db.match_state().id().find(match_id) {
        Some(m) if m.status == MatchStatus::Running => m,
        _ => return,
    };
    let Some(auction_id) = m.current_auction_id else {
        return;
    };
    let Some(auction) = ctx.db.auction().id().find(auction_id) else {
        return;
    };

    let bids: Vec<PendingBid> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(auction_id)
        .collect();
    let mut sorted: Vec<&PendingBid> = bids.iter().filter(|b| b.amount > 0).collect();
    sorted.sort_by(|a, b| b.amount.cmp(&a.amount).then(a.id.cmp(&b.id)));

    let (winner, top_bid, paid) = match (m.auction_type.clone(), sorted.as_slice()) {
        (_, []) => (None, 0, 0),
        (AuctionType::FirstPrice, [only]) => {
            (Some(only.bidder_bot_id), only.amount, only.amount)
        }
        (AuctionType::FirstPrice, [first, ..]) => {
            (Some(first.bidder_bot_id), first.amount, first.amount)
        }
        (AuctionType::Vickrey, [only]) => {
            (Some(only.bidder_bot_id), only.amount, AUCTION_RESERVE.min(only.amount))
        }
        (AuctionType::Vickrey, [first, second, ..]) => {
            (Some(first.bidder_bot_id), first.amount, second.amount)
        }
    };

    let mut sim_winner: Option<u64> = None;
    if let Some(w) = winner {
        if let Some(participant) = find_participant(ctx, match_id, w) {
            if participant.balance >= paid {
                let bot_is_sim = ctx
                    .db
                    .bot()
                    .id()
                    .find(w)
                    .map(|b| b.is_simulated)
                    .unwrap_or(false);
                let new_balance = participant.balance - paid;
                ctx.db.match_participant().id().update(MatchParticipant {
                    balance: new_balance,
                    ..participant
                });
                let existing: Vec<Holding> = ctx
                    .db
                    .holding()
                    .holding_by_bot()
                    .filter(w)
                    .filter(|h| h.match_id == match_id && h.letter == auction.letter)
                    .collect();
                if let Some(h) = existing.into_iter().next() {
                    ctx.db.holding().id().update(Holding {
                        count: h.count + 1,
                        ..h
                    });
                } else {
                    ctx.db.holding().insert(Holding {
                        id: 0,
                        match_id,
                        bot_id: w,
                        letter: auction.letter.clone(),
                        count: 1,
                    });
                }
                if bot_is_sim {
                    sim_winner = Some(w);
                }
            }
        }
    } else {
        return_to_bag(ctx, match_id, &auction.letter);
    }

    ctx.db.auction_result().insert(AuctionResult {
        auction_id,
        match_id,
        letter: auction.letter.clone(),
        winner_bot_id: winner,
        top_bid,
        paid,
        closed_at: ctx.timestamp,
    });
    ctx.db.auction().id().update(Auction {
        status: AuctionStatus::Closed,
        ..auction
    });
    for b in bids {
        ctx.db.pending_bid().id().delete(b.id);
    }

    if let Some(w) = sim_winner {
        simulate_word_play(ctx, match_id, w);
    }

    let m2 = ctx.db.match_state().id().find(match_id).unwrap();
    let next_letter = match draw_letter(ctx, match_id) {
        Some(l) => l,
        None => {
            ctx.db.match_state().id().update(Match {
                status: MatchStatus::Ended,
                current_auction_id: None,
                ended_at: Some(ctx.timestamp),
                ..m2
            });
            log::info!("Match {} ended (bag empty)", match_id);
            on_match_ended(ctx, match_id);
            return;
        }
    };

    let opens_at = ctx.timestamp;
    let closes_at = ctx.timestamp + Duration::from_millis(AUCTION_DURATION_MS);
    let next_auction = ctx.db.auction().insert(Auction {
        id: 0,
        match_id,
        letter: next_letter,
        opens_at,
        closes_at,
        status: AuctionStatus::Open,
    });

    let m3 = ctx.db.match_state().id().find(match_id).unwrap();
    ctx.db.match_state().id().update(Match {
        current_round: m3.current_round + 1,
        current_auction_id: Some(next_auction.id),
        ..m3
    });
    ctx.db.auction_schedule().insert(AuctionSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(closes_at),
        match_id,
    });

    simulate_bids(ctx, &next_auction);
}

// ---------- Helpers ----------

fn find_participant(
    ctx: &ReducerContext,
    match_id: u64,
    bot_id: u64,
) -> Option<MatchParticipant> {
    ctx.db
        .match_participant()
        .mp_by_match()
        .filter(match_id)
        .find(|p| p.bot_id == bot_id)
}

fn play_word(
    ctx: &ReducerContext,
    participant: MatchParticipant,
    word_upper: &str,
) -> Result<(), String> {
    let match_id = participant.match_id;
    let bot_id = participant.bot_id;

    let mut needed: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for c in word_upper.chars() {
        *needed.entry(c).or_insert(0) += 1;
    }

    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(bot_id)
        .filter(|h| h.match_id == match_id)
        .collect();
    let mut by_letter: std::collections::HashMap<char, (u64, u32)> =
        std::collections::HashMap::new();
    for h in &holdings {
        if let Some(c) = h.letter.chars().next() {
            by_letter.insert(c, (h.id, h.count));
        }
    }
    for (c, n) in &needed {
        let have = by_letter.get(c).map(|(_, ct)| *ct).unwrap_or(0);
        if have < *n {
            return Err(format!("Not enough '{}': need {}, have {}", c, n, have));
        }
    }

    for (c, n) in &needed {
        let (hid, ct) = by_letter[c];
        let new_ct = ct - n;
        if new_ct == 0 {
            ctx.db.holding().id().delete(hid);
        } else if let Some(h) = ctx.db.holding().id().find(hid) {
            ctx.db.holding().id().update(Holding {
                count: new_ct,
                ..h
            });
        }
    }

    let base_score: i64 = word_upper
        .chars()
        .map(|c| letters::letter_value(c) as i64)
        .sum();
    let (num, denom) = letters::length_multiplier(word_upper.len());
    let total_reward = base_score * num / denom;
    let bonus = total_reward - base_score;

    let new_balance = participant.balance + total_reward;
    let new_score = participant.score + total_reward;
    ctx.db.match_participant().id().update(MatchParticipant {
        balance: new_balance,
        score: new_score,
        ..participant
    });

    ctx.db.word_play().insert(WordPlay {
        id: 0,
        match_id,
        bot_id,
        word: word_upper.to_string(),
        base_score,
        bonus,
        total_reward,
        played_at: ctx.timestamp,
    });

    log::info!(
        "[match {}] '{}' played: base={}, bonus={}, total={}",
        match_id,
        word_upper,
        base_score,
        bonus,
        total_reward
    );
    Ok(())
}

fn draw_letter(ctx: &ReducerContext, match_id: u64) -> Option<String> {
    let m = ctx.db.match_state().id().find(match_id)?;
    if m.bag_total == 0 {
        return None;
    }
    let mut idx: u32 = ctx.rng().gen_range(0..m.bag_total);
    let mut entries: Vec<BagLetter> = ctx
        .db
        .bag_letter()
        .bag_by_match()
        .filter(match_id)
        .filter(|b| b.remaining > 0)
        .collect();
    entries.sort_by(|a, b| a.letter.cmp(&b.letter));
    for bag in &entries {
        if idx < bag.remaining {
            let letter = bag.letter.clone();
            let new_remaining = bag.remaining - 1;
            let bag_id = bag.id;
            let bag_match_id = bag.match_id;
            ctx.db.bag_letter().id().update(BagLetter {
                id: bag_id,
                match_id: bag_match_id,
                letter: letter.clone(),
                remaining: new_remaining,
            });
            ctx.db.match_state().id().update(Match {
                bag_total: m.bag_total - 1,
                ..m
            });
            return Some(letter);
        }
        idx -= bag.remaining;
    }
    None
}

fn return_to_bag(ctx: &ReducerContext, match_id: u64, letter: &str) {
    let entry = ctx
        .db
        .bag_letter()
        .bag_by_match()
        .filter(match_id)
        .find(|b| b.letter == letter);
    if let Some(bag) = entry {
        ctx.db.bag_letter().id().update(BagLetter {
            remaining: bag.remaining + 1,
            ..bag
        });
    } else {
        ctx.db.bag_letter().insert(BagLetter {
            id: 0,
            match_id,
            letter: letter.to_string(),
            remaining: 1,
        });
    }
    if let Some(m) = ctx.db.match_state().id().find(match_id) {
        ctx.db.match_state().id().update(Match {
            bag_total: m.bag_total + 1,
            ..m
        });
    }
}

// ---------- Simulated-bot logic ----------

fn decide_bid(strategy: &BotStrategy, letter: &str, balance: i64) -> i64 {
    let c = letter.chars().next().unwrap_or('A');
    let value = letters::letter_value(c) as i64;
    let is_vowel = matches!(c, 'A' | 'E' | 'I' | 'O' | 'U');
    let bid = match strategy {
        BotStrategy::Human => return 0,
        BotStrategy::Cheapskate => (value - 1).max(1),
        BotStrategy::ValueBidder => value,
        BotStrategy::Aggressive => value + if is_vowel { 4 } else { 2 },
    };
    bid.min(balance).max(0)
}

fn simulate_bids(ctx: &ReducerContext, auction: &Auction) {
    let participants: Vec<MatchParticipant> = ctx
        .db
        .match_participant()
        .mp_by_match()
        .filter(auction.match_id)
        .collect();
    for p in participants {
        let Some(bot) = ctx.db.bot().id().find(p.bot_id) else {
            continue;
        };
        if !bot.is_simulated {
            continue;
        }
        let amount = decide_bid(&bot.strategy, &auction.letter, p.balance);
        if amount <= 0 {
            continue;
        }
        let prior: Vec<u64> = ctx
            .db
            .pending_bid()
            .bid_by_auction()
            .filter(auction.id)
            .filter(|b| b.bidder_bot_id == bot.id)
            .map(|b| b.id)
            .collect();
        for id in prior {
            ctx.db.pending_bid().id().delete(id);
        }
        ctx.db.pending_bid().insert(PendingBid {
            id: 0,
            auction_id: auction.id,
            bidder_bot_id: bot.id,
            amount,
            submitted_at: ctx.timestamp,
        });
    }
}

fn simulate_word_play(ctx: &ReducerContext, match_id: u64, bot_id: u64) {
    let Some(participant) = find_participant(ctx, match_id, bot_id) else {
        return;
    };
    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(bot_id)
        .filter(|h| h.match_id == match_id)
        .collect();
    let mut rack: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for h in &holdings {
        if let Some(c) = h.letter.chars().next() {
            *rack.entry(c).or_insert(0) += h.count;
        }
    }
    let Some(word) = dictionary::find_best_playable(&rack, 3) else {
        return;
    };
    let _ = play_word(ctx, participant, &word);
}
