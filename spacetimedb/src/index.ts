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
  LOBBY_DURATION_SECONDS,
  NONCE_TTL_SECONDS,
  openLobbyOrCreate,
  orThrow,
  playWord,
  replaceBid,
  requireAdmin,
  requireScheduler,
  resolveHuman,
  resolveHumanView,
  resolveLobby,
  SEED_ADMIN_HEX,
  updateEloAtMatchEnd,
} from "./game";
import { identityFromClaims } from "./identity";
import spacetimedb, {
  admin,
  auction_schedule,
  AuctionType,
  BotStrategy,
  credential_nonce,
  holding,
  lobby_timeout_schedule,
  TeamSummary,
  nonce_expiry_schedule,
  auction_top_bid,
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
  requireRegistration,
  startNextFinalsMatch,
  startSwissRound,
} from "./tournament";

export default spacetimedb;

// Reducers and views keep the snake_case names they had in the Rust module,
// so clients call them exactly as before.

// ---------- Views ----------

// A bot sees only its own letters (across any matches it's in). Clients
// filter by match_id on their side.
export const my_rack = spacetimedb.view(
  { public: true },
  t.array(holding.rowType),
  (ctx) => {
    const cred = ctx.db.bot_credential.identity.find(ctx.sender);
    if (!cred) {
      return [];
    }
    return [...ctx.db.holding.holding_by_bot.filter(cred.bot_id)];
  },
);

// my_team: the calling human's team. Resolves browser identities via
// HumanLink to the underlying spacetimedb.com identity.
export const my_team = spacetimedb.view(
  { public: true },
  t.option(TeamSummary),
  (ctx) => {
    const human = resolveHumanView(ctx);
    const member = ctx.db.team_member.user.find(human);
    if (!member) return undefined;
    const team = ctx.db.team.id.find(member.team_id);
    if (!team) return undefined;
    let bot;
    for (const b of ctx.db.bot.bot_by_team.filter(team.id)) {
      bot = b;
      break;
    }
    if (!bot) return undefined;
    const credential_count = [
      ...ctx.db.bot_credential.cred_by_bot.filter(bot.id),
    ].length;
    return {
      team_id: team.id,
      team_name: team.name,
      bot_id: bot.id,
      bot_name: bot.name,
      role: member.role,
      credential_count,
    };
  },
);

// Spectator-only view of live winning-bid amounts. Callers that hold a
// BotCredential (real bots in the game) get an empty list; everyone else
// sees the data for all currently-Running matches. Bounded by an indexed
// nested-loop join through match status, so the result is small even as
// the underlying private table grows. Ended-match top_bids live in the
// public `auction_top_bid_archive` table; subscribe there for replays.
export const visible_auction_top_bids = spacetimedb.view(
  { public: true },
  t.array(auction_top_bid.rowType),
  (ctx) => {
    if (ctx.db.bot_credential.identity.find(ctx.sender) != null) {
      return [];
    }
    const out = [];
    for (const m of ctx.db.match_state.match_by_status.filter({
      tag: "Running",
    })) {
      for (const top of ctx.db.auction_top_bid.top_bid_by_match.filter(m.id)) {
        out.push(top);
      }
    }
    return out;
  },
);

// Nonces the caller has minted. Private to the caller.
export const my_nonces = spacetimedb.view(
  { public: true },
  t.array(credential_nonce.rowType),
  (ctx) => {
    const human = resolveHumanView(ctx);
    return [...ctx.db.credential_nonce.nonce_by_creator.filter(human)];
  },
);

// The caller's admin row (resolved to spacetime.com identity), if they are
// an admin.
export const my_admin = spacetimedb.view(
  { public: true },
  t.option(admin.rowType),
  (ctx) => {
    const human = resolveHumanView(ctx);
    return ctx.db.admin.human_identity.find(human) ?? undefined;
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
    if (ctx.db.admin.human_identity.find(identity) != null) {
      continue;
    }
    ctx.db.admin.insert({
      human_identity: identity,
      added_at: ctx.timestamp,
      added_by: undefined,
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

export const client_connected = spacetimedb.clientConnected((ctx) => {
  const cred = ctx.db.bot_credential.identity.find(ctx.sender);
  if (cred) {
    ctx.db.bot_credential.identity.update({
      ...cred,
      connected: true,
      last_seen: ctx.timestamp,
    });
  }
});

export const client_disconnected = spacetimedb.clientDisconnected((ctx) => {
  const cred = ctx.db.bot_credential.identity.find(ctx.sender);
  if (cred) {
    ctx.db.bot_credential.identity.update({
      ...cred,
      connected: false,
      last_seen: ctx.timestamp,
    });
  }
});

// ---------- Identity linking ----------

// CLI flow: spacetime call scrabblebot connect_id <web_identity>
// ctx.sender here is the human (spacetime.com identity). The argument is
// the anon web identity the user wants to link.
export const connect_id = spacetimedb.reducer(
  { web_identity: t.identity() },
  (ctx, { web_identity }) => {
    const human = ctx.sender;
    if (web_identity.isEqual(human)) {
      throw new SenderError(
        "web identity is the same as your identity — nothing to link",
      );
    }
    const existing = ctx.db.human_link.web_identity.find(web_identity);
    if (existing) {
      if (existing.human_identity.isEqual(human)) {
        return; // idempotent
      }
      throw new SenderError(
        "That web identity is already linked to a different account. " +
          "Reset the browser identity first and try again.",
      );
    }
    ctx.db.human_link.insert({
      web_identity,
      human_identity: human,
      linked_at: ctx.timestamp,
    });
    console.info(`Linked web identity to human ${human.toHexString()}`);
  },
);

// ---------- Admins ----------

// Claim the first admin slot. Allowed only when no admins exist yet. After
// this, new admins must be added by an existing admin via `add_admin`.
export const bootstrap_admin = spacetimedb.reducer((ctx) => {
  if (ctx.db.admin.count() > 0n) {
    throw new SenderError(
      "Admins already exist — ask one to add you with add_admin",
    );
  }
  const human = resolveHuman(ctx);
  ctx.db.admin.insert({
    human_identity: human,
    added_at: ctx.timestamp,
    added_by: undefined,
  });
  console.info(`Bootstrap admin: ${human.toHexString()}`);
});

export const add_admin = spacetimedb.reducer(
  { human_identity: t.identity() },
  (ctx, { human_identity }) => {
    requireAdmin(ctx);
    if (ctx.db.admin.human_identity.find(human_identity) != null) {
      throw new SenderError("Already an admin");
    }
    const caller = resolveHuman(ctx);
    ctx.db.admin.insert({
      human_identity,
      added_at: ctx.timestamp,
      added_by: caller,
    });
    console.info(`Admin added: ${human_identity.toHexString()}`);
  },
);

export const remove_admin = spacetimedb.reducer(
  { human_identity: t.identity() },
  (ctx, { human_identity }) => {
    requireAdmin(ctx);
    const caller = resolveHuman(ctx);
    if (caller.isEqual(human_identity)) {
      throw new SenderError("You can't remove yourself");
    }
    if (ctx.db.admin.human_identity.find(human_identity) == null) {
      throw new SenderError("Not an admin");
    }
    ctx.db.admin.human_identity.delete(human_identity);
  },
);

// ---------- Teams ----------

// Create a team with the caller as Owner, plus the team's bot row. The bot
// gets no credentials yet — the team must mint a credential nonce next.
export const create_team = spacetimedb.reducer(
  { team_name: t.string(), bot_name: t.string() },
  (ctx, args) => {
    const team_name = trim(args.team_name);
    const bot_name = trim(args.bot_name);
    if (team_name.length === 0 || byteLength(team_name) > 48) {
      throw new SenderError("Team name must be 1-48 characters");
    }
    if (bot_name.length === 0 || byteLength(bot_name) > 32) {
      throw new SenderError("Bot name must be 1-32 characters");
    }
    const human = resolveHuman(ctx);
    if (ctx.db.team.name.find(team_name) != null) {
      throw new SenderError("Team name already taken");
    }
    if (ctx.db.team_member.user.find(human) != null) {
      throw new SenderError("You're already on a team");
    }
    if (ctx.db.bot.name.find(bot_name) != null) {
      throw new SenderError("Bot name already taken");
    }

    const team = ctx.db.team.insert({
      id: 0n,
      name: team_name,
      created_at: ctx.timestamp,
    });
    const bot = ctx.db.bot.insert({
      id: 0n,
      name: bot_name,
      team_id: team.id,
      is_simulated: false,
      strategy: { tag: "Human" },
      created_at: ctx.timestamp,
    });
    ctx.db.team_member.insert({
      id: 0n,
      team_id: team.id,
      user: human,
      role: { tag: "Owner" },
      joined_at: ctx.timestamp,
    });
    console.info(
      `Team '${team_name}' (id ${team.id}) created with bot '${bot_name}' (id ${bot.id})`,
    );
  },
);

export const join_team = spacetimedb.reducer(
  { team_name: t.string() },
  (ctx, args) => {
    const team_name = trim(args.team_name);
    const team = ctx.db.team.name.find(team_name);
    if (!team) {
      throw new SenderError("No such team");
    }
    const human = resolveHuman(ctx);
    if (ctx.db.team_member.user.find(human) != null) {
      throw new SenderError("You're already on a team");
    }
    ctx.db.team_member.insert({
      id: 0n,
      team_id: team.id,
      user: human,
      role: { tag: "Member" },
      joined_at: ctx.timestamp,
    });
    console.info(`Human ${human.toHexString()} joined team '${team_name}'`);
  },
);

export const leave_team = spacetimedb.reducer((ctx) => {
  const human = resolveHuman(ctx);
  const me = ctx.db.team_member.user.find(human);
  if (!me) {
    throw new SenderError("You're not on a team");
  }
  const team_id = me.team_id;
  ctx.db.team_member.id.delete(me.id);
  const remaining = [...ctx.db.team_member.tmember_by_team.filter(team_id)]
    .length;
  if (remaining === 0) {
    // Delete the team's bot too, with its credentials and any nonces
    // that would otherwise mint new credentials for it.
    const bot_ids = [...ctx.db.bot.bot_by_team.filter(team_id)].map(
      (b) => b.id,
    );
    // A tournament can't seat a deleted bot, so it would stall at the
    // bot's next match.
    if (bot_ids.some((bid) => heldForTournament(ctx, bid))) {
      throw new SenderError(
        "Your bot is still playing in a tournament; the last member can leave once it's knocked out or the tournament ends",
      );
    }
    for (const bid of bot_ids) {
      // Withdraw it from tournaments that haven't started. Entries in
      // tournaments it has played stay, as the record of what happened.
      for (const e of [...ctx.db.tournament_entry.te_by_bot.filter(bid)]) {
        const tour = ctx.db.tournament.id.find(e.tournament_id);
        if (tour?.status.tag === "Registration") {
          ctx.db.tournament_entry.id.delete(e.id);
        }
      }
      const cred_ids = [...ctx.db.bot_credential.cred_by_bot.filter(bid)].map(
        (c) => c.identity,
      );
      for (const cid of cred_ids) {
        ctx.db.bot_credential.identity.delete(cid);
      }
      const nonce_ids = [...ctx.db.credential_nonce.iter()]
        .filter((n) => n.bot_id === bid)
        .map((n) => n.id);
      for (const nid of nonce_ids) {
        ctx.db.credential_nonce.id.delete(nid);
      }
      const lobby_rows = [...ctx.db.lobby_member.lm_by_bot.filter(bid)].map(
        (m) => m.id,
      );
      for (const lid of lobby_rows) {
        ctx.db.lobby_member.id.delete(lid);
      }
      ctx.db.bot.id.delete(bid);
    }
    ctx.db.team.id.delete(team_id);
    console.info(`Team ${team_id} dissolved (no members left)`);
  }
});

export const promote_to_owner = spacetimedb.reducer(
  { target_user: t.identity() },
  (ctx, { target_user }) => {
    const human = resolveHuman(ctx);
    const me = ctx.db.team_member.user.find(human);
    if (!me) {
      throw new SenderError("You're not on a team");
    }
    if (me.role.tag !== "Owner") {
      throw new SenderError("Only owners can promote");
    }
    const target = ctx.db.team_member.user.find(target_user);
    if (!target) {
      throw new SenderError("Target user is not on a team");
    }
    if (target.team_id !== me.team_id) {
      throw new SenderError("Target user is not on your team");
    }
    ctx.db.team_member.id.update({ ...target, role: { tag: "Owner" } });
  },
);

// ---------- Credential provisioning ----------

// A team member mints a single-use nonce that can be redeemed by any client
// to receive a fresh credential for their team's bot.
export const mint_credential_nonce = spacetimedb.reducer((ctx) => {
  const human = resolveHuman(ctx);
  const member = ctx.db.team_member.user.find(human);
  if (!member) {
    throw new SenderError("You're not on a team — create or join one first");
  }
  const bot = [...ctx.db.bot.iter()].find((b) => b.team_id === member.team_id);
  if (!bot) {
    throw new SenderError("Your team has no bot");
  }
  let code = generateNonceCode(ctx, 0);
  for (let attempt = 1; ctx.db.credential_nonce.code.find(code); attempt++) {
    code = generateNonceCode(ctx, attempt);
  }
  const expires_at = afterSeconds(ctx.timestamp, NONCE_TTL_SECONDS);
  const nonce = ctx.db.credential_nonce.insert({
    id: 0n,
    code,
    bot_id: bot.id,
    creator: human,
    expires_at,
  });
  ctx.db.nonce_expiry_schedule.insert({
    scheduled_id: 0n,
    scheduled_at: ScheduleAt.time(expires_at.microsSinceUnixEpoch),
    nonce_id: nonce.id,
  });
  console.info(
    `Nonce minted for bot ${bot.id} (expires in ${NONCE_TTL_SECONDS}s)`,
  );
});

// A freshly-connected client (no token yet, OR a token unrelated to a bot)
// redeems a nonce. The client's identity becomes a new credential for the
// nonce's bot. The nonce is then deleted.
export const claim_credential = spacetimedb.reducer(
  { code: t.string() },
  (ctx, { code }) => {
    const nonce = ctx.db.credential_nonce.code.find(code);
    if (!nonce) {
      throw new SenderError("No such nonce");
    }
    // Its expiry job may not have run yet. (Deleting it here would be
    // rolled back along with everything else when we throw.)
    if (
      ctx.timestamp.microsSinceUnixEpoch >=
      nonce.expires_at.microsSinceUnixEpoch
    ) {
      throw new SenderError("This nonce has expired");
    }
    // Is the caller already a credential for ANY bot? Disallow — a fresh
    // client (no prior credential) must claim.
    if (ctx.db.bot_credential.identity.find(ctx.sender) != null) {
      throw new SenderError("Your identity is already a credential for a bot");
    }
    ctx.db.bot_credential.insert({
      identity: ctx.sender,
      bot_id: nonce.bot_id,
      connected: true,
      last_seen: ctx.timestamp,
    });
    ctx.db.credential_nonce.id.delete(nonce.id);
    console.info(`Credential claimed for bot ${nonce.bot_id}`);
  },
);

export const nonce_expiry_tick = spacetimedb.reducer(
  { onSchedule: nonce_expiry_schedule },
  { job: nonce_expiry_schedule.rowType },
  (ctx, { job }) => {
    requireScheduler(ctx);
    ctx.db.credential_nonce.id.delete(job.nonce_id);
  },
);

// ---------- Simulated bot ----------

export const spawn_simulated_bot = spacetimedb.reducer(
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
    if (ctx.db.bot_credential.identity.find(identity) != null) {
      throw new SenderError("Simulated bot already exists");
    }
    const bot = ctx.db.bot.insert({
      id: 0n,
      name: trimmed,
      team_id: 0n,
      is_simulated: true,
      strategy,
      created_at: ctx.timestamp,
    });
    ctx.db.bot_credential.insert({
      identity,
      bot_id: bot.id,
      connected: true,
      last_seen: ctx.timestamp,
    });
    console.info(`Simulated bot spawned: ${trimmed} (id ${bot.id})`);
  },
);

// One-shot migration helper: move historical `auction_top_bid` rows for
// ended matches into the public `auction_top_bid_archive`. New matches
// archive automatically via `onMatchEnded`; this drains the backlog from
// before the archive existed. Chunked because the table held ~1.4M rows;
// `max_rows` caps the work per call so the reducer stays under the time
// budget. Admin re-invokes until it reports zero moved.
export const backfill_top_bid_archive = spacetimedb.reducer(
  { max_rows: t.u32() },
  (ctx, { max_rows }) => {
    requireAdmin(ctx);
    if (max_rows === 0) {
      throw new SenderError("max_rows must be > 0");
    }
    let moved = 0;
    outer: for (const m of [
      ...ctx.db.match_state.match_by_status.filter({ tag: "Ended" }),
    ]) {
      const live = [...ctx.db.auction_top_bid.top_bid_by_match.filter(m.id)];
      for (const top of live) {
        ctx.db.auction_top_bid_archive.insert({
          auction_id: top.auction_id,
          match_id: top.match_id,
          top_bid: top.top_bid,
        });
        ctx.db.auction_top_bid.auction_id.delete(top.auction_id);
        moved += 1;
        if (moved >= max_rows) {
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
export const set_matchmaker_config = spacetimedb.reducer(
  {
    starting_rack_size: t.u32(),
    lobby_max_size: t.u32(),
    auction_duration_ms: t.u64(),
  },
  (ctx, { starting_rack_size, lobby_max_size, auction_duration_ms }) => {
    requireAdmin(ctx);
    if (starting_rack_size > 20) {
      throw new SenderError("Starting rack size must be 0-20");
    }
    if (lobby_max_size < 2 || lobby_max_size > 12) {
      throw new SenderError("Lobby size must be 2-12");
    }
    if (auction_duration_ms < 250n || auction_duration_ms > 10_000n) {
      throw new SenderError("Auction length must be 250-10000 ms");
    }
    // A full lobby's racks, plus a tile for the first auction, must fit in
    // the bag.
    if (lobby_max_size * starting_rack_size >= BAG_SIZE) {
      throw new SenderError(
        `A full lobby would be dealt more tiles than the bag's ${BAG_SIZE}`,
      );
    }
    const row = {
      id: 0,
      starting_rack_size,
      lobby_max_size,
      auction_duration_ms,
    };
    if (ctx.db.matchmaker_config.id.find(0)) {
      ctx.db.matchmaker_config.id.update(row);
    } else {
      ctx.db.matchmaker_config.insert(row);
    }
  },
);

// ---------- Bidding ----------

export const submit_bid = spacetimedb.reducer(
  { auction_id: t.u64(), amount: t.i64() },
  (ctx, { auction_id, amount }) => {
    if (amount < 0n) {
      throw new SenderError("Bid must be non-negative");
    }
    const bot_id = callerBotId(ctx);
    if (bot_id === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    const auction = ctx.db.auction.id.find(auction_id);
    if (!auction) {
      throw new SenderError("Unknown auction");
    }
    if (auction.status.tag !== "Open") {
      throw new SenderError("Auction closed");
    }
    if (
      ctx.timestamp.microsSinceUnixEpoch >=
      auction.closes_at.microsSinceUnixEpoch
    ) {
      throw new SenderError("Auction window expired");
    }
    const participant = findParticipant(ctx, auction.match_id, bot_id);
    if (!participant) {
      throw new SenderError("Not in this match");
    }
    if (participant.balance < amount) {
      throw new SenderError("Insufficient balance");
    }
    replaceBid(ctx, auction_id, bot_id, amount);
  },
);

// ---------- Word play ----------

export const submit_word = spacetimedb.reducer(
  { match_id: t.u64(), word: t.string() },
  (ctx, { match_id, word }) => {
    const m = ctx.db.match_state.id.find(match_id);
    if (!m) {
      throw new SenderError("Unknown match");
    }
    if (m.status.tag !== "Running") {
      throw new SenderError("Match not running");
    }
    const bot_id = callerBotId(ctx);
    if (bot_id === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    const participant = findParticipant(ctx, match_id, bot_id);
    if (!participant) {
      throw new SenderError("Not in this match");
    }

    const word_upper = asciiUppercase(word);
    if (byteLength(word_upper) < 2) {
      throw new SenderError("Word must be at least 2 letters");
    }
    if (!isAsciiUppercase(word_upper)) {
      throw new SenderError("Word must be A-Z only");
    }
    if (!isValidWord(word_upper)) {
      throw new SenderError(`'${word_upper}' is not in the dictionary`);
    }

    orThrow(playWord(ctx, participant, word_upper));
  },
);

// ---------- Lobby ----------

export const join_lobby = spacetimedb.reducer((ctx) => {
  const bot_id = callerBotId(ctx);
  if (bot_id === undefined) {
    throw new SenderError("Your identity is not a credential for any bot");
  }

  // Bots can't be in two places at once.
  if (botInRunningMatch(ctx, bot_id)) {
    throw new SenderError("You're already in a running match");
  }
  if (heldForTournament(ctx, bot_id)) {
    throw new SenderError(
      "You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends",
    );
  }

  const lobby = openLobbyOrCreate(ctx);

  // Idempotent: already in this open lobby is a no-op.
  const already = [...ctx.db.lobby_member.lm_by_lobby.filter(lobby.id)].some(
    (m) => m.bot_id === bot_id,
  );
  if (already) {
    return;
  }

  ctx.db.lobby_member.insert({
    id: 0n,
    lobby_id: lobby.id,
    bot_id,
    joined_at: ctx.timestamp,
  });

  // Auto-start if the lobby is now full of REAL bots (sim bots only enter
  // via timeout padding).
  const real_count = [
    ...ctx.db.lobby_member.lm_by_lobby.filter(lobby.id),
  ].filter((m) => {
    const b = ctx.db.bot.id.find(m.bot_id);
    return b ? !b.is_simulated : false;
  }).length;
  if (real_count >= lobby.max_size) {
    resolveLobby(ctx, lobby.id, false);
  }
});

export const lobby_timeout_tick = spacetimedb.reducer(
  { onSchedule: lobby_timeout_schedule },
  { job: lobby_timeout_schedule.rowType },
  (ctx, { job }) => {
    requireScheduler(ctx);
    resolveLobby(ctx, job.lobby_id, true);
  },
);

// ---------- Tournament ----------

// An admin creates a tournament, bots register for it from their own
// processes, and the admin starts it once enough have signed up.
export const create_tournament = spacetimedb.reducer(
  {
    swiss_rounds_total: t.u32(),
    top_cut: t.u32(),
    match_size: t.u32(),
    auction_type: AuctionType,
  },
  (ctx, { swiss_rounds_total, top_cut, match_size, auction_type }) => {
    requireAdmin(ctx);
    if (match_size < 2) {
      throw new SenderError("Tournament match_size must be >= 2");
    }
    if (swiss_rounds_total < 1) {
      throw new SenderError("Need at least 1 Swiss round");
    }
    if (top_cut < 2) {
      throw new SenderError("top_cut must be >= 2");
    }
    if ([...ctx.db.tournament.iter()].some(isActive)) {
      throw new SenderError("Another tournament is already in progress");
    }
    const tour = ctx.db.tournament.insert({
      id: 0n,
      status: { tag: "Registration" },
      swiss_rounds_total,
      current_round: 0,
      top_cut,
      match_size,
      auction_type,
      created_at: ctx.timestamp,
      ended_at: undefined,
      winner_bot_id: undefined,
    });
    console.info(`Tournament ${tour.id} created; registration open`);
  },
);

// Called by a bot's own process: the caller must be one of the bot's
// credentials, which a browser identity never is.
export const register_for_tournament = spacetimedb.reducer(
  { tournament_id: t.u64() },
  (ctx, { tournament_id }) => {
    const bot_id = callerBotId(ctx);
    if (bot_id === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    requireRegistration(ctx, tournament_id);
    if (entryFor(ctx, tournament_id, bot_id)) {
      return; // idempotent
    }
    addEntry(ctx, tournament_id, bot_id);
    console.info(`Bot ${bot_id} registered for tournament ${tournament_id}`);
  },
);

export const unregister_from_tournament = spacetimedb.reducer(
  { tournament_id: t.u64() },
  (ctx, { tournament_id }) => {
    const bot_id = callerBotId(ctx);
    if (bot_id === undefined) {
      throw new SenderError("Your identity is not a credential for any bot");
    }
    requireRegistration(ctx, tournament_id);
    const entry = entryFor(ctx, tournament_id, bot_id);
    if (entry) {
      ctx.db.tournament_entry.id.delete(entry.id);
    }
  },
);

// Enters every sim bot, so an admin can fill out the field for a rehearsal
// or a small event.
export const register_sim_bots = spacetimedb.reducer(
  { tournament_id: t.u64() },
  (ctx, { tournament_id }) => {
    requireAdmin(ctx);
    requireRegistration(ctx, tournament_id);
    for (const bot of [...ctx.db.bot.iter()]) {
      if (bot.is_simulated && !entryFor(ctx, tournament_id, bot.id)) {
        addEntry(ctx, tournament_id, bot.id);
      }
    }
  },
);

export const cancel_tournament = spacetimedb.reducer(
  { tournament_id: t.u64() },
  (ctx, { tournament_id }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournament_id);
    if (!tour) {
      throw new SenderError("Unknown tournament");
    }
    if (tour.status.tag !== "Registration") {
      throw new SenderError(
        "Only a tournament that hasn't started can be cancelled",
      );
    }
    for (const e of [
      ...ctx.db.tournament_entry.te_by_tournament.filter(tournament_id),
    ]) {
      ctx.db.tournament_entry.id.delete(e.id);
    }
    ctx.db.tournament.id.delete(tournament_id);
    console.info(`Tournament ${tournament_id} cancelled`);
  },
);

export const start_tournament = spacetimedb.reducer(
  { tournament_id: t.u64() },
  (ctx, { tournament_id }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournament_id);
    if (!tour) {
      throw new SenderError("Unknown tournament");
    }
    if (tour.status.tag !== "Registration") {
      throw new SenderError("Tournament has already started");
    }
    const entries = dropEntriesWithoutBots(ctx, tournament_id);
    if (entries.length < tour.match_size) {
      throw new SenderError(
        `Need at least ${tour.match_size} registered bots to start`,
      );
    }
    ctx.db.tournament.id.update({ ...tour, status: { tag: "Swiss" } });
    // Entrants waiting in the casual lobby leave it. From now on they can't
    // join one.
    for (const lobby of ctx.db.lobby.lobby_by_status.filter({ tag: "Open" })) {
      for (const m of [...ctx.db.lobby_member.lm_by_lobby.filter(lobby.id)]) {
        if (entries.some((e) => e.bot_id === m.bot_id)) {
          ctx.db.lobby_member.id.delete(m.id);
        }
      }
    }
    // A real bot can only play one match at a time, so round 1 waits for
    // entrants still in casual matches. With bots cycling through the
    // lobby, there's rarely a moment when none are.
    const busy = entrantsStillPlaying(ctx, tournament_id);
    if (busy.length > 0) {
      console.info(
        `Tournament ${tournament_id} started with ${entries.length} entrants; round 1 waits for ${busy
          .map((b) => b.name)
          .join(", ")}`,
      );
      return;
    }
    orThrow(startSwissRound(ctx, tournament_id, 1));
    console.info(
      `Tournament ${tournament_id} started with ${entries.length} entrants`,
    );
  },
);

// Stops a tournament that's under way, for when it can't or shouldn't
// finish. Its matches in progress play out, but their results no longer
// count, and its entrants are free to play in the lobby again.
export const force_end_tournament = spacetimedb.reducer(
  { tournament_id: t.u64() },
  (ctx, { tournament_id }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournament_id);
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
      ended_at: ctx.timestamp,
    });
    console.info(`Tournament ${tournament_id} stopped by an admin`);
  },
);

// Starts the next match of the finals: an elimination match, or the next
// game of the final. The admin runs these one at a time, so the finals can
// be played out on a stage.
export const start_next_finals_match = spacetimedb.reducer(
  { tournament_id: t.u64() },
  (ctx, { tournament_id }) => {
    requireAdmin(ctx);
    const tour = ctx.db.tournament.id.find(tournament_id);
    if (!tour) {
      throw new SenderError("Unknown tournament");
    }
    orThrow(startNextFinalsMatch(ctx, tour));
  },
);

// ---------- ELO ----------

// Resets all BotStats and replays ELO across every ended match in chronological order.
export const backfill_elo = spacetimedb.reducer((ctx) => {
  requireAdmin(ctx);

  for (const stats of [...ctx.db.bot_stats.iter()]) {
    ctx.db.bot_stats.bot_id.delete(stats.bot_id);
  }

  for (const m of endedMatchesInOrder(ctx)) {
    updateEloAtMatchEnd(ctx, m.id);
  }
});

// ---------- Auction tick (scheduled) ----------

export const auction_tick = spacetimedb.reducer(
  { onSchedule: auction_schedule },
  { job: auction_schedule.rowType },
  (ctx, { job }) => {
    requireScheduler(ctx);
    closeAuction(ctx, job.match_id);
  },
);
