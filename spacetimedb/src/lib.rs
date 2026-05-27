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
const SINGLETON_MATCH_ID: u32 = 0;
// Reserve price for a Vickrey auction with a single bidder.
const AUCTION_RESERVE: i64 = 1;

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
    Human,        // real client bot — module makes no decisions
    Cheapskate,   // always bids 1
    ValueBidder,  // bids letter face value + 1
    Aggressive,   // bids letter value × 2 + 2
}

#[table(accessor = bot, public)]
pub struct Bot {
    #[primary_key]
    pub identity: Identity,
    #[unique]
    pub name: String,
    pub balance: i64,
    pub score: i64,
    pub connected: bool,
    pub registered_at: Timestamp,
    pub is_simulated: bool,
    pub strategy: BotStrategy,
}

#[table(accessor = match_state, public)]
pub struct MatchState {
    #[primary_key]
    pub id: u32,
    pub status: MatchStatus,
    pub current_round: u32,
    pub current_auction_id: Option<u64>,
    pub bag_total: u32,
    pub auction_type: AuctionType,
    pub started_at: Option<Timestamp>,
    pub ended_at: Option<Timestamp>,
}

// Private — bots & spectators see only the total via the `bag_remaining` view.
#[table(accessor = bag_letter)]
pub struct BagLetter {
    #[primary_key]
    pub letter: String,
    pub remaining: u32,
}

// Private — each bot sees only its own rack via the `my_rack` view.
#[table(
    accessor = holding,
    index(accessor = holding_by_bot, btree(columns = [bot]))
)]
pub struct Holding {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub bot: Identity,
    pub letter: String,
    pub count: u32,
}

#[table(
    accessor = auction,
    public,
    index(accessor = auction_by_status, btree(columns = [status]))
)]
pub struct Auction {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub letter: String,
    pub opens_at: Timestamp,
    pub closes_at: Timestamp,
    pub status: AuctionStatus,
}

// Private table — bots cannot subscribe and so cannot see competing bids.
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

#[table(accessor = auction_result, public)]
pub struct AuctionResult {
    #[primary_key]
    pub auction_id: u64,
    pub letter: String,
    pub winner: Option<Identity>,
    pub top_bid: i64,    // winner's actual bid (highest)
    pub paid: i64,       // what they paid (second-highest, or reserve for sole bidder)
    pub closed_at: Timestamp,
}

#[table(
    accessor = word_play,
    public,
    index(accessor = play_by_bot, btree(columns = [bot]))
)]
pub struct WordPlay {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
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
}

// ---------- Views ----------
// Each bot sees only its own letters; the per-letter bag composition stays
// hidden. Total tiles remaining is already public via MatchState.bag_total.
#[view(accessor = my_rack, public)]
fn my_rack(ctx: &ViewContext) -> Vec<Holding> {
    ctx.db
        .holding()
        .holding_by_bot()
        .filter(&ctx.sender())
        .collect()
}

// ---------- Lifecycle ----------

#[reducer(init)]
pub fn init(ctx: &ReducerContext) {
    let total: u32 = letters::DEFAULT_BAG.iter().map(|(_, c)| c).sum();
    ctx.db.match_state().insert(MatchState {
        id: SINGLETON_MATCH_ID,
        status: MatchStatus::Lobby,
        current_round: 0,
        current_auction_id: None,
        bag_total: total,
        auction_type: AuctionType::Vickrey,
        started_at: None,
        ended_at: None,
    });
    for (letter, count) in letters::DEFAULT_BAG.iter() {
        ctx.db.bag_letter().insert(BagLetter {
            letter: letter.to_string(),
            remaining: *count,
        });
    }
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
    if ctx.db.bot().name().find(&trimmed.to_string()).is_some() {
        return Err("Name already taken".into());
    }
    ctx.db.bot().insert(Bot {
        identity: ctx.sender(),
        name: trimmed.to_string(),
        balance: STARTING_BALANCE,
        score: 0,
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
    if ctx.db.bot().name().find(&trimmed.to_string()).is_some() {
        return Err("Name already taken".into());
    }
    // Deterministic fabricated identity so simulated bots persist across calls.
    let identity = Identity::from_claims("sim", trimmed);
    if ctx.db.bot().identity().find(identity).is_some() {
        return Err("Simulated bot already exists".into());
    }
    ctx.db.bot().insert(Bot {
        identity,
        name: trimmed.to_string(),
        balance: STARTING_BALANCE,
        score: 0,
        connected: true,
        registered_at: ctx.timestamp,
        is_simulated: true,
        strategy,
    });
    log::info!("Simulated bot spawned: {}", trimmed);
    Ok(())
}

// ---------- Match control ----------

#[reducer]
pub fn set_auction_type(ctx: &ReducerContext, auction_type: AuctionType) -> Result<(), String> {
    let m = ctx
        .db
        .match_state()
        .id()
        .find(SINGLETON_MATCH_ID)
        .ok_or("No match")?;
    if m.status != MatchStatus::Lobby {
        return Err("Can only change auction type before the match starts".into());
    }
    ctx.db.match_state().id().update(MatchState {
        auction_type,
        ..m
    });
    Ok(())
}

#[reducer]
pub fn reset_match(ctx: &ReducerContext) -> Result<(), String> {
    // Clear all per-match tables.
    let auction_ids: Vec<u64> = ctx.db.auction().iter().map(|a| a.id).collect();
    for id in auction_ids {
        ctx.db.auction().id().delete(&id);
    }
    let result_ids: Vec<u64> = ctx
        .db
        .auction_result()
        .iter()
        .map(|r| r.auction_id)
        .collect();
    for id in result_ids {
        ctx.db.auction_result().auction_id().delete(&id);
    }
    let bid_ids: Vec<u64> = ctx.db.pending_bid().iter().map(|b| b.id).collect();
    for id in bid_ids {
        ctx.db.pending_bid().id().delete(&id);
    }
    let holding_ids: Vec<u64> = ctx.db.holding().iter().map(|h| h.id).collect();
    for id in holding_ids {
        ctx.db.holding().id().delete(&id);
    }
    let play_ids: Vec<u64> = ctx.db.word_play().iter().map(|p| p.id).collect();
    for id in play_ids {
        ctx.db.word_play().id().delete(&id);
    }
    let schedule_ids: Vec<u64> = ctx
        .db
        .auction_schedule()
        .iter()
        .map(|s| s.scheduled_id)
        .collect();
    for id in schedule_ids {
        ctx.db.auction_schedule().scheduled_id().delete(&id);
    }
    // Refill the bag from scratch.
    let existing_letters: Vec<String> = ctx.db.bag_letter().iter().map(|b| b.letter).collect();
    for l in existing_letters {
        ctx.db.bag_letter().letter().delete(&l);
    }
    let total: u32 = letters::DEFAULT_BAG.iter().map(|(_, c)| c).sum();
    for (letter, count) in letters::DEFAULT_BAG.iter() {
        ctx.db.bag_letter().insert(BagLetter {
            letter: letter.to_string(),
            remaining: *count,
        });
    }
    // Reset every bot's balance and score, but keep registrations.
    let bots: Vec<Bot> = ctx.db.bot().iter().collect();
    for bot in bots {
        ctx.db.bot().identity().update(Bot {
            balance: STARTING_BALANCE,
            score: 0,
            ..bot
        });
    }
    // Reset the match singleton, preserving the chosen auction type.
    let m = ctx
        .db
        .match_state()
        .id()
        .find(SINGLETON_MATCH_ID)
        .ok_or("No match")?;
    ctx.db.match_state().id().update(MatchState {
        status: MatchStatus::Lobby,
        current_round: 0,
        current_auction_id: None,
        bag_total: total,
        started_at: None,
        ended_at: None,
        ..m
    });
    log::info!("Match reset");
    Ok(())
}

#[reducer]
pub fn start_match(ctx: &ReducerContext) -> Result<(), String> {
    let m = ctx
        .db
        .match_state()
        .id()
        .find(SINGLETON_MATCH_ID)
        .ok_or("No match initialized")?;
    if m.status != MatchStatus::Lobby {
        return Err("Match already started or ended".into());
    }
    if ctx.db.bot().iter().count() < 1 {
        return Err("At least one bot must register before starting".into());
    }

    let letter = draw_letter(ctx).ok_or("Bag empty")?;
    let opens_at = ctx.timestamp;
    let closes_at = ctx.timestamp + Duration::from_millis(AUCTION_DURATION_MS);
    let auction = ctx.db.auction().insert(Auction {
        id: 0,
        letter,
        opens_at,
        closes_at,
        status: AuctionStatus::Open,
    });

    let m = ctx.db.match_state().id().find(SINGLETON_MATCH_ID).unwrap();
    ctx.db.match_state().id().update(MatchState {
        status: MatchStatus::Running,
        current_round: 1,
        current_auction_id: Some(auction.id),
        started_at: Some(ctx.timestamp),
        ..m
    });

    ctx.db.auction_schedule().insert(AuctionSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(closes_at),
    });

    // Sim bots bid on the opening auction too.
    simulate_bids(ctx, &auction);

    log::info!("Match started; first auction id={}", auction.id);
    Ok(())
}

// ---------- Bidding ----------

#[reducer]
pub fn submit_bid(ctx: &ReducerContext, auction_id: u64, amount: i64) -> Result<(), String> {
    if amount < 0 {
        return Err("Bid must be non-negative".into());
    }
    let bot = ctx
        .db
        .bot()
        .identity()
        .find(ctx.sender())
        .ok_or("Not registered")?;
    if bot.balance < amount {
        return Err("Insufficient balance".into());
    }
    let auction = ctx
        .db
        .auction()
        .id()
        .find(&auction_id)
        .ok_or("Unknown auction")?;
    if auction.status != AuctionStatus::Open {
        return Err("Auction closed".into());
    }
    if ctx.timestamp >= auction.closes_at {
        return Err("Auction window expired".into());
    }

    // Replace any earlier bid by this bot on this auction (last-write-wins).
    let existing: Vec<u64> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(&auction_id)
        .filter(|b| b.bidder == ctx.sender())
        .map(|b| b.id)
        .collect();
    for id in existing {
        ctx.db.pending_bid().id().delete(&id);
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
pub fn submit_word(ctx: &ReducerContext, word: String) -> Result<(), String> {
    let bot = ctx
        .db
        .bot()
        .identity()
        .find(ctx.sender())
        .ok_or("Not registered")?;
    let m = ctx
        .db
        .match_state()
        .id()
        .find(SINGLETON_MATCH_ID)
        .ok_or("No match")?;
    if m.status != MatchStatus::Running {
        return Err("Match not running".into());
    }

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

    // Tally needed letters.
    let mut needed: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for c in word_upper.chars() {
        *needed.entry(c).or_insert(0) += 1;
    }

    // Index this bot's holdings by letter.
    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(&ctx.sender())
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

    // Deduct letters.
    for (c, n) in &needed {
        let (hid, ct) = by_letter[c];
        let new_ct = ct - n;
        if new_ct == 0 {
            ctx.db.holding().id().delete(&hid);
        } else if let Some(h) = ctx.db.holding().id().find(&hid) {
            ctx.db.holding().id().update(Holding {
                count: new_ct,
                ..h
            });
        }
    }

    // Score.
    let base_score: i64 = word_upper
        .chars()
        .map(|c| letters::letter_value(c) as i64)
        .sum();
    let (num, denom) = letters::length_multiplier(word_upper.len());
    let total_reward = base_score * num / denom;
    let bonus = total_reward - base_score;

    ctx.db.bot().identity().update(Bot {
        balance: bot.balance + total_reward,
        score: bot.score + total_reward,
        ..bot
    });

    ctx.db.word_play().insert(WordPlay {
        id: 0,
        bot: ctx.sender(),
        word: word_upper.clone(),
        base_score,
        bonus,
        total_reward,
        played_at: ctx.timestamp,
    });

    log::info!(
        "Word '{}' played: base={}, bonus={}, total={}",
        word_upper,
        base_score,
        bonus,
        total_reward
    );
    Ok(())
}

// ---------- Auction tick (scheduled) ----------

#[reducer]
pub fn auction_tick(ctx: &ReducerContext, _job: AuctionSchedule) {
    let m = match ctx.db.match_state().id().find(SINGLETON_MATCH_ID) {
        Some(m) if m.status == MatchStatus::Running => m,
        _ => return,
    };
    let Some(auction_id) = m.current_auction_id else {
        return;
    };
    let Some(auction) = ctx.db.auction().id().find(&auction_id) else {
        return;
    };

    // Resolve highest bid; ties broken by earlier submission (lower id).
    let bids: Vec<PendingBid> = ctx
        .db
        .pending_bid()
        .bid_by_auction()
        .filter(&auction_id)
        .collect();
    // Sort bids descending by amount; ties broken by earlier submission.
    let mut sorted: Vec<&PendingBid> = bids.iter().filter(|b| b.amount > 0).collect();
    sorted.sort_by(|a, b| b.amount.cmp(&a.amount).then(a.id.cmp(&b.id)));

    // Auction type determines what the winner pays. FirstPrice: pays own bid.
    // Vickrey: pays runner-up's bid (or AUCTION_RESERVE if they're the only
    // bidder).
    let (winner, top_bid, paid) = match (m.auction_type.clone(), sorted.as_slice()) {
        (_, []) => (None, 0, 0),
        (AuctionType::FirstPrice, [only]) => (Some(only.bidder), only.amount, only.amount),
        (AuctionType::FirstPrice, [first, ..]) => {
            (Some(first.bidder), first.amount, first.amount)
        }
        (AuctionType::Vickrey, [only]) => {
            (Some(only.bidder), only.amount, AUCTION_RESERVE.min(only.amount))
        }
        (AuctionType::Vickrey, [first, second, ..]) => {
            (Some(first.bidder), first.amount, second.amount)
        }
    };

    let mut sim_winner: Option<Identity> = None;
    if let Some(w) = winner {
        if let Some(bot) = ctx.db.bot().identity().find(w) {
            if bot.balance >= paid {
                let is_sim = bot.is_simulated;
                ctx.db.bot().identity().update(Bot {
                    balance: bot.balance - paid,
                    ..bot
                });
                // Add letter to winner's rack.
                let existing: Vec<Holding> = ctx
                    .db
                    .holding()
                    .holding_by_bot()
                    .filter(&w)
                    .filter(|h| h.letter == auction.letter)
                    .collect();
                if let Some(h) = existing.into_iter().next() {
                    ctx.db.holding().id().update(Holding {
                        count: h.count + 1,
                        ..h
                    });
                } else {
                    ctx.db.holding().insert(Holding {
                        id: 0,
                        bot: w,
                        letter: auction.letter.clone(),
                        count: 1,
                    });
                }
                if is_sim {
                    sim_winner = Some(w);
                }
            }
        }
    } else {
        // No winning bid — return the tile to the bag.
        return_to_bag(ctx, &auction.letter);
    }

    ctx.db.auction_result().insert(AuctionResult {
        auction_id,
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
        ctx.db.pending_bid().id().delete(&b.id);
    }

    // Now that the winner has the tile, let simulated winners try a word.
    if let Some(w) = sim_winner {
        simulate_word_play(ctx, w);
    }

    // Open next auction or end the match.
    let m2 = ctx.db.match_state().id().find(SINGLETON_MATCH_ID).unwrap();
    let next_letter = match draw_letter(ctx) {
        Some(l) => l,
        None => {
            ctx.db.match_state().id().update(MatchState {
                status: MatchStatus::Ended,
                current_auction_id: None,
                ended_at: Some(ctx.timestamp),
                ..m2
            });
            log::info!("Match ended (bag empty)");
            return;
        }
    };

    let opens_at = ctx.timestamp;
    let closes_at = ctx.timestamp + Duration::from_millis(AUCTION_DURATION_MS);
    let next_auction = ctx.db.auction().insert(Auction {
        id: 0,
        letter: next_letter,
        opens_at,
        closes_at,
        status: AuctionStatus::Open,
    });

    let m3 = ctx.db.match_state().id().find(SINGLETON_MATCH_ID).unwrap();
    ctx.db.match_state().id().update(MatchState {
        current_round: m3.current_round + 1,
        current_auction_id: Some(next_auction.id),
        ..m3
    });
    ctx.db.auction_schedule().insert(AuctionSchedule {
        scheduled_id: 0,
        scheduled_at: ScheduleAt::Time(closes_at),
    });

    // Let every simulated bot bid on the newly opened auction.
    simulate_bids(ctx, &next_auction);
}

// ---------- Helpers ----------

fn draw_letter(ctx: &ReducerContext) -> Option<String> {
    let m = ctx.db.match_state().id().find(SINGLETON_MATCH_ID)?;
    if m.bag_total == 0 {
        return None;
    }
    let mut idx: u32 = ctx.rng().gen_range(0..m.bag_total);
    // Iterate bag entries deterministically (sort by letter).
    let mut entries: Vec<BagLetter> = ctx
        .db
        .bag_letter()
        .iter()
        .filter(|b| b.remaining > 0)
        .collect();
    entries.sort_by(|a, b| a.letter.cmp(&b.letter));
    for bag in &entries {
        if idx < bag.remaining {
            let letter = bag.letter.clone();
            let new_remaining = bag.remaining - 1;
            ctx.db.bag_letter().letter().update(BagLetter {
                remaining: new_remaining,
                letter: letter.clone(),
            });
            ctx.db.match_state().id().update(MatchState {
                bag_total: m.bag_total - 1,
                ..m
            });
            return Some(letter);
        }
        idx -= bag.remaining;
    }
    None
}

fn return_to_bag(ctx: &ReducerContext, letter: &str) {
    if let Some(bag) = ctx.db.bag_letter().letter().find(&letter.to_string()) {
        ctx.db.bag_letter().letter().update(BagLetter {
            remaining: bag.remaining + 1,
            letter: bag.letter.clone(),
        });
    } else {
        ctx.db.bag_letter().insert(BagLetter {
            letter: letter.to_string(),
            remaining: 1,
        });
    }
    if let Some(m) = ctx.db.match_state().id().find(SINGLETON_MATCH_ID) {
        ctx.db.match_state().id().update(MatchState {
            bag_total: m.bag_total + 1,
            ..m
        });
    }
}

// ---------- Simulated-bot logic ----------

// Each sim strategy is meant to *value* a letter differently. Under a Vickrey
// auction the dominant strategy is to bid your true valuation, so the bots
// just bid the value they personally assign to the tile.
fn decide_bid(strategy: &BotStrategy, letter: &str, balance: i64) -> i64 {
    let c = letter.chars().next().unwrap_or('A');
    let value = letters::letter_value(c) as i64;
    let is_vowel = matches!(c, 'A' | 'E' | 'I' | 'O' | 'U');
    let bid = match strategy {
        BotStrategy::Human => return 0,
        // Cheapskate undervalues — face value minus 1, floor 1.
        BotStrategy::Cheapskate => (value - 1).max(1),
        // ValueBidder bids exactly face value.
        BotStrategy::ValueBidder => value,
        // Aggressive bids face value + premium, with extra for vowels because
        // they enable more words.
        BotStrategy::Aggressive => value + if is_vowel { 4 } else { 2 },
    };
    bid.min(balance).max(0)
}

fn simulate_bids(ctx: &ReducerContext, auction: &Auction) {
    let sims: Vec<Bot> = ctx.db.bot().iter().filter(|b| b.is_simulated).collect();
    for bot in sims {
        let amount = decide_bid(&bot.strategy, &auction.letter, bot.balance);
        if amount <= 0 {
            continue;
        }
        // Clear any prior bid by this sim bot on this auction.
        let prior: Vec<u64> = ctx
            .db
            .pending_bid()
            .bid_by_auction()
            .filter(&auction.id)
            .filter(|b| b.bidder == bot.identity)
            .map(|b| b.id)
            .collect();
        for id in prior {
            ctx.db.pending_bid().id().delete(&id);
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

fn simulate_word_play(ctx: &ReducerContext, bot_identity: Identity) {
    let Some(bot) = ctx.db.bot().identity().find(bot_identity) else {
        return;
    };
    let holdings: Vec<Holding> = ctx
        .db
        .holding()
        .holding_by_bot()
        .filter(&bot_identity)
        .collect();
    let mut rack: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for h in &holdings {
        if let Some(c) = h.letter.chars().next() {
            *rack.entry(c).or_insert(0) += h.count;
        }
    }
    // Require at least a 3-letter word, since 2-letter words pay 1x with little upside.
    let Some(word) = dictionary::find_best_playable(&rack, 3) else {
        return;
    };

    // Deduct letters.
    let mut needed: std::collections::HashMap<char, u32> = std::collections::HashMap::new();
    for c in word.chars() {
        *needed.entry(c).or_insert(0) += 1;
    }
    let mut by_letter: std::collections::HashMap<char, (u64, u32)> =
        std::collections::HashMap::new();
    for h in &holdings {
        if let Some(c) = h.letter.chars().next() {
            by_letter.insert(c, (h.id, h.count));
        }
    }
    for (c, n) in &needed {
        let (hid, ct) = by_letter[c];
        let new_ct = ct - n;
        if new_ct == 0 {
            ctx.db.holding().id().delete(&hid);
        } else if let Some(h) = ctx.db.holding().id().find(&hid) {
            ctx.db.holding().id().update(Holding {
                count: new_ct,
                ..h
            });
        }
    }

    let base_score: i64 = word.chars().map(|c| letters::letter_value(c) as i64).sum();
    let (num, denom) = letters::length_multiplier(word.len());
    let total_reward = base_score * num / denom;
    let bonus = total_reward - base_score;

    ctx.db.bot().identity().update(Bot {
        balance: bot.balance + total_reward,
        score: bot.score + total_reward,
        ..bot
    });
    ctx.db.word_play().insert(WordPlay {
        id: 0,
        bot: bot_identity,
        word: word.clone(),
        base_score,
        bonus,
        total_reward,
        played_at: ctx.timestamp,
    });
    log::info!("[sim] played '{}' for {}", word, total_reward);
}
