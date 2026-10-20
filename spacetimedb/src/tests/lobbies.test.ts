// The lobby: joining, filling up, timing out and padding with sims.

import { expect, test } from "vitest";
import { LOBBY_MAX_SIZE } from "../game";
import {
  createTournament,
  forceEndTournament,
  joinLobby,
  leaveTeam,
  lobbyTimeoutTick,
  registerForTournament,
  registerSimBots,
  startTournament,
} from "../index";
import type { Lobby } from "../schema";
import {
  asClaims,
  byBigint,
  call,
  emptyDb,
  failure,
  getMatch,
  makeAdmin,
  lobbyJob,
  lobbyTimeout,
  newDb,
  now,
  runToEnd,
  simIds,
  startMatch,
  teamWithBot,
  VICKREY,
  type Test,
} from "./harness";

function openLobby(db: Test): Lobby {
  const open = [...db.db.lobby.lobbyByStatus.filter({ tag: "Open" })];
  expect(open.length, "expected exactly one open lobby").toBe(1);
  return open[0]!;
}

function members(db: Test, lobbyId: bigint): bigint[] {
  return [...db.db.lobbyMember.lmByLobby.filter(lobbyId)]
    .map((m) => m.botId)
    .sort(byBigint);
}

function join(db: Test, bot: string) {
  call(db, bot, (tx) => joinLobby(tx, {}));
}

/** `n` real bots, Bot0..Bot(n-1), each on its own team. */
function realBots(db: Test, n: number): bigint[] {
  return Array.from({ length: n }, (_, i) =>
    teamWithBot(db, `owner${i}`, `Bot${i}`),
  );
}

function matchRoster(db: Test, matchId: bigint): bigint[] {
  return [...db.db.matchParticipant.mpByMatch.filter(matchId)]
    .map((p) => p.botId)
    .sort(byBigint);
}

test("only bots can join", () => {
  const db = newDb();
  expect(failure(() => join(db, "stranger"))).toBe(
    "Your identity is not a credential for any bot",
  );
});

test("joining is idempotent", () => {
  const db = newDb();
  const bot = teamWithBot(db, "alice", "Robo");
  join(db, "Robo");
  join(db, "Robo");
  expect(members(db, openLobby(db).id)).toEqual([bot]);
});

test("a lobby full of real bots starts a match at once", () => {
  const db = newDb();
  const bots = realBots(db, LOBBY_MAX_SIZE);
  const lobby = openLobby(db);
  for (let i = 0; i < bots.length; i++) {
    join(db, `Bot${i}`);
  }

  const resolved = db.db.lobby.id.find(lobby.id)!;
  expect(resolved.status.tag).toBe("Resolved");
  const matchId = resolved.resolvedMatchId;
  expect(matchId, "lobby should record its match").toBeDefined();
  bots.sort(byBigint);
  expect(matchRoster(db, matchId!), "no sims padded in").toEqual(bots);
  expect(getMatch(db, matchId!).auctionType.tag).toBe("Vickrey");

  const next = openLobby(db);
  expect(next.id).not.toBe(lobby.id);
  expect(members(db, next.id)).toEqual([]);
});

test("sims in the lobby do not count towards filling it", () => {
  const db = newDb();
  realBots(db, LOBBY_MAX_SIZE - 1);
  for (let i = 0; i < LOBBY_MAX_SIZE - 1; i++) {
    join(db, `Bot${i}`);
  }
  db.withReducerTx(asClaims("sim", "Cheapo-sim"), (tx) => joinLobby(tx, {}));

  const lobby = openLobby(db);
  expect(members(db, lobby.id).length).toBe(LOBBY_MAX_SIZE);
  expect(db.db.matchState.count()).toBe(0n);
});

test("timing out pads the lobby with distinct sims", () => {
  const db = newDb();
  const real = realBots(db, 2);
  join(db, "Bot0");
  join(db, "Bot1");
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const matchId = db.db.lobby.id.find(lobby.id)!.resolvedMatchId!;
  const roster = matchRoster(db, matchId);
  expect(roster.length).toBe(LOBBY_MAX_SIZE);
  for (const bot of real) {
    expect(roster).toContain(bot);
  }
  const sims = roster.filter((id) => simIds(db).includes(id));
  expect(sims.length).toBe(4);
  expect(openLobby(db).id).not.toBe(lobby.id);
});

test("an empty lobby times out into an all sim match", () => {
  const db = newDb();
  const lobby = openLobby(db);
  lobbyTimeout(db, lobby.id);

  const matchId = db.db.lobby.id.find(lobby.id)!.resolvedMatchId!;
  expect(matchRoster(db, matchId)).toEqual(simIds(db));
});

test("a lobby that cannot reach two players is cancelled", () => {
  const db = emptyDb();
  teamWithBot(db, "alice", "Robo");
  join(db, "Robo");
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const cancelled = db.db.lobby.id.find(lobby.id)!;
  expect(cancelled.status.tag).toBe("Cancelled");
  expect(cancelled.resolvedMatchId).toBeUndefined();
  expect(db.db.matchState.count()).toBe(0n);
  const next = openLobby(db);
  expect(next.id).not.toBe(lobby.id);
  expect(
    [...db.db.lobbyTimeoutSchedule.iter()].filter((s) => s.lobbyId === next.id)
      .length,
  ).toBe(1);
});

test("a late timeout for a resolved lobby does nothing", () => {
  const db = newDb();
  realBots(db, LOBBY_MAX_SIZE);
  const lobby = openLobby(db);
  for (let i = 0; i < LOBBY_MAX_SIZE; i++) {
    join(db, `Bot${i}`);
  }
  const next = openLobby(db);

  lobbyTimeout(db, lobby.id);
  lobbyTimeout(db, 9999n);

  expect(db.db.matchState.count()).toBe(1n);
  expect(openLobby(db).id).toBe(next.id);
});

test("bots in a running match cannot join", () => {
  const db = newDb();
  const bot = teamWithBot(db, "alice", "Robo");
  startMatch(db, VICKREY, [bot, simIds(db)[0]!]);
  expect(failure(() => join(db, "Robo"))).toBe(
    "You're already in a running match",
  );
});

test("bots can rejoin once their match ends", () => {
  const db = newDb();
  const bot = teamWithBot(db, "alice", "Robo");
  const m = startMatch(db, VICKREY, [bot, simIds(db)[0]!]);
  runToEnd(db, m);
  join(db, "Robo");
});

test("a dissolved teams bot leaves the lobby", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  join(db, "Ann");

  call(db, "alice", (tx) => leaveTeam(tx, {}));

  expect([...db.db.lobbyMember.lmByBot.filter(ann)]).toEqual([]);
});

test("a bot whose team dissolves in the lobby does not break the match", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  join(db, "Ann");
  join(db, "Ben");
  call(db, "alice", (tx) => leaveTeam(tx, {}));
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const m = db.db.lobby.id.find(lobby.id)!.resolvedMatchId!;
  const roster = matchRoster(db, m);
  expect(roster.includes(ben) && !roster.includes(ann)).toBe(true);
  expect(roster.length).toBe(LOBBY_MAX_SIZE);
  expect(getMatch(db, m).currentAuctionId).toBeDefined();
  runToEnd(db, m);
  join(db, "Ben"); // Ben should be free to play again
});

test("lobby members whose bot is gone are skipped", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  join(db, "Ann");
  const lobby = openLobby(db);
  // A stale row, e.g. from before leaveTeam cleaned up lobbies.
  db.db.lobbyMember.insert({
    id: 0n,
    lobbyId: lobby.id,
    botId: 9999n,
    joinedAt: now(),
  });

  lobbyTimeout(db, lobby.id);

  const resolved = db.db.lobby.id.find(lobby.id)!;
  expect(resolved.status.tag).toBe("Resolved");
  const roster = matchRoster(db, resolved.resolvedMatchId!);
  expect(roster.includes(ann) && !roster.includes(9999n)).toBe(true);
  expect(roster.length).toBe(LOBBY_MAX_SIZE);
});

test("clients cannot force a lobby timeout", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Robo");
  const lobby = openLobby(db);

  for (const who of ["mallory", "Robo"]) {
    const err = failure(() =>
      call(db, who, (tx) => lobbyTimeoutTick(tx, { job: lobbyJob(lobby.id) })),
    );
    expect(err).toBe("Only the scheduler may call this");
  }
  expect(openLobby(db).id, "lobby should still be open").toBe(lobby.id);
});

// ---------- Tournament lockout ----------

/** A tournament with Ann and the sims entered; started unless `open`. */
function tournamentWithAnn(db: Test, open = false): bigint {
  makeAdmin(db, "admin");
  call(db, "admin", (tx) =>
    createTournament(tx, {
      swissRoundsTotal: 1,
      topCut: 2,
      matchSize: 3,
      auctionType: { tag: "Vickrey" },
    }),
  );
  const t = [...db.db.tournament.iter()][0]!.id;
  call(db, "Ann", (tx) => registerForTournament(tx, { tournamentId: t }));
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId: t }));
  if (!open) {
    call(db, "admin", (tx) => startTournament(tx, { tournamentId: t }));
  }
  return t;
}

const HELD =
  "You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends";

test("entrants cannot join the lobby once their tournament starts", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  tournamentWithAnn(db);
  // Finish Ann's Swiss match while the other table plays on, so she is
  // between matches but still in the tournament.
  const [own] = [...db.db.matchParticipant.mpByBot.filter(ann)];
  runToEnd(db, own!.matchId);
  const running = [
    ...db.db.matchState.matchByStatus.filter({ tag: "Running" }),
  ];
  expect(running.length, "the other table is still playing").toBe(1);
  expect(failure(() => join(db, "Ann"))).toBe(HELD);
});

test("starting a tournament takes its entrants out of the lobby", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  const t = tournamentWithAnn(db, true);
  join(db, "Ann");
  join(db, "Ben");

  call(db, "admin", (tx) => startTournament(tx, { tournamentId: t }));

  expect(members(db, openLobby(db).id)).toEqual([ben]);
  expect(members(db, openLobby(db).id)).not.toContain(ann);
});

test("a lobby skips members held for a tournament", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  tournamentWithAnn(db);
  join(db, "Ben");
  const lobby = openLobby(db);
  // A stale row that slipped in before the start.
  db.db.lobbyMember.insert({
    id: 0n,
    lobbyId: lobby.id,
    botId: ann,
    joinedAt: now(),
  });

  lobbyTimeout(db, lobby.id);

  const m = db.db.lobby.id.find(lobby.id)!.resolvedMatchId!;
  const roster = matchRoster(db, m);
  expect(roster).toContain(ben);
  expect(roster).not.toContain(ann);
});

test("sims in a tournament still pad casual lobbies", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Ann");
  teamWithBot(db, "bob", "Ben");
  tournamentWithAnn(db);
  join(db, "Ben");
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const m = db.db.lobby.id.find(lobby.id)!.resolvedMatchId!;
  expect(matchRoster(db, m).length).toBe(LOBBY_MAX_SIZE);
});

test("a knocked out entrant can join the lobby again", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournamentWithAnn(db);
  for (const m of [...db.db.matchParticipant.mpByBot.filter(ann)]) {
    runToEnd(db, m.matchId);
  }
  const entry = [...db.db.tournamentEntry.teByTournament.filter(t)].find(
    (e) => e.botId === ann,
  )!;
  db.db.tournamentEntry.id.update({ ...entry, eliminated: true });

  join(db, "Ann");
});

test("the lobby reopens when the tournament ends", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournamentWithAnn(db);
  for (const m of [...db.db.matchParticipant.mpByBot.filter(ann)]) {
    runToEnd(db, m.matchId);
  }
  const tour = db.db.tournament.id.find(t)!;
  db.db.tournament.id.update({ ...tour, status: { tag: "Ended" } });

  join(db, "Ann");
});

test("the lobby reopens when the tournament is stopped", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournamentWithAnn(db);
  for (const m of [...db.db.matchParticipant.mpByBot.filter(ann)]) {
    runToEnd(db, m.matchId);
  }
  call(db, "admin", (tx) => forceEndTournament(tx, { tournamentId: t }));

  join(db, "Ann");
});
