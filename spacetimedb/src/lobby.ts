import { ScheduleAt } from "spacetimedb";
import {
  afterSeconds,
  isErr,
  LOBBY_DURATION_SECONDS,
  matchDefaults,
  shuffle,
  startMatchWith,
  type Ctx,
} from "./game";
import type { Lobby } from "./schema";
import { heldForTournament } from "./tournament";

// The lobby sits above both the match core (`game`) and tournaments: it
// starts matches, but must keep bots held for a tournament out of them.

// Returns the current open Lobby, creating one (and scheduling its timeout)
// if none is open.
export function openLobbyOrCreate(ctx: Ctx): Lobby {
  for (const l of ctx.db.lobby.lobbyByStatus.filter({ tag: "Open" })) {
    return l;
  }
  const closesAt = afterSeconds(ctx.timestamp, LOBBY_DURATION_SECONDS);
  const lobby = ctx.db.lobby.insert({
    id: 0n,
    status: { tag: "Open" },
    opensAt: ctx.timestamp,
    closesAt,
    maxSize: matchDefaults(ctx).lobbyMaxSize,
    auctionType: { tag: "Vickrey" },
    resolvedMatchId: undefined,
  });
  ctx.db.lobbyTimeoutSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(closesAt.microsSinceUnixEpoch),
    lobbyId: lobby.id,
  });
  console.info(`Opened lobby ${lobby.id}`);
  return lobby;
}

// Resolve an open Lobby into a Match (when full or on timeout) and start a
// fresh lobby in its place. `padWithSims` adds idle simulated bots to
// reach maxSize — only true for timeouts.
export function resolveLobby(ctx: Ctx, lobbyId: bigint, padWithSims: boolean) {
  const lobby = ctx.db.lobby.id.find(lobbyId);
  if (!lobby) {
    return;
  }
  if (lobby.status.tag !== "Open") {
    return; // already handled
  }

  // Skip members whose bot has since been deleted (its team dissolved),
  // or is being held for a tournament.
  const roster = [...ctx.db.lobbyMember.lmByLobby.filter(lobbyId)]
    .map((m) => m.botId)
    .filter(
      (id) => ctx.db.bot.id.find(id) != null && !heldForTournament(ctx, id),
    );

  if (padWithSims) {
    // Sim bots are reusable — they're driven inside the module, so a
    // single Cheapo can play any number of concurrent matches (each
    // gets its own MatchParticipant / Holding rows). We just need to
    // avoid putting the same sim in *this* lobby twice.
    const inRoster = new Set(roster);
    const availableSims = [...ctx.db.bot.iter()]
      .filter((b) => b.isSimulated && !inRoster.has(b.id))
      .map((b) => b.id);
    // Shuffle so we don't always grab the same sim bots first.
    shuffle(ctx, availableSims);
    const need = Math.max(lobby.maxSize - roster.length, 0);
    for (const simId of availableSims.slice(0, need)) {
      ctx.db.lobbyMember.insert({
        id: 0n,
        lobbyId,
        botId: simId,
        joinedAt: ctx.timestamp,
      });
      roster.push(simId);
    }
  }

  if (roster.length < 2) {
    // Not enough to play. Cancel and try again with a fresh lobby.
    ctx.db.lobby.id.update({ ...lobby, status: { tag: "Cancelled" } });
    console.warn(`Lobby ${lobbyId} cancelled (<2 participants)`);
    openLobbyOrCreate(ctx);
    return;
  }

  const started = startMatchWith(ctx, lobby.auctionType, roster);
  if (isErr(started)) {
    ctx.db.lobby.id.update({ ...lobby, status: { tag: "Cancelled" } });
    console.error(`Lobby ${lobbyId} cancelled: ${started.err}`);
  } else {
    ctx.db.lobby.id.update({
      ...lobby,
      status: { tag: "Resolved" },
      resolvedMatchId: started.ok,
    });
    console.info(`Lobby ${lobbyId} resolved -> match ${started.ok}`);
  }

  openLobbyOrCreate(ctx);
}
