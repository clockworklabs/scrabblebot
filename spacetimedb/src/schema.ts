import { schema, t, table, type Infer } from "spacetimedb/server";

// Names (tables, columns, indexes, types) match the original Rust module
// exactly, so the generated client bindings are unchanged.

// ---------- Enums ----------

export const MatchStatus = t.enum("MatchStatus", ["Lobby", "Running", "Ended"]);
export type MatchStatus = Infer<typeof MatchStatus>;

export const AuctionStatus = t.enum("AuctionStatus", ["Open", "Closed"]);
export type AuctionStatus = Infer<typeof AuctionStatus>;

export const AuctionType = t.enum("AuctionType", ["FirstPrice", "Vickrey"]);
export type AuctionType = Infer<typeof AuctionType>;

export const BotStrategy = t.enum("BotStrategy", [
  "Human",
  "Cheapskate",
  "ValueBidder",
  "Aggressive",
]);
export type BotStrategy = Infer<typeof BotStrategy>;

export const TournamentStatus = t.enum("TournamentStatus", [
  "Lobby",
  "Swiss",
  "Bracket",
  "Final",
  "Ended",
]);
export type TournamentStatus = Infer<typeof TournamentStatus>;

export const TournamentPhase = t.enum("TournamentPhase", [
  "Swiss",
  "Bracket",
  "Final",
]);
export type TournamentPhase = Infer<typeof TournamentPhase>;

export const TeamRole = t.enum("TeamRole", ["Owner", "Member"]);
export type TeamRole = Infer<typeof TeamRole>;

export const LobbyStatus = t.enum("LobbyStatus", [
  "Open", // accepting joins
  "Resolved", // match started
  "Cancelled", // not enough participants to start
]);
export type LobbyStatus = Infer<typeof LobbyStatus>;

// View return type — the caller's team summary. (The Rust module called
// this type `MyTeam`, but the TypeScript library gives every view a
// parameter type named after the view, and `my_team`'s is `MyTeam`.)
export const TeamSummary = t.row("TeamSummary", {
  team_id: t.u64(),
  team_name: t.string(),
  bot_id: t.u64(),
  bot_name: t.string(),
  role: TeamRole,
  credential_count: t.u32(),
});
export type TeamSummary = Infer<typeof TeamSummary>;

// ---------- Tables ----------

// Bot is a persona, independent of any identity that controls it. Many
// `BotCredential` rows may exist for the same bot; each one is a token a
// human team member can give to a bot process so it can play the game.
export const bot = table(
  {
    public: true,
    indexes: [
      { accessor: "bot_by_team", algorithm: "btree", columns: ["team_id"] },
    ],
  },
  t.row("Bot", {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().unique(),
    // 0 for simulated bots and other system-owned personas (no team).
    team_id: t.u64(),
    is_simulated: t.bool(),
    strategy: BotStrategy,
    created_at: t.timestamp(),
  }),
);
export type Bot = Infer<typeof bot.rowType>;

// One row per credential authorized to act as a bot. Multiple credentials
// per bot are allowed (the team adds new ones over time; old ones keep
// working).
export const bot_credential = table(
  {
    public: true,
    indexes: [
      { accessor: "cred_by_bot", algorithm: "btree", columns: ["bot_id"] },
    ],
  },
  t.row("BotCredential", {
    identity: t.identity().primaryKey(),
    bot_id: t.u64(),
    connected: t.bool(),
    last_seen: t.timestamp(),
  }),
);
export type BotCredential = Infer<typeof bot_credential.rowType>;

// Links a website's anonymous identity to a developer's spacetimedb.com
// identity. Written by the `connect_id` reducer (called from CLI authed as
// the spacetime.com user). One human can link many web identities; each web
// identity links to exactly one human.
export const human_link = table(
  {
    public: true,
    indexes: [
      {
        accessor: "link_by_human",
        algorithm: "btree",
        columns: ["human_identity"],
      },
    ],
  },
  t.row("HumanLink", {
    web_identity: t.identity().primaryKey(),
    human_identity: t.identity(),
    linked_at: t.timestamp(),
  }),
);
export type HumanLink = Infer<typeof human_link.rowType>;

// Single-use credential claim code, minted by a team member. Private (not
// subscribable) — the creator reads their own via the `my_nonces` view.
// `code` is unique, so it gets its own index (`credential_nonce.code`).
export const credential_nonce = table(
  {
    indexes: [
      {
        accessor: "nonce_by_creator",
        algorithm: "btree",
        columns: ["creator"],
      },
    ],
  },
  t.row("CredentialNonce", {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    bot_id: t.u64(),
    // The human (resolved spacetime.com identity) who minted this nonce.
    creator: t.identity(),
    expires_at: t.timestamp(),
  }),
);
export type CredentialNonce = Infer<typeof credential_nonce.rowType>;

// Deletes a nonce when it expires. A claimed nonce is deleted sooner, and
// its job then finds nothing to do.
export const nonce_expiry_schedule = table(
  {},
  t.row("NonceExpirySchedule", {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    nonce_id: t.u64(),
  }),
);
export type NonceExpirySchedule = Infer<typeof nonce_expiry_schedule.rowType>;

// Team — group of humans, owns exactly one Bot (Bot.team_id points back).
export const team = table(
  { public: true },
  t.row("Team", {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().unique(),
    created_at: t.timestamp(),
  }),
);
export type Team = Infer<typeof team.rowType>;

export const team_member = table(
  {
    public: true,
    indexes: [
      { accessor: "tmember_by_team", algorithm: "btree", columns: ["team_id"] },
    ],
  },
  t.row("TeamMember", {
    id: t.u64().primaryKey().autoInc(),
    team_id: t.u64(),
    // Spacetime.com identity (the human).
    user: t.identity().unique(),
    role: TeamRole,
    joined_at: t.timestamp(),
  }),
);
export type TeamMember = Infer<typeof team_member.rowType>;

// Humans who can run admin actions (start matches, configure matchmaker,
// run tournaments, spawn simulated bots, manage other admins). Keyed by
// spacetime.com identity (resolved via HumanLink for browser callers).
export const admin = table(
  { public: true },
  t.row("Admin", {
    human_identity: t.identity().primaryKey(),
    added_at: t.timestamp(),
    // None for the bootstrapping first admin; otherwise the admin who added
    // this one.
    added_by: t.option(t.identity()),
  }),
);
export type Admin = Infer<typeof admin.rowType>;

// Lobby — one open lobby at a time accepts join_lobby calls. When it
// fills with real bots or its timer expires, the lobby resolves into a
// Match and a fresh Open lobby takes its place.
export const lobby = table(
  {
    public: true,
    indexes: [
      { accessor: "lobby_by_status", algorithm: "btree", columns: ["status"] },
    ],
  },
  t.row("Lobby", {
    id: t.u64().primaryKey().autoInc(),
    status: LobbyStatus,
    opens_at: t.timestamp(),
    closes_at: t.timestamp(),
    max_size: t.u32(),
    auction_type: AuctionType,
    resolved_match_id: t.option(t.u64()),
  }),
);
export type Lobby = Infer<typeof lobby.rowType>;

export const lobby_member = table(
  {
    public: true,
    indexes: [
      { accessor: "lm_by_lobby", algorithm: "btree", columns: ["lobby_id"] },
      { accessor: "lm_by_bot", algorithm: "btree", columns: ["bot_id"] },
    ],
  },
  t.row("LobbyMember", {
    id: t.u64().primaryKey().autoInc(),
    lobby_id: t.u64(),
    bot_id: t.u64(),
    joined_at: t.timestamp(),
  }),
);
export type LobbyMember = Infer<typeof lobby_member.rowType>;

export const lobby_timeout_schedule = table(
  {},
  t.row("LobbyTimeoutSchedule", {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    lobby_id: t.u64(),
  }),
);
export type LobbyTimeoutSchedule = Infer<typeof lobby_timeout_schedule.rowType>;

// Match — one row per match. id is auto_inc.
export const match_state = table(
  {
    public: true,
    indexes: [
      { accessor: "match_by_status", algorithm: "btree", columns: ["status"] },
    ],
  },
  t.row("Match", {
    id: t.u64().primaryKey().autoInc(),
    status: MatchStatus,
    current_round: t.u32(),
    current_auction_id: t.option(t.u64()),
    bag_total: t.u32(),
    auction_type: AuctionType,
    created_at: t.timestamp(),
    started_at: t.option(t.timestamp()),
    ended_at: t.option(t.timestamp()),
  }),
);
export type Match = Infer<typeof match_state.rowType>;

// Per-match balance and score for one bot in one match.
export const match_participant = table(
  {
    public: true,
    indexes: [
      { accessor: "mp_by_match", algorithm: "btree", columns: ["match_id"] },
      { accessor: "mp_by_bot", algorithm: "btree", columns: ["bot_id"] },
    ],
  },
  t.row("MatchParticipant", {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64(),
    bot_id: t.u64(),
    balance: t.i64(),
    score: t.i64(),
  }),
);
export type MatchParticipant = Infer<typeof match_participant.rowType>;

// Private — each match has its own bag.
export const bag_letter = table(
  {
    indexes: [
      { accessor: "bag_by_match", algorithm: "btree", columns: ["match_id"] },
    ],
  },
  t.row("BagLetter", {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64(),
    letter: t.string(),
    remaining: t.u32(),
  }),
);
export type BagLetter = Infer<typeof bag_letter.rowType>;

// Private — each bot sees only its own rack via `my_rack`.
export const holding = table(
  {
    indexes: [
      { accessor: "holding_by_bot", algorithm: "btree", columns: ["bot_id"] },
      {
        accessor: "holding_by_match",
        algorithm: "btree",
        columns: ["match_id"],
      },
      {
        accessor: "holding_by_match_bot",
        algorithm: "btree",
        columns: ["match_id", "bot_id"],
      },
    ],
  },
  t.row("Holding", {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64(),
    bot_id: t.u64(),
    letter: t.string(),
    count: t.u32(),
  }),
);
export type Holding = Infer<typeof holding.rowType>;

export const auction = table(
  {
    public: true,
    indexes: [
      {
        accessor: "auction_by_match",
        algorithm: "btree",
        columns: ["match_id"],
      },
      {
        accessor: "auction_by_status",
        algorithm: "btree",
        columns: ["status"],
      },
    ],
  },
  t.row("Auction", {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64(),
    letter: t.string(),
    opens_at: t.timestamp(),
    closes_at: t.timestamp(),
    status: AuctionStatus,
  }),
);
export type Auction = Infer<typeof auction.rowType>;

// Private — bots cannot subscribe and so cannot see competing bids.
export const pending_bid = table(
  {
    indexes: [
      {
        accessor: "bid_by_auction",
        algorithm: "btree",
        columns: ["auction_id"],
      },
    ],
  },
  t.row("PendingBid", {
    id: t.u64().primaryKey().autoInc(),
    auction_id: t.u64(),
    bidder_bot_id: t.u64(),
    amount: t.i64(),
    submitted_at: t.timestamp(),
  }),
);
export type PendingBid = Infer<typeof pending_bid.rowType>;

export const auction_result = table(
  {
    public: true,
    indexes: [
      {
        accessor: "result_by_match",
        algorithm: "btree",
        columns: ["match_id"],
      },
    ],
  },
  t.row("AuctionResult", {
    auction_id: t.u64().primaryKey(),
    match_id: t.u64(),
    letter: t.string(),
    winner_bot_id: t.option(t.u64()),
    paid: t.i64(),
    closed_at: t.timestamp(),
  }),
);
export type AuctionResult = Infer<typeof auction_result.rowType>;

// Private — live, in-progress matches. Top bid is sensitive while a match
// is running (it leaks the winner's true valuation and would undermine
// Vickrey's truth-telling if competing bots could see it). The
// `visible_auction_top_bids` view exposes these to spectators only, bounded
// to Running matches. On match end, rows here are moved to
// `auction_top_bid_archive` (public) so spectators can replay finished
// matches without any view-body cost.
export const auction_top_bid = table(
  {
    indexes: [
      {
        accessor: "top_bid_by_match",
        algorithm: "btree",
        columns: ["match_id"],
      },
      { accessor: "top_bid_visible", algorithm: "btree", columns: ["visible"] },
    ],
  },
  t.row("AuctionTopBid", {
    auction_id: t.u64().primaryKey(),
    match_id: t.u64(),
    top_bid: t.i64(),
    // Unused. Originally indexed for view enumeration; the view now uses
    // `top_bid_by_match` driven by match status. Kept for schema compat.
    visible: t.bool(),
  }),
);
export type AuctionTopBid = Infer<typeof auction_top_bid.rowType>;

// Public — post-match archive of top_bid. Inserted by `on_match_ended` once
// the match is no longer live (bots can't act on the info, so it's safe to
// expose). Spectators subscribe `WHERE match_id = ?` from the match page.
export const auction_top_bid_archive = table(
  {
    public: true,
    indexes: [
      {
        accessor: "archive_by_match",
        algorithm: "btree",
        columns: ["match_id"],
      },
    ],
  },
  t.row("AuctionTopBidArchive", {
    auction_id: t.u64().primaryKey(),
    match_id: t.u64(),
    top_bid: t.i64(),
  }),
);
export type AuctionTopBidArchive = Infer<
  typeof auction_top_bid_archive.rowType
>;

export const word_play = table(
  {
    public: true,
    indexes: [
      { accessor: "play_by_match", algorithm: "btree", columns: ["match_id"] },
      { accessor: "play_by_bot", algorithm: "btree", columns: ["bot_id"] },
    ],
  },
  t.row("WordPlay", {
    id: t.u64().primaryKey().autoInc(),
    match_id: t.u64(),
    bot_id: t.u64(),
    word: t.string(),
    base_score: t.i64(),
    bonus: t.i64(),
    total_reward: t.i64(),
    played_at: t.timestamp(),
  }),
);
export type WordPlay = Infer<typeof word_play.rowType>;

export const auction_schedule = table(
  {},
  t.row("AuctionSchedule", {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
    match_id: t.u64(),
  }),
);
export type AuctionSchedule = Infer<typeof auction_schedule.rowType>;

// Per-bot aggregate stats across all matches. ELO rating + counters.
export const bot_stats = table(
  { public: true },
  t.row("BotStats", {
    bot_id: t.u64().primaryKey(),
    rating: t.i32(),
    matches_played: t.u32(),
    wins: t.u32(),
    total_score: t.i64(),
    last_played: t.option(t.timestamp()),
    openskill_mu: t.f64().default(25.0),
    openskill_sigma: t.f64().default(8.333333333333334),
  }),
);
export type BotStats = Infer<typeof bot_stats.rowType>;

export const tournament = table(
  { public: true },
  t.row("Tournament", {
    id: t.u64().primaryKey().autoInc(),
    status: TournamentStatus,
    swiss_rounds_total: t.u32(),
    current_round: t.u32(),
    top_cut: t.u32(),
    match_size: t.u32(),
    auction_type: AuctionType,
    created_at: t.timestamp(),
    ended_at: t.option(t.timestamp()),
  }),
);
export type Tournament = Infer<typeof tournament.rowType>;

export const tournament_entry = table(
  {
    public: true,
    indexes: [
      {
        accessor: "te_by_tournament",
        algorithm: "btree",
        columns: ["tournament_id"],
      },
      { accessor: "te_by_bot", algorithm: "btree", columns: ["bot_id"] },
    ],
  },
  t.row("TournamentEntry", {
    id: t.u64().primaryKey().autoInc(),
    tournament_id: t.u64(),
    bot_id: t.u64(),
    swiss_points: t.i32(),
    eliminated: t.bool(),
  }),
);
export type TournamentEntry = Infer<typeof tournament_entry.rowType>;

export const tournament_match = table(
  {
    public: true,
    indexes: [
      {
        accessor: "tm_by_tournament",
        algorithm: "btree",
        columns: ["tournament_id"],
      },
      { accessor: "tm_by_match", algorithm: "btree", columns: ["match_id"] },
    ],
  },
  t.row("TournamentMatch", {
    id: t.u64().primaryKey().autoInc(),
    tournament_id: t.u64(),
    match_id: t.u64(),
    round: t.u32(),
    phase: TournamentPhase,
  }),
);
export type TournamentMatch = Infer<typeof tournament_match.rowType>;

const spacetimedb = schema({
  bot,
  bot_credential,
  human_link,
  credential_nonce,
  nonce_expiry_schedule,
  team,
  team_member,
  admin,
  lobby,
  lobby_member,
  lobby_timeout_schedule,
  match_state,
  match_participant,
  bag_letter,
  holding,
  auction,
  pending_bid,
  auction_result,
  auction_top_bid,
  auction_top_bid_archive,
  word_play,
  auction_schedule,
  bot_stats,
  tournament,
  tournament_entry,
  tournament_match,
});
export default spacetimedb;
