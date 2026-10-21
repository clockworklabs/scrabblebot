import { Identity, ScheduleAt } from "spacetimedb";
import { SenderError, t } from "spacetimedb/server";
import { isValidWord } from "./dictionary";
import { BAG_SIZE } from "./letters";
import {
  afterSeconds,
  botInRunningMatch,
  callerBotId,
  closeAuction,
  endedMatchesInOrder,
  ensureSimBot,
  findParticipant,
  generateNonceCode,
  NONCE_TTL_SECONDS,
  orThrow,
  playWord,
  replaceBid,
  requireAdmin,
  requireScheduler,
  resolveHuman,
  resolveHumanView,
  SEED_ADMIN_HEX,
  updateEloAtMatchEnd,
} from "./game";
import { identityFromClaims } from "./identity";
import { openLobbyOrCreate, resolveLobby } from "./lobby";
import spacetimedb, {
  admin,
  auctionSchedule,
  AuctionType,
  BotStrategy,
  credentialNonce,
  holding,
  lobbyTimeoutSchedule,
  TeamSummary,
  nonceExpirySchedule,
  auctionTopBid,
} from "./schema";
import { asciiUppercase, byteLength, isAsciiUppercase, trim } from "./text";
import {
  addEntry,
  dropEntriesWithoutBots,
  entrantsStillPlaying,
  entryFor,
  heldForTournament,
  isActive,
  isUnderway,
  onTournamentMatchEnded,
  requireRegistration,
  startFinalsMatch,
  startRoundOneWhenFree,
  startSwissRound,
} from "./tournament";

export default spacetimedb;

// The SDK's snake_case conversion gives reducers and views the names they
// had in the Rust module (`startTournament` is `start_tournament`), so
// clients call them exactly as before.

// ---------- Views ----------

// A bot sees only its own letters (across any matches it's in). Clients
// filter by matchId on their side.
export const myRack = spacetimedb.view(
  { public: true },
  t.array(holding.rowType),
  (ctx) => {
    const cred = ctx.db.botCredential.identity.find(ctx.sender);
    if (!cred) {
      return [];
    }
    return [...ctx.db.holding.holdingByBot.filter(cred.botId)];
  },
);

// myTeam: the calling human's team. Resolves browser identities via
// HumanLink to the underlying spacetimedb.com identity.
export const myTeam = spacetimedb.view(
  { public: true },
  t.option(TeamSummary),
  (ctx) => {
    const human = resolveHumanView(ctx);
    const member = ctx.db.teamMember.user.find(human);
    if (!member) return undefined;
    const team = ctx.db.team.id.find(member.teamId);
    if (!team) return undefined;
    let bot;
    for (const b of ctx.db.bot.botByTeam.filter(team.id)) {
      bot = b;
      break;
    }
    if (!bot) return undefined;
    const credentialCount = [...ctx.db.botCredential.credByBot.filter(bot.id)]
      .length;
    return {
      teamId: team.id,
      teamName: team.name,
      botId: bot.id,
      botName: bot.name,
      role: member.role,
      credentialCount,
    };
  },
);

// Spectator-only view of live winning-bid amounts. Callers that hold a
// BotCredential (real bots in the game) get an empty list; everyone else
// sees the data for all currently-Running matches. Bounded by an indexed
// nested-loop join through match status, so the result is small even as
// the underlying private table grows. Ended-match top bids live in the
// public `auctionTopBidArchive` table; subscribe there for replays.
export const visibleAuctionTopBids = spacetimedb.view(
  { public: true },
  t.array(auctionTopBid.rowType),
  (ctx) => {
    if (ctx.db.botCredential.identity.find(ctx.sender) != null) {
      return [];
    }
    const out = [];
    for (const m of ctx.db.matchState.matchByStatus.filter({
      tag: "Running",
    })) {
      for (const top of ctx.db.auctionTopBid.topBidByMatch.filter(m.id)) {
        out.push(top);
      }
    }
    return out;
  },
);

// Nonces the caller has minted. Private to the caller.
export const myNonces = spacetimedb.view(
  { public: true },
  t.array(credentialNonce.rowType),
  (ctx) => {
    const human = resolveHumanView(ctx);
    return [...ctx.db.credentialNonce.nonceByCreator.filter(human)];
  },
);

// The caller's admin row (resolved to spacetime.com identity), if they are
// an admin.
export const myAdmin = spacetimedb.view(
  { public: true },
  t.option(admin.rowType),
  (ctx) => {
    const human = resolveHumanView(ctx);
    return ctx.db.admin.humanIdentity.find(human) ?? undefined;
  },
);

// ---------- Lifecycle ----------

export const init = spacetimedb.init((ctx) => {
  // Seed admins.
  for (const hex of SEED_ADMIN_HEX) {
    let identity;
    try {
      identity = Identity.fromString(hex);
    } catch {
      console.error(`Bad SEED_ADMIN_HEX entry: ${hex}`);
      continue;
    }
    if (ctx.db.admin.humanIdentity.find(identity) != null) {
      continue;
    }
    ctx.db.admin.insert({
      humanIdentity: identity,
      addedAt: ctx.timestamp,
      addedBy: undefined,
    });
    console.info(`Seeded admin: ${hex}`);
  }

  // Seed the simulated-bot pool used to pad lobby timeouts.
  const sims: [string, BotStrategy][] = [
    ["Cheapo-sim", { tag: "Cheapskate" }],
    ["Valor-sim", { tag: "ValueBidder" }],
    ["Brutus-sim", { tag: "Aggressive" }],
    ["Hagrid-sim", { tag: "ValueBidder" }],
    ["Maverick-sim", { tag: "Aggressive" }],
    ["Snippet-sim", { tag: "Cheapskate" }],
  ];
  for (const [name, strategy] of sims) {
    ensureSimBot(ctx, name, strategy);
  }

  // Kick off the perpetual lobby cycle.
  openLobbyOrCreate(ctx);
});

export const clientConnected = spacetimedb.clientConnected((ctx) => {
  const cred = ctx.db.botCredential.identity.find(ctx.sender);
  if (cred) {
    ctx.db.botCredential.identity.update({
      ...cred,
      connected: true,
      lastSeen: ctx.timestamp,
    });
  }
});

export const clientDisconnected = spacetimedb.clientDisconnected((ctx) => {
  const cred = ctx.db.botCredential.identity.find(ctx.sender);
  if (cred) {
    ctx.db.botCredential.identity.update({
      ...cred,
      connected: false,
      lastSeen: ctx.timestamp,
    });
  }
});

// ---------- Identity linking ----------

// CLI flow: spacetime call scrabblebot connect_id <web_identity>
// ctx.sender here is the human (spacetime.com identity). The argument is
// the anon web identity the user wants to link.
export const connectId = spacetimedb.reducer(
  { webIdentity: t.identity() },
  (ctx, { webIdentity }) => {
    const human = ctx.sender;
    if (webIdentity.isEqual(human)) {
      throw new SenderError(
        "web identity is the same as your identity — nothing to link",
      );
    }
    const existing = ctx.db.humanLink.webIdentity.find(webIdentity);
    if (existing) {
      if (existing.humanIdentity.isEqual(human)) {
        return; // idempotent
      }
      throw new SenderError(
        "That web identity is already linked to a different account. " +
          "Reset the browser identity first and try again.",
      );
    }
    ctx.db.humanLink.insert({
      webIdentity,
      humanIdentity: human,
      linkedAt: ctx.timestamp,
    });
    console.info(`Linked web identity to human ${human.toHexString()}`);
  },
);

// ---------- Admins ----------

// Claim the first admin slot. Allowed only when no admins exist yet. After
// this, new admins must be added by an existing admin via `addAdmin`.
export const bootstrapAdmin = spacetimedb.reducer((ctx) => {
  if (ctx.db.admin.count() > 0n) {
    throw new SenderError(
      "Admins already exist — ask one to add you with add_admin",
    );
  }
  const human = resolveHuman(ctx);
  ctx.db.admin.insert({
    humanIdentity: human,
    addedAt: ctx.timestamp,
    addedBy: undefined,
  });
  console.info(`Bootstrap admin: ${human.toHexString()}`);
});

export const addAdmin = spacetimedb.reducer(
  { humanIdentity: t.identity() },
  (ctx, { humanIdentity }) => {
    requireAdmin(ctx);
    if (ctx.db.admin.humanIdentity.find(humanIdentity) != null) {
      throw new SenderError("Already an admin");
    }
    const caller = resolveHuman(ctx);
    ctx.db.admin.insert({
      humanIdentity,
      addedAt: ctx.timestamp,
      addedBy: caller,
    });
    console.info(`Admin added: ${humanIdentity.toHexString()}`);
  },
);

export const removeAdmin = spacetimedb.reducer(
  { humanIdentity: t.identity() },
  (ctx, { humanIdentity }) => {
    requireAdmin(ctx);
    const caller = resolveHuman(ctx);
    if (caller.isEqual(humanIdentity)) {
      throw new SenderError("You can't remove yourself");
    }
    if (ctx.db.admin.humanIdentity.find(humanIdentity) == null) {
      throw new SenderError("Not an admin");
    }
    ctx.db.admin.humanIdentity.delete(humanIdentity);
  },
);

// ---------- Teams ----------

// Create a team with the caller as Owner, plus the team's bot row. The bot
// gets no credentials yet — the team must mint a credential nonce next.
export const createTeam = spacetimedb.reducer(
  { teamName: t.string(), botName: t.string() },
  (ctx, args) => {
    const teamName = trim(args.teamName);
    const botName = trim(args.botName);
    if (teamName.length === 0 || byteLength(teamName) > 48) {
      throw new SenderError("Team name must be 1-48 characters");
    }
    if (botName.length === 0 || byteLength(botName) > 32) {
      throw new SenderError("Bot name must be 1-32 characters");
    }
    const human = resolveHuman(ctx);
    if (ctx.db.team.name.find(teamName) != null) {
      throw new SenderError("Team name already taken");
    }
    if (ctx.db.teamMember.user.find(human) != null) {
      throw new SenderError("You're already on a team");
    }
    if (ctx.db.bot.name.find(botName) != null) {
      throw new SenderError("Bot name already taken");
    }

    const team = ctx.db.team.insert({
      id: 0n,
      name: teamName,
      createdAt: ctx.timestamp,
    });
    const bot = ctx.db.bot.insert({
      id: 0n,
      name: botName,
      teamId: team.id,
      isSimulated: false,
      strategy: { tag: "Human" },
      createdAt: ctx.timestamp,
    });
    ctx.db.teamMember.insert({
      id: 0n,
      teamId: team.id,
      user: human,
      role: { tag: "Owner" },
      joinedAt: ctx.timestamp,
    });
    console.info(
      `Team '${teamName}' (id ${team.id}) created with bot '${botName}' (id ${bot.id})`,
    );
  },
);

export const joinTeam = spacetimedb.reducer(
  { teamName: t.string() },
  (ctx, args) => {
    const teamName = trim(args.teamName);
    const team = ctx.db.team.name.find(teamName);
    if (!team) {
      throw new SenderError("No such team");
    }
    const human = resolveHuman(ctx);
    if (ctx.db.teamMember.user.find(human) != null) {
      throw new SenderError("You're already on a team");
    }
    ctx.db.teamMember.insert({
      id: 0n,
      teamId: team.id,
      user: human,
      role: { tag: "Member" },
      joinedAt: ctx.timestamp,
    });
    console.info(`Human ${human.toHexString()} joined team '${teamName}'`);
  },
);

export const leaveTeam = spacetimedb.reducer((ctx) => {
  const human = resolveHuman(ctx);
  const me = ctx.db.teamMember.user.find(human);
  if (!me) {
    throw new SenderError("You're not on a team");
  }
  const teamId = me.teamId;
  ctx.db.teamMember.id.delete(me.id);
  const remaining = [...ctx.db.teamMember.tmemberByTeam.filter(teamId)].length;
  if (remaining === 0) {
    // Delete the team's bot too, with its credentials and any nonces
    // that would otherwise mint new credentials for it.
    const botIds = [...ctx.db.bot.botByTeam.filter(teamId)].map((b) => b.id);
    // A tournament can't seat a deleted bot, so it would stall at the
    // bot's next match.
    if (botIds.some((bid) => heldForTournament(ctx, bid))) {
      throw new SenderError(
        "Your bot is still playing in a tournament; the last member can leave once it's knocked out or the tournament ends",
      );
    }
    for (const bid of botIds) {
      // Withdraw it from tournaments that haven't started. Entries in
      // tournaments it has played stay, as the record of what happened.
      for (const e of [...ctx.db.tournamentEntry.teByBot.filter(bid)]) {
        const tour = ctx.db.tournament.id.find(e.tournamentId);
        if (tour?.status.tag === "Registration") {
          ctx.db.tournamentEntry.id.delete(e.id);
        }
      }
      const credIds = [...ctx.db.botCredential.credByBot.filter(bid)].map(
        (c) => c.identity,
      );
      for (const cid of credIds) {
        ctx.db.botCredential.identity.delete(cid);
      }
      const nonceIds = [...ctx.db.credentialNonce.iter()]
        .filter((n) => n.botId === bid)
        .map((n) => n.id);
      for (const nid of nonceIds) {
        ctx.db.credentialNonce.id.delete(nid);
      }
      const lobbyRows = [...ctx.db.lobbyMember.lmByBot.filter(bid)].map(
        (m) => m.id,
      );
      for (const lid of lobbyRows) {
        ctx.db.lobbyMember.id.delete(lid);
      }
      ctx.db.bot.id.delete(bid);
    }
    ctx.db.team.id.delete(teamId);
    console.info(`Team ${teamId} dissolved (no members left)`);
  }
});

export const promoteToOwner = spacetimedb.reducer(
  { targetUser: t.identity() },
  (ctx, { targetUser }) => {
    const human = resolveHuman(ctx);
    const me = ctx.db.teamMember.user.find(human);
    if (!me) {
      throw new SenderError("You're not on a team");
    }
    if (me.role.tag !== "Owner") {
      throw new SenderError("Only owners can promote");
    }
    const target = ctx.db.teamMember.user.find(targetUser);
    if (!target) {
      throw new SenderError("Target user is not on a team");
    }
    if (target.teamId !== me.teamId) {
      throw new SenderError("Target user is not on your team");
    }
    ctx.db.teamMember.id.update({ ...target, role: { tag: "Owner" } });
  },
);

// ---------- Credential provisioning ----------

// A team member mints a single-use nonce that can be redeemed by any client
// to receive a fresh credential for their team's bot.
export const mintCredentialNonce = spacetimedb.reducer((ctx) => {
  const human = resolveHuman(ctx);
  const member = ctx.db.teamMember.user.find(human);
  if (!member) {
    throw new SenderError("You're not on a team — create or join one first");
  }
  const bot = [...ctx.db.bot.iter()].find((b) => b.teamId === member.teamId);
  if (!bot) {
    throw new SenderError("Your team has no bot");
  }
  let code = generateNonceCode(ctx, 0);
  for (let attempt = 1; ctx.db.credentialNonce.code.find(code); attempt++) {
    code = generateNonceCode(ctx, attempt);
  }
  const expiresAt = afterSeconds(ctx.timestamp, NONCE_TTL_SECONDS);
  const nonce = ctx.db.credentialNonce.insert({
    id: 0n,
    code,
    botId: bot.id,
    creator: human,
    expiresAt,
  });
  ctx.db.nonceExpirySchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(expiresAt.microsSinceUnixEpoch),
    nonceId: nonce.id,
  });
  console.info(
    `Nonce minted for bot ${bot.id} (expires in ${NONCE_TTL_SECONDS}s)`,
  );
});

// A freshly-connected client (no token yet, OR a token unrelated to a bot)
// redeems a nonce. The client's identity becomes a new credential for the
// nonce's bot. The nonce is then deleted.
export const claimCredential = spacetimedb.reducer(
  { code: t.string() },
  (ctx, { code }) => {
    const nonce = ctx.db.credentialNonce.code.find(code);
    if (!nonce) {
      throw new SenderError("No such nonce");
    }
    // Its expiry job may not have run yet. (Deleting it here would be
    // rolled back along with everything else when we throw.)
    if (
      ctx.timestamp.microsSinceUnixEpoch >= nonce.expiresAt.microsSinceUnixEpoch
    ) {
      throw new SenderError("This nonce has expired");
    }
    // Is the caller already a credential for ANY bot? Disallow — a fresh
    // client (no prior credential) must claim.
    if (ctx.db.botCredential.identity.find(ctx.sender) != null) {
      throw new SenderError("Your identity is already a credential for a bot");
    }
    ctx.db.botCredential.insert({
      identity: ctx.sender,
      botId: nonce.botId,
      connected: true,
      lastSeen: ctx.timestamp,
    });
    ctx.db.credentialNonce.id.delete(nonce.id);
    console.info(`Credential claimed for bot ${nonce.botId}`);
  },
);

export const nonceExpiryTick = spacetimedb.reducer(
  { onSchedule: nonceExpirySchedule },
  { job: nonceExpirySchedule.rowType },
  (ctx, { job }) => {
    requireScheduler(ctx);
    ctx.db.credentialNonce.id.delete(job.nonceId);
  },
);

// ---------- Simulated bot ----------

export const spawnSimulatedBot = spacetimedb.reducer(
  { name: t.string(), strategy: BotStrategy },
  (ctx, { name, strategy }) => {
    requireAdmin(ctx);
    const trimmed = trim(name);
    if (trimmed.length === 0 || byteLength(trimmed) > 32) {
      throw new SenderError("Name must be 1-32 characters");
    }
    if (strategy.tag === "Human") {
      throw new SenderError("Simulated bots cannot use the Human strategy");
    }
    if (ctx.db.bot.name.find(trimmed) != null) {
      throw new SenderError("Name already taken");
    }
    // Sim bots don't belong to a team and aren't player-owned. They get a
    // fabricated credential identity so the auction/word path stays uniform.
    const identity = identityFromClaims("sim", trimmed);
    if (ctx.db.botCredential.identity.find(identity) != null) {
      throw new SenderError("Simulated bot already exists");
    }
    const bot = ctx.db.bot.insert({
      id: 0n,
      name: trimmed,
      teamId: 0n,
      isSimulated: true,
      strategy,
      createdAt: ctx.timestamp,
    });
    ctx.db.botCredential.insert({
      identity,
      botId: bot.id,
      connected: true,
      lastSeen: ctx.timestamp,
    });
    console.info(`Simulated bot spawned: ${trimmed} (id ${bot.id})`);
  },
);

// One-shot migration helper: move historical `auctionTopBid` rows for
// ended matches into the public `auctionTopBidArchive`. New matches
// archive automatically via `onMatchEnded`; this drains the backlog from
// before the archive existed. Chunked because the table held ~1.4M rows;
// `maxRows` caps the work per call so the reducer stays under the time
// budget. Admin re-invokes until it reports zero moved.
export const backfillTopBidArchive = spacetimedb.reducer(
  { maxRows: t.u32() },
  (ctx, { maxRows }) => {
    requireAdmin(ctx);
    if (maxRows === 0) {
      throw new SenderError("max_rows must be > 0");
    }
    let moved = 0;
    outer: for (const m of [
      ...ctx.db.matchState.matchByStatus.filter({ tag: "Ended" }),
    ]) {
      const live = [...ctx.db.auctionTopBid.topBidByMatch.filter(m.id)];
      for (const top of live) {
        ctx.db.auctionTopBidArchive.insert({
          auctionId: top.auctionId,
          matchId: top.matchId,
          topBid: top.topBid,
        });
        ctx.db.auctionTopBid.auctionId.delete(top.auctionId);
        moved += 1;
        if (moved >= maxRows) {
          break outer;
        }
      }
    }
    console.info(`backfill_top_bid_archive moved ${moved} rows`);
  },
);

// ---------- Match defaults ----------

// Sets the auction length, starting rack size and lobby size for matches
// and lobbies created from now on. Matches being played keep the values
// they started with, and so does the open lobby.
export const setMatchmakerConfig = spacetimedb.reducer(
  {
    startingRackSize: t.u32(),
    lobbyMaxSize: t.u32(),
    auctionDurationMs: t.u64(),
  },
  (ctx, { startingRackSize, lobbyMaxSize, auctionDurationMs }) => {
    requireAdmin(ctx);
    if (startingRackSize > 20) {
      throw new SenderError("Starting rack size must be 0-20");
    }
    if (lobbyMaxSize < 2 || lobbyMaxSize > 12) {
      throw new SenderError("Lobby size must be 2-12");
    }
    if (auctionDurationMs < 250n || auctionDurationMs > 10_000n) {
      throw new SenderError("Auction length must be 250-10000 ms");
    }
    // A full lobby's racks, plus a tile for the first auction, must fit in
    // the bag.
    if (lobbyMaxSize * startingRackSize >= BAG_SIZE) {
      throw new SenderError(
        `A full lobby would be dealt more tiles than the bag's ${BAG_SIZE}`,
      );
    }
    const row = {
      id: 0,
      startingRackSize,
      lobbyMaxSize,
      auctionDurationMs,
    };
    if (ctx.db.matchmakerConfig.id.find(0)) {
      ctx.db.matchmakerConfig.id.update(row);
    } else {
      ctx.db.matchmakerConfig.insert(row);
    }
  },
);

// ---------- Bidding ----------

export const submitBid = spacetimedb.reducer(
  { auctionId: t.u64(), amount: t.i64() },
  (ctx, { auctionId, amount }) => {
    if (amount < 0n) {
      throw new SenderError("Bid must be non-negative");
    }
    const botId = callerBotId(ctx);
    if (botId === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    const auction = ctx.db.auction.id.find(auctionId);
    if (!auction) {
      throw new SenderError("Unknown auction");
    }
    if (auction.status.tag !== "Open") {
      throw new SenderError("Auction closed");
    }
    if (
      ctx.timestamp.microsSinceUnixEpoch >=
      auction.closesAt.microsSinceUnixEpoch
    ) {
      throw new SenderError("Auction window expired");
    }
    const participant = findParticipant(ctx, auction.matchId, botId);
    if (!participant) {
      throw new SenderError("Not in this match");
    }
    if (participant.balance < amount) {
      throw new SenderError("Insufficient balance");
    }
    replaceBid(ctx, auctionId, botId, amount);
  },
);

// ---------- Word play ----------

export const submitWord = spacetimedb.reducer(
  { matchId: t.u64(), word: t.string() },
  (ctx, { matchId, word }) => {
    const m = ctx.db.matchState.id.find(matchId);
    if (!m) {
      throw new SenderError("Unknown match");
    }
    if (m.status.tag !== "Running") {
      throw new SenderError("Match not running");
    }
    const botId = callerBotId(ctx);
    if (botId === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    const participant = findParticipant(ctx, matchId, botId);
    if (!participant) {
      throw new SenderError("Not in this match");
    }

    const wordUpper = asciiUppercase(word);
    if (byteLength(wordUpper) < 2) {
      throw new SenderError("Word must be at least 2 letters");
    }
    if (!isAsciiUppercase(wordUpper)) {
      throw new SenderError("Word must be A-Z only");
    }
    if (!isValidWord(wordUpper)) {
      throw new SenderError(`'${wordUpper}' is not in the dictionary`);
    }

    orThrow(playWord(ctx, participant, wordUpper));
  },
);

// ---------- Lobby ----------

export const joinLobby = spacetimedb.reducer((ctx) => {
  const botId = callerBotId(ctx);
  if (botId === undefined) {
    throw new SenderError("Your identity is not a credential for any bot");
  }

  // Bots can't be in two places at once.
  if (botInRunningMatch(ctx, botId)) {
    throw new SenderError("You're already in a running match");
  }
  if (heldForTournament(ctx, botId)) {
    throw new SenderError(
      "You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends",
    );
  }

  const lobby = openLobbyOrCreate(ctx);

  // Idempotent: already in this open lobby is a no-op.
  const already = [...ctx.db.lobbyMember.lmByLobby.filter(lobby.id)].some(
    (m) => m.botId === botId,
  );
  if (already) {
    return;
  }

  ctx.db.lobbyMember.insert({
    id: 0n,
    lobbyId: lobby.id,
    botId,
    joinedAt: ctx.timestamp,
  });

  // Auto-start if the lobby is now full of REAL bots (sim bots only enter
  // via timeout padding).
  const realCount = [...ctx.db.lobbyMember.lmByLobby.filter(lobby.id)].filter(
    (m) => {
      const b = ctx.db.bot.id.find(m.botId);
      return b ? !b.isSimulated : false;
    },
  ).length;
  if (realCount >= lobby.maxSize) {
    resolveLobby(ctx, lobby.id, false);
  }
});

export const lobbyTimeoutTick = spacetimedb.reducer(
  { onSchedule: lobbyTimeoutSchedule },
  { job: lobbyTimeoutSchedule.rowType },
  (ctx, { job }) => {
    requireScheduler(ctx);
    resolveLobby(ctx, job.lobbyId, true);
  },
);

// ---------- Tournament ----------

// An admin creates a tournament, bots register for it from their own
// processes, and the admin starts it once enough have signed up.
export const createTournament = spacetimedb.reducer(
  {
    swissRoundsTotal: t.u32(),
    topCut: t.u32(),
    matchSize: t.u32(),
    auctionType: AuctionType,
  },
  (ctx, { swissRoundsTotal, topCut, matchSize, auctionType }) => {
    requireAdmin(ctx);
    if (matchSize < 2) {
      throw new SenderError("Tournament match_size must be >= 2");
    }
    if (swissRoundsTotal < 1) {
      throw new SenderError("Need at least 1 Swiss round");
    }
    if (topCut < 2) {
      throw new SenderError("top_cut must be >= 2");
    }
    if ([...ctx.db.tournament.iter()].some(isActive)) {
      throw new SenderError("Another tournament is already in progress");
    }
    const tour = ctx.db.tournament.insert({
      id: 0n,
      status: { tag: "Registration" },
      swissRoundsTotal,
      currentRound: 0,
      topCut,
      matchSize,
      auctionType,
      createdAt: ctx.timestamp,
      endedAt: undefined,
      winnerBotId: undefined,
    });
    console.info(`Tournament ${tour.id} created; registration open`);
  },
);

// Called by a bot's own process: the caller must be one of the bot's
// credentials, which a browser identity never is.
export const registerForTournament = spacetimedb.reducer(
  { tournamentId: t.u64() },
  (ctx, { tournamentId }) => {
    const botId = callerBotId(ctx);
    if (botId === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    requireRegistration(ctx, tournamentId);
    if (entryFor(ctx, tournamentId, botId)) {
      return; // idempotent
    }
    addEntry(ctx, tournamentId, botId);
    console.info(`Bot ${botId} registered for tournament ${tournamentId}`);
  },
);

export const unregisterFromTournament = spacetimedb.reducer(
  { tournamentId: t.u64() },
  (ctx, { tournamentId }) => {
    const botId = callerBotId(ctx);
    if (botId === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    requireRegistration(ctx, tournamentId);
    const entry = entryFor(ctx, tournamentId, botId);
    if (entry) {
      ctx.db.tournamentEntry.id.delete(entry.id);
    }
  },
);

// Enters every sim bot, so an admin can fill out the field for a rehearsal
// or a small event.
export const registerSimBots = spacetimedb.reducer(
  { tournamentId: t.u64() },
  (ctx, { tournamentId }) => {
    requireAdmin(ctx);
    requireRegistration(ctx, tournamentId);
    for (const bot of [...ctx.db.bot.iter()]) {
      if (bot.isSimulated && !entryFor(ctx, tournamentId, bot.id)) {
        addEntry(ctx, tournamentId, bot.id);
      }
    }
  },
);

export const cancelTournament = spacetimedb.reducer(
  { tournamentId: t.u64() },
  (ctx, { tournamentId }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournamentId);
    if (!tour) {
      throw new SenderError("Unknown tournament");
    }
    if (tour.status.tag !== "Registration") {
      throw new SenderError(
        "Only a tournament that hasn't started can be cancelled",
      );
    }
    for (const e of [
      ...ctx.db.tournamentEntry.teByTournament.filter(tournamentId),
    ]) {
      ctx.db.tournamentEntry.id.delete(e.id);
    }
    ctx.db.tournament.id.delete(tournamentId);
    console.info(`Tournament ${tournamentId} cancelled`);
  },
);

export const startTournament = spacetimedb.reducer(
  { tournamentId: t.u64() },
  (ctx, { tournamentId }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournamentId);
    if (!tour) {
      throw new SenderError("Unknown tournament");
    }
    if (tour.status.tag !== "Registration") {
      throw new SenderError("Tournament has already started");
    }
    const entries = dropEntriesWithoutBots(ctx, tournamentId);
    if (entries.length < tour.matchSize) {
      throw new SenderError(
        `Need at least ${tour.matchSize} registered bots to start`,
      );
    }
    ctx.db.tournament.id.update({ ...tour, status: { tag: "Swiss" } });
    // Entrants waiting in the casual lobby leave it. From now on they can't
    // join one.
    for (const lobby of ctx.db.lobby.lobbyByStatus.filter({ tag: "Open" })) {
      for (const m of [...ctx.db.lobbyMember.lmByLobby.filter(lobby.id)]) {
        if (entries.some((e) => e.botId === m.botId)) {
          ctx.db.lobbyMember.id.delete(m.id);
        }
      }
    }
    // A real bot can only play one match at a time, so round 1 waits for
    // entrants still in casual matches. With bots cycling through the
    // lobby, there's rarely a moment when none are.
    const busy = entrantsStillPlaying(ctx, tournamentId);
    if (busy.length > 0) {
      console.info(
        `Tournament ${tournamentId} started with ${entries.length} entrants; round 1 waits for ${busy
          .map((b) => b.name)
          .join(", ")}`,
      );
      return;
    }
    orThrow(startSwissRound(ctx, tournamentId, 1));
    console.info(
      `Tournament ${tournamentId} started with ${entries.length} entrants`,
    );
  },
);

// Stops a tournament that's under way, for when it can't or shouldn't
// finish. Its matches in progress play out, but their results no longer
// count, and its entrants are free to play in the lobby again.
export const forceEndTournament = spacetimedb.reducer(
  { tournamentId: t.u64() },
  (ctx, { tournamentId }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournamentId);
    if (!tour) {
      throw new SenderError("Unknown tournament");
    }
    if (tour.status.tag === "Registration") {
      throw new SenderError(
        "This tournament hasn't started; cancel it instead",
      );
    }
    if (!isUnderway(tour)) {
      throw new SenderError("This tournament has already finished");
    }
    ctx.db.tournament.id.update({
      ...tour,
      status: { tag: "ForceEnded" },
      endedAt: ctx.timestamp,
    });
    console.info(`Tournament ${tournamentId} stopped by an admin`);
  },
);

// Starts the next match of the finals: an elimination match, or the next
// game of the final. The admin runs these one at a time, so the finals can
// be played out on a stage.
export const startNextFinalsMatch = spacetimedb.reducer(
  { tournamentId: t.u64() },
  (ctx, { tournamentId }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournamentId);
    if (!tour) {
      throw new SenderError("Unknown tournament");
    }
    orThrow(startFinalsMatch(ctx, tour));
  },
);

// ---------- ELO ----------

// Resets all BotStats and replays ELO across every ended match in chronological order.
export const backfillElo = spacetimedb.reducer((ctx) => {
  requireAdmin(ctx);

  for (const stats of [...ctx.db.botStats.iter()]) {
    ctx.db.botStats.botId.delete(stats.botId);
  }

  for (const m of endedMatchesInOrder(ctx)) {
    updateEloAtMatchEnd(ctx, m.id);
  }
});

// ---------- Auction tick (scheduled) ----------

export const auctionTick = spacetimedb.reducer(
  { onSchedule: auctionSchedule },
  { job: auctionSchedule.rowType },
  (ctx, { job }) => {
    requireScheduler(ctx);
    if (closeAuction(ctx, job.matchId)) {
      onTournamentMatchEnded(ctx, job.matchId);
      startRoundOneWhenFree(ctx);
    }
  },
);
