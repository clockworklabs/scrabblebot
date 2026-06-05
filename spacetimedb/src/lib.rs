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
// Reserve price for a Vickrey auction with a single bidder.
const AUCTION_RESERVE: i64 = 1;

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
    Ended,
}

#[derive(SpacetimeType, Clone, Debug, PartialEq)]
pub enum TournamentPhase {
    Swiss,
    Bracket,
}

// ---------- Tables ----------

// Bot — global registration. No per-match state lives here anymore.
#[table(accessor = bot, public)]
pub struct Bot {
    #[primary_key]
    pub identity: Identity,
    #[unique]
    pub name: String,
    pub connected: bool,
    pub registered_at: Timestamp,
    pub is_simulated: bool,
    pub strategy: BotStrategy,
}

// Match — one row per match. Replaces the old singleton MatchState.
#[table(
    accessor = match_state,
    public,
    index(accessor = match_by_status, btree(columns = [status]))
)]
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
    index(accessor = mp_by_bot, btree(columns = [bot]))
)]
pub struct MatchParticipant {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot: Identity,
    pub balance: i64,
    pub score: i64,
}

// Private — each match has its own bag.
#[table(
    accessor = bag_letter,
    index(accessor = bag_by_match, btree(columns = [match_id]))
)]
pub struct BagLetter {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub letter: String,
    pub remaining: u32,
}

// Private — each bot sees only their own rack via `my_rack`.
#[table(
    accessor = holding,
    index(accessor = holding_by_bot, btree(columns = [bot])),
    index(accessor = holding_by_match, btree(columns = [match_id]))
)]
pub struct Holding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot: Identity,
    pub letter: String,
    pub count: u32,
}

#[table(
    accessor = auction,
    public,
    index(accessor = auction_by_match, btree(columns = [match_id])),
    index(accessor = auction_by_status, btree(columns = [status]))
)]
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
pub struct PendingBid {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub auction_id: u64,
    pub bidder: Identity,
    pub amount: i64,
    pub submitted_at: Timestamp,
}

#[table(
    accessor = auction_result,
    public,
    index(accessor = result_by_match, btree(columns = [match_id]))
)]
pub struct AuctionResult {
    #[primary_key]
    pub auction_id: u64,
    pub match_id: u64,
    pub letter: String,
    pub winner: Option<Identity>,
    pub top_bid: i64,
    pub paid: i64,
    pub closed_at: Timestamp,
}

#[table(
    accessor = word_play,
    public,
    index(accessor = play_by_match, btree(columns = [match_id])),
    index(accessor = play_by_bot, btree(columns = [bot]))
)]
pub struct WordPlay {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub match_id: u64,
    pub bot: Identity,
    pub word: String,
    pub base_score: i64,
    pub bonus: i64,
    pub total_reward: i64,
    pub played_at: Timestamp,
}

#[table(accessor = auction_schedule, scheduled(auction_tick))]
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
    pub bot: Identity,
    pub rating: i32, // ELO; new bots start at 1000
    pub matches_played: u32,
    pub wins: u32, // first-place finishes
    pub total_score: i64,
    pub last_played: Option<Timestamp>,
}

// Singleton-ish config row (id always 0) controlling the continuous matchmaker.
#[table(accessor = matchmaker_config, public)]
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

// One row per bot competing in a tournament.
#[table(
    accessor = tournament_entry,
    public,
    index(accessor = te_by_tournament, btree(columns = [tournament_id])),
    index(accessor = te_by_bot, btree(columns = [bot]))
)]
#[derive(Clone)]
pub struct TournamentEntry {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub tournament_id: u64,
    pub bot: Identity,
    pub swiss_points: i32,
    pub eliminated: bool,
}

// Links a Match to a tournament round.
#[table(
    accessor = tournament_match,
    public,
    index(accessor = tm_by_tournament, btree(columns = [tournament_id])),
    index(accessor = tm_by_match, btree(columns = [match_id]))
)]
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
    ctx.db
        .holding()
        .holding_by_bot()
        .filter(ctx.sender())
        .collect()
}

// ---------- Lifecycle ----------

#[reducer(init)]
pub fn init(_ctx: &ReducerContext) {
    // Nothing global to bootstrap — matches and bags are per-match now.
}

#[reducer(client_connected)]
pub fn client_connected(ctx: &ReducerContext) {
    if let Some(bot) = ctx.db.bot().identity().find(ctx.sender()) {
        ctx.db.bot().identity().update(Bot {
            connected: true,
            ..bot
        });
    }
}

#[reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    if let Some(bot) = ctx.db.bot().identity().find(ctx.sender()) {
        ctx.db.bot().identity().update(Bot {
            connected: false,
            ..bot
        });
    }
}

// ---------- Bot management ----------

#[reducer]
pub fn register_bot(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 32 {
        return Err("Name must be 1-32 characters".into());
    }
    if ctx.db.bot().identity().find(ctx.sender()).is_some() {
        return Err("This identity is already registered".into());
    }
    if ctx.db.bot().name().find(trimmed.to_string()).is_some() {
        return Err("Name already taken".into());
    }
    ctx.db.bot().insert(Bot {
        identity: ctx.sender(),
        name: trimmed.to_string(),
        connected: true,
        registered_at: ctx.timestamp,
        is_simulated: false,
        strategy: BotStrategy::Human,
    });
    log::info!("Bot registered: {}", trimmed);
    Ok(())
}

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
    let identity = Identity::from_claims("sim", trimmed);
    if ctx.db.bot().identity().find(identity).is_some() {
        return Err("Simulated bot already exists".into());
    }
    ctx.db.bot().insert(Bot {
        identity,
        name: trimmed.to_string(),
        connected: true,
        registered_at: ctx.timestamp,
        is_simulated: true,
        strategy,
    });
    log::info!("Simulated bot spawned: {}", trimmed);
    Ok(())
}

// ---------- Match control ----------

// Start a match with every currently-registered bot.
#[reducer]
pub fn start_match(ctx: &ReducerContext, auction_type: AuctionType) -> Result<(), String> {
    let participants: Vec<Identity> = ctx.db.bot().iter().map(|b| b.identity).collect();
    start_match_with(ctx, auction_type, participants)
}

// Start a match with a specific roster.
#[reducer]
pub fn start_match_for(
    ctx: &ReducerContext,
    auction_type: AuctionType,
    participants: Vec<Identity>,
) -> Result<(), String> {
    start_match_with(ctx, auction_type, participants)
}

fn start_match_with(
    ctx: &ReducerContext,
    auction_type: AuctionType,
    participants: Vec<Identity>,
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

    for identity in &participants {
        if ctx.db.bot().identity().find(*identity).is_none() {
            return Err(format!("Unknown bot in roster: {}", identity.to_hex()));
        }
        ctx.db.match_participant().insert(MatchParticipant {
            id: 0,
            match_id,
            bot: *identity,
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
        find_participant(ctx, auction.match_id, ctx.sender()).ok_or("Not in this match")?;
    if participant.balance < amount {
        return Err("Insufficient balance".into());
    }

    let existing: Vec<u64> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(auction_id)
        .filter(|b| b.bidder == ctx.sender())
        .map(|b| b.id)
        .collect();
    for id in existing {
        ctx.db.pending_bid().id().delete(id);
    }

    ctx.db.pending_bid().insert(PendingBid {
        id: 0,
        auction_id,
        bidder: ctx.sender(),
        amount,
        submitted_at: ctx.timestamp,
    });
    Ok(())
}

// ---------- Word play ----------

#[reducer]
pub fn submit_word(ctx: &ReducerContext, match_id: u64, word: String) -> Result<(), String> {
    let m = ctx
        .db
        .match_state()
        .id()
        .find(match_id)
        .ok_or("Unknown match")?;
    if m.status != MatchStatus::Running {
        return Err("Match not running".into());
    }
    let participant =
        find_participant(ctx, match_id, ctx.sender()).ok_or("Not in this match")?;

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

    // Eligible bots: registered, not currently in a running match.
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
            busy_bot_ids.insert(p.bot);
        }
    }
    let mut available: Vec<Identity> = ctx
        .db
        .bot()
        .iter()
        .filter(|b| !busy_bot_ids.contains(&b.identity))
        .map(|b| b.identity)
        .collect();

    if available.len() >= cfg.match_size_min as usize {
        let take = (cfg.match_size_max as usize).min(available.len());
        // Shuffle deterministically using ctx.rng.
        for i in (1..available.len()).rev() {
            let j = ctx.rng().gen_range(0..=i);
            available.swap(i, j);
        }
        let roster: Vec<Identity> = available.into_iter().take(take).collect();
        let _ = start_match_with(ctx, cfg.auction_type.clone(), roster);
    }

    // Reschedule next tick.
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
    // For simplicity, require an even number of bots that's >= match_size.
    let bots: Vec<Identity> = ctx.db.bot().iter().map(|b| b.identity).collect();
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
    for bot in &bots {
        ctx.db.tournament_entry().insert(TournamentEntry {
            id: 0,
            tournament_id: t.id,
            bot: *bot,
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
    // Sort entries by current Swiss points (desc); round 1 is effectively
    // random because everyone is tied at 0. Then pair adjacent groups.
    let mut entries: Vec<TournamentEntry> = ctx
        .db
        .tournament_entry()
        .te_by_tournament()
        .filter(tournament_id)
        .filter(|e| !e.eliminated)
        .collect();
    if round == 1 {
        // randomize once
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
        let roster: Vec<Identity> = entries[i..i + match_size].iter().map(|e| e.bot).collect();
        let prev_matches: Vec<u64> = ctx.db.match_state().iter().map(|m| m.id).collect();
        start_match_with(ctx, t.auction_type.clone(), roster)?;
        // The match just created has the highest id.
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

// Called from auction_tick when a match ends. If that match was part of a
// tournament, award Swiss points (or eliminate bracket losers) and, if the
// round is now complete, start the next round (or end the tournament).
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

    // Sort participants by final score desc to determine placements.
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
            // Award Swiss points: 1st = N, 2nd = N-1, ... last = 1.
            let n = placed.len() as i32;
            for (idx, p) in placed.iter().enumerate() {
                let pts = n - idx as i32;
                let entry: Option<TournamentEntry> = ctx
                    .db
                    .tournament_entry()
                    .te_by_tournament()
                    .filter(t.id)
                    .find(|e| e.bot == p.bot);
                if let Some(e) = entry {
                    ctx.db.tournament_entry().id().update(TournamentEntry {
                        swiss_points: e.swiss_points + pts,
                        ..e
                    });
                }
            }
        }
        TournamentPhase::Bracket => {
            // Top half advance; bottom half eliminated.
            let cutoff = placed.len() / 2;
            for (idx, p) in placed.iter().enumerate() {
                if idx >= cutoff {
                    let entry: Option<TournamentEntry> = ctx
                        .db
                        .tournament_entry()
                        .te_by_tournament()
                        .filter(t.id)
                        .find(|e| e.bot == p.bot);
                    if let Some(e) = entry {
                        ctx.db.tournament_entry().id().update(TournamentEntry {
                            eliminated: true,
                            ..e
                        });
                    }
                }
            }
        }
    }

    // Is this round complete? All TournamentMatch rows for this round refer
    // to Matches that are Ended.
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

fn advance_tournament(ctx: &ReducerContext, tournament_id: u64) {
    let Some(t) = ctx.db.tournament().id().find(tournament_id) else {
        return;
    };
    match t.status {
        TournamentStatus::Swiss => {
            if t.current_round < t.swiss_rounds_total {
                let _ = start_swiss_round(ctx, t.id, t.current_round + 1);
            } else {
                // Cut to top N, enter bracket phase.
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
                let _ = start_bracket_round(ctx, t.id);
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
            } else {
                let _ = start_bracket_round(ctx, t.id);
            }
        }
        _ => {}
    }
}

fn start_bracket_round(
    ctx: &ReducerContext,
    tournament_id: u64,
) -> Result<(), String> {
    let t = ctx
        .db
        .tournament()
        .id()
        .find(tournament_id)
        .ok_or("Unknown tournament")?;
    let entries: Vec<TournamentEntry> = ctx
        .db
        .tournament_entry()
        .te_by_tournament()
        .filter(t.id)
        .filter(|e| !e.eliminated)
        .collect();
    if entries.len() < 2 {
        return Ok(());
    }
    let next_round = t.current_round + 1;
    ctx.db.tournament().id().update(Tournament {
        current_round: next_round,
        ..t.clone()
    });
    // For finals (2 left), reduce match_size to 2 so it's a 1v1.
    let effective = if entries.len() < t.match_size as usize {
        let mut t2 = t.clone();
        t2.match_size = entries.len() as u32;
        t2
    } else {
        t.clone()
    };
    pair_into_matches(ctx, &effective, &entries, next_round, TournamentPhase::Bracket)
}

// ---------- ELO ----------

fn get_or_init_stats(ctx: &ReducerContext, bot: Identity) -> BotStats {
    ctx.db.bot_stats().bot().find(bot).unwrap_or(BotStats {
        bot,
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
    // Build a mutable ratings map seeded from current stats.
    let mut ratings: std::collections::HashMap<Identity, f64> =
        std::collections::HashMap::new();
    for p in &placed {
        let s = get_or_init_stats(ctx, p.bot);
        ratings.insert(p.bot, s.rating as f64);
    }
    let mut deltas: std::collections::HashMap<Identity, f64> =
        std::collections::HashMap::new();
    for i in 0..placed.len() {
        for j in (i + 1)..placed.len() {
            // i ranks above j (higher score). If tied, treat as draw.
            let a = placed[i].bot;
            let b = placed[j].bot;
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
    // Average per-opponent deltas so K applies once total.
    let opponents = (placed.len() - 1) as f64;
    for (idx, p) in placed.iter().enumerate() {
        let raw_delta = *deltas.get(&p.bot).unwrap_or(&0.0);
        let scaled = raw_delta / opponents;
        let new_rating = ((*ratings.get(&p.bot).unwrap() + scaled).round() as i32).max(0);
        let existing = get_or_init_stats(ctx, p.bot);
        let was_win = idx == 0;
        let stats = BotStats {
            rating: new_rating,
            matches_played: existing.matches_played + 1,
            wins: existing.wins + if was_win { 1 } else { 0 },
            total_score: existing.total_score + p.score,
            last_played: Some(ctx.timestamp),
            ..existing
        };
        if ctx.db.bot_stats().bot().find(p.bot).is_some() {
            ctx.db.bot_stats().bot().update(stats);
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
        (AuctionType::FirstPrice, [only]) => (Some(only.bidder), only.amount, only.amount),
        (AuctionType::FirstPrice, [first, ..]) => (Some(first.bidder), first.amount, first.amount),
        (AuctionType::Vickrey, [only]) => {
            (Some(only.bidder), only.amount, AUCTION_RESERVE.min(only.amount))
        }
        (AuctionType::Vickrey, [first, second, ..]) => {
            (Some(first.bidder), first.amount, second.amount)
        }
    };

    let mut sim_winner: Option<Identity> = None;
    if let Some(w) = winner {
        if let Some(participant) = find_participant(ctx, match_id, w) {
            if participant.balance >= paid {
                let bot_is_sim = ctx
                    .db
                    .bot()
                    .identity()
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
                        bot: w,
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
        winner,
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
    bot: Identity,
) -> Option<MatchParticipant> {
    ctx.db
        .match_participant()
        .mp_by_match()
        .filter(match_id)
        .find(|p| p.bot == bot)
}

fn play_word(
    ctx: &ReducerContext,
    participant: MatchParticipant,
    word_upper: &str,
) -> Result<(), String> {
    let match_id = participant.match_id;
    let bot_identity = participant.bot;

    let mut needed: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for c in word_upper.chars() {
        *needed.entry(c).or_insert(0) += 1;
    }

    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(bot_identity)
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
        bot: bot_identity,
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
        let Some(bot) = ctx.db.bot().identity().find(p.bot) else {
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
            .filter(|b| b.bidder == bot.identity)
            .map(|b| b.id)
            .collect();
        for id in prior {
            ctx.db.pending_bid().id().delete(id);
        }
        ctx.db.pending_bid().insert(PendingBid {
            id: 0,
            auction_id: auction.id,
            bidder: bot.identity,
            amount,
            submitted_at: ctx.timestamp,
        });
    }
}

fn simulate_word_play(ctx: &ReducerContext, match_id: u64, bot_identity: Identity) {
    let Some(participant) = find_participant(ctx, match_id, bot_identity) else {
        return;
    };
    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(bot_identity)
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
