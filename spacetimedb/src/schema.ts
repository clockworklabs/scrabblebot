import { schema, t, table, type Infer } from "spacetimedb/server";

// The canonical names of tables, columns and indexes come from the SDK's
// default snake_case conversion of the names here, so they're the names the
// Rust module had: `botCredential` is the table `bot_credential`, and its
// `botId` column is `bot_id`.

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

// New variants go at the end, so existing rows keep their meaning.
export const TournamentStatus = t.enum("TournamentStatus", [
  "Lobby", // unused
  "Swiss",
  "Bracket",
  "Final",
  "Ended",
  "Registration", // created; bots are signing up
  "ForceEnded", // stopped by an admin before it finished
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
// parameter type named after the view, and `myTeam`'s is `MyTeam`.)
export const TeamSummary = t.row("TeamSummary", {
  teamId: t.u64(),
  teamName: t.string(),
  botId: t.u64(),
  botName: t.string(),
  role: TeamRole,
  credentialCount: t.u32(),
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
      { accessor: "botByTeam", algorithm: "btree", columns: ["teamId"] },
    ],
  },
  t.row("Bot", {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().unique(),
    // 0 for simulated bots and other system-owned personas (no team).
    teamId: t.u64(),
    isSimulated: t.bool(),
    strategy: BotStrategy,
    createdAt: t.timestamp(),
  }),
);
export type Bot = Infer<typeof bot.rowType>;

// One row per credential authorized to act as a bot. Multiple credentials
// per bot are allowed (the team adds new ones over time; old ones keep
// working).
export const botCredential = table(
  {
    public: true,
    indexes: [
      { accessor: "credByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("BotCredential", {
    identity: t.identity().primaryKey(),
    botId: t.u64(),
    connected: t.bool(),
    lastSeen: t.timestamp(),
  }),
);
export type BotCredential = Infer<typeof botCredential.rowType>;

// Links a website's anonymous identity to a developer's spacetimedb.com
// identity. Written by the `connectId` reducer (called from CLI authed as
// the spacetime.com user). One human can link many web identities; each web
// identity links to exactly one human.
export const humanLink = table(
  {
    public: true,
    indexes: [
      {
        accessor: "linkByHuman",
        algorithm: "btree",
        columns: ["humanIdentity"],
      },
    ],
  },
  t.row("HumanLink", {
    webIdentity: t.identity().primaryKey(),
    humanIdentity: t.identity(),
    linkedAt: t.timestamp(),
  }),
);
export type HumanLink = Infer<typeof humanLink.rowType>;

// Single-use credential claim code, minted by a team member. Private (not
// subscribable) — the creator reads their own via the `myNonces` view.
// `code` is unique, so it gets its own index (`credentialNonce.code`).
export const credentialNonce = table(
  {
    indexes: [
      {
        accessor: "nonceByCreator",
        algorithm: "btree",
        columns: ["creator"],
      },
    ],
  },
  t.row("CredentialNonce", {
    id: t.u64().primaryKey().autoInc(),
    code: t.string().unique(),
    botId: t.u64(),
    // The human (resolved spacetime.com identity) who minted this nonce.
    creator: t.identity(),
    expiresAt: t.timestamp(),
  }),
);
export type CredentialNonce = Infer<typeof credentialNonce.rowType>;

// Deletes a nonce when it expires. A claimed nonce is deleted sooner, and
// its job then finds nothing to do.
export const nonceExpirySchedule = table(
  {},
  t.row("NonceExpirySchedule", {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    nonceId: t.u64(),
  }),
);
export type NonceExpirySchedule = Infer<typeof nonceExpirySchedule.rowType>;

// Team — group of humans, owns exactly one Bot (Bot.teamId points back).
export const team = table(
  { public: true },
  t.row("Team", {
    id: t.u64().primaryKey().autoInc(),
    name: t.string().unique(),
    createdAt: t.timestamp(),
  }),
);
export type Team = Infer<typeof team.rowType>;

export const teamMember = table(
  {
    public: true,
    indexes: [
      { accessor: "tmemberByTeam", algorithm: "btree", columns: ["teamId"] },
    ],
  },
  t.row("TeamMember", {
    id: t.u64().primaryKey().autoInc(),
    teamId: t.u64(),
    // Spacetime.com identity (the human).
    user: t.identity().unique(),
    role: TeamRole,
    joinedAt: t.timestamp(),
  }),
);
export type TeamMember = Infer<typeof teamMember.rowType>;

// Humans who can run admin actions (start matches, configure matchmaker,
// run tournaments, spawn simulated bots, manage other admins). Keyed by
// spacetime.com identity (resolved via HumanLink for browser callers).
export const admin = table(
  { public: true },
  t.row("Admin", {
    humanIdentity: t.identity().primaryKey(),
    addedAt: t.timestamp(),
    // None for the bootstrapping first admin; otherwise the admin who added
    // this one.
    addedBy: t.option(t.identity()),
  }),
);
export type Admin = Infer<typeof admin.rowType>;

// Lobby — one open lobby at a time accepts joinLobby calls. When it
// fills with real bots or its timer expires, the lobby resolves into a
// Match and a fresh Open lobby takes its place.
export const lobby = table(
  {
    public: true,
    indexes: [
      { accessor: "lobbyByStatus", algorithm: "btree", columns: ["status"] },
    ],
  },
  t.row("Lobby", {
    id: t.u64().primaryKey().autoInc(),
    status: LobbyStatus,
    opensAt: t.timestamp(),
    closesAt: t.timestamp(),
    maxSize: t.u32(),
    auctionType: AuctionType,
    resolvedMatchId: t.option(t.u64()),
  }),
);
export type Lobby = Infer<typeof lobby.rowType>;

export const lobbyMember = table(
  {
    public: true,
    indexes: [
      { accessor: "lmByLobby", algorithm: "btree", columns: ["lobbyId"] },
      { accessor: "lmByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("LobbyMember", {
    id: t.u64().primaryKey().autoInc(),
    lobbyId: t.u64(),
    botId: t.u64(),
    joinedAt: t.timestamp(),
  }),
);
export type LobbyMember = Infer<typeof lobbyMember.rowType>;

export const lobbyTimeoutSchedule = table(
  {},
  t.row("LobbyTimeoutSchedule", {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    lobbyId: t.u64(),
  }),
);
export type LobbyTimeoutSchedule = Infer<typeof lobbyTimeoutSchedule.rowType>;

// Match — one row per match. id is autoInc.
export const matchState = table(
  {
    public: true,
    indexes: [
      { accessor: "matchByStatus", algorithm: "btree", columns: ["status"] },
    ],
  },
  t.row("Match", {
    id: t.u64().primaryKey().autoInc(),
    status: MatchStatus,
    currentRound: t.u32(),
    currentAuctionId: t.option(t.u64()),
    bagTotal: t.u32(),
    auctionType: AuctionType,
    createdAt: t.timestamp(),
    startedAt: t.option(t.timestamp()),
    endedAt: t.option(t.timestamp()),
    // The match defaults when it started, so changing them doesn't change
    // a match being played.
    auctionDurationMs: t.u64().default(1000n),
    startingRackSize: t.u32().default(5),
  }),
);
export type Match = Infer<typeof matchState.rowType>;

// Per-match balance and score for one bot in one match.
export const matchParticipant = table(
  {
    public: true,
    indexes: [
      { accessor: "mpByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "mpByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("MatchParticipant", {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    botId: t.u64(),
    balance: t.i64(),
    score: t.i64(),
  }),
);
export type MatchParticipant = Infer<typeof matchParticipant.rowType>;

// Private — each match has its own bag.
export const bagLetter = table(
  {
    indexes: [
      { accessor: "bagByMatch", algorithm: "btree", columns: ["matchId"] },
    ],
  },
  t.row("BagLetter", {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    letter: t.string(),
    remaining: t.u32(),
  }),
);
export type BagLetter = Infer<typeof bagLetter.rowType>;

// Private — each bot sees only its own rack via `myRack`.
export const holding = table(
  {
    indexes: [
      { accessor: "holdingByBot", algorithm: "btree", columns: ["botId"] },
      {
        accessor: "holdingByMatch",
        algorithm: "btree",
        columns: ["matchId"],
      },
      {
        accessor: "holdingByMatchBot",
        algorithm: "btree",
        columns: ["matchId", "botId"],
      },
    ],
  },
  t.row("Holding", {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    botId: t.u64(),
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
        accessor: "auctionByMatch",
        algorithm: "btree",
        columns: ["matchId"],
      },
      {
        accessor: "auctionByStatus",
        algorithm: "btree",
        columns: ["status"],
      },
    ],
  },
  t.row("Auction", {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    letter: t.string(),
    opensAt: t.timestamp(),
    closesAt: t.timestamp(),
    status: AuctionStatus,
  }),
);
export type Auction = Infer<typeof auction.rowType>;

// Private — bots cannot subscribe and so cannot see competing bids.
export const pendingBid = table(
  {
    indexes: [
      {
        accessor: "bidByAuction",
        algorithm: "btree",
        columns: ["auctionId"],
      },
    ],
  },
  t.row("PendingBid", {
    id: t.u64().primaryKey().autoInc(),
    auctionId: t.u64(),
    bidderBotId: t.u64(),
    amount: t.i64(),
    submittedAt: t.timestamp(),
  }),
);
export type PendingBid = Infer<typeof pendingBid.rowType>;

export const auctionResult = table(
  {
    public: true,
    indexes: [
      {
        accessor: "resultByMatch",
        algorithm: "btree",
        columns: ["matchId"],
      },
    ],
  },
  t.row("AuctionResult", {
    auctionId: t.u64().primaryKey(),
    matchId: t.u64(),
    letter: t.string(),
    winnerBotId: t.option(t.u64()),
    paid: t.i64(),
    closedAt: t.timestamp(),
  }),
);
export type AuctionResult = Infer<typeof auctionResult.rowType>;

// Private — live, in-progress matches. Top bid is sensitive while a match
// is running (it leaks the winner's true valuation and would undermine
// Vickrey's truth-telling if competing bots could see it). The
// `visibleAuctionTopBids` view exposes these to spectators only, bounded
// to Running matches. On match end, rows here are moved to
// `auctionTopBidArchive` (public) so spectators can replay finished
// matches without any view-body cost.
export const auctionTopBid = table(
  {
    indexes: [
      {
        accessor: "topBidByMatch",
        algorithm: "btree",
        columns: ["matchId"],
      },
      { accessor: "topBidVisible", algorithm: "btree", columns: ["visible"] },
    ],
  },
  t.row("AuctionTopBid", {
    auctionId: t.u64().primaryKey(),
    matchId: t.u64(),
    topBid: t.i64(),
    // Unused. Originally indexed for view enumeration; the view now uses
    // `topBidByMatch` driven by match status. Kept for schema compat.
    visible: t.bool(),
  }),
);
export type AuctionTopBid = Infer<typeof auctionTopBid.rowType>;

// Public — post-match archive of topBid. Inserted by `onMatchEnded` once
// the match is no longer live (bots can't act on the info, so it's safe to
// expose). Spectators subscribe `WHERE match_id = ?` from the match page.
export const auctionTopBidArchive = table(
  {
    public: true,
    indexes: [
      {
        accessor: "archiveByMatch",
        algorithm: "btree",
        columns: ["matchId"],
      },
    ],
  },
  t.row("AuctionTopBidArchive", {
    auctionId: t.u64().primaryKey(),
    matchId: t.u64(),
    topBid: t.i64(),
  }),
);
export type AuctionTopBidArchive = Infer<typeof auctionTopBidArchive.rowType>;

export const wordPlay = table(
  {
    public: true,
    indexes: [
      { accessor: "playByMatch", algorithm: "btree", columns: ["matchId"] },
      { accessor: "playByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("WordPlay", {
    id: t.u64().primaryKey().autoInc(),
    matchId: t.u64(),
    botId: t.u64(),
    word: t.string(),
    baseScore: t.i64(),
    bonus: t.i64(),
    totalReward: t.i64(),
    playedAt: t.timestamp(),
  }),
);
export type WordPlay = Infer<typeof wordPlay.rowType>;

export const auctionSchedule = table(
  {},
  t.row("AuctionSchedule", {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    matchId: t.u64(),
  }),
);
export type AuctionSchedule = Infer<typeof auctionSchedule.rowType>;

// Admin-set defaults for new matches and lobbies: one row, id 0. Until an
// admin saves some, the defaults in game.ts apply.
export const matchmakerConfig = table(
  { public: true },
  t.row("MatchmakerConfig", {
    id: t.u32().primaryKey(),
    startingRackSize: t.u32(),
    lobbyMaxSize: t.u32(),
    auctionDurationMs: t.u64(),
  }),
);
export type MatchmakerConfig = Infer<typeof matchmakerConfig.rowType>;

// Per-bot aggregate stats across all matches. ELO rating + counters.
export const botStats = table(
  { public: true },
  t.row("BotStats", {
    botId: t.u64().primaryKey(),
    rating: t.i32(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    totalScore: t.i64(),
    lastPlayed: t.option(t.timestamp()),
    openskillMu: t.f64().default(25.0),
    openskillSigma: t.f64().default(8.333333333333334),
  }),
);
export type BotStats = Infer<typeof botStats.rowType>;

export const tournament = table(
  { public: true },
  t.row("Tournament", {
    id: t.u64().primaryKey().autoInc(),
    status: TournamentStatus,
    swissRoundsTotal: t.u32(),
    currentRound: t.u32(),
    topCut: t.u32(),
    matchSize: t.u32(),
    auctionType: AuctionType,
    createdAt: t.timestamp(),
    endedAt: t.option(t.timestamp()),
    // Set when the final is decided.
    winnerBotId: t.option(t.u64()).default(undefined),
  }),
);
export type Tournament = Infer<typeof tournament.rowType>;

export const tournamentEntry = table(
  {
    public: true,
    indexes: [
      {
        accessor: "teByTournament",
        algorithm: "btree",
        columns: ["tournamentId"],
      },
      { accessor: "teByBot", algorithm: "btree", columns: ["botId"] },
    ],
  },
  t.row("TournamentEntry", {
    id: t.u64().primaryKey().autoInc(),
    tournamentId: t.u64(),
    botId: t.u64(),
    swissPoints: t.i32(),
    eliminated: t.bool(),
    // The bot's score summed over its matches in this tournament, which
    // breaks ties in the standings.
    totalScore: t.i64().default(0n),
    // Where the bot finished, for finalists: set when it's knocked out of
    // the finals, and 1 for the champion.
    finalFinishPosition: t.option(t.u32()).default(undefined),
  }),
);
export type TournamentEntry = Infer<typeof tournamentEntry.rowType>;

export const tournamentMatch = table(
  {
    public: true,
    indexes: [
      {
        accessor: "tmByTournament",
        algorithm: "btree",
        columns: ["tournamentId"],
      },
      { accessor: "tmByMatch", algorithm: "btree", columns: ["matchId"] },
    ],
  },
  t.row("TournamentMatch", {
    id: t.u64().primaryKey().autoInc(),
    tournamentId: t.u64(),
    matchId: t.u64(),
    round: t.u32(),
    phase: TournamentPhase,
  }),
);
export type TournamentMatch = Infer<typeof tournamentMatch.rowType>;

const spacetimedb = schema({
  bot,
  botCredential,
  humanLink,
  credentialNonce,
  nonceExpirySchedule,
  team,
  teamMember,
  admin,
  lobby,
  lobbyMember,
  lobbyTimeoutSchedule,
  matchState,
  matchParticipant,
  bagLetter,
  holding,
  auction,
  pendingBid,
  auctionResult,
  auctionTopBid,
  auctionTopBidArchive,
  wordPlay,
  auctionSchedule,
  botStats,
  tournament,
  tournamentEntry,
  tournamentMatch,
  matchmakerConfig,
});
export default spacetimedb;
