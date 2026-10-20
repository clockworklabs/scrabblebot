// The lobby: joining, filling up, timing out and padding with sims.

import { expect, test } from "vitest";
import { LOBBY_MAX_SIZE } from "../game";
import {
  create_tournament,
  force_end_tournament,
  join_lobby,
  leave_team,
  lobby_timeout_tick,
  register_for_tournament,
  register_sim_bots,
  start_tournament,
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
  const open = [...db.db.lobby.lobby_by_status.filter({ tag: "Open" })];
  expect(open.length, "expected exactly one open lobby").toBe(1);
  return open[0]!;
}

function members(db: Test, lobbyId: bigint): bigint[] {
  return [...db.db.lobby_member.lm_by_lobby.filter(lobbyId)]
    .map((m) => m.bot_id)
    .sort(byBigint);
}

function join(db: Test, bot: string) {
  call(db, bot, (tx) => join_lobby(tx, {}));
}

/** `n` real bots, Bot0..Bot(n-1), each on its own team. */
function realBots(db: Test, n: number): bigint[] {
  return Array.from({ length: n }, (_, i) =>
    teamWithBot(db, `owner${i}`, `Bot${i}`),
  );
}

function matchRoster(db: Test, matchId: bigint): bigint[] {
  return [...db.db.match_participant.mp_by_match.filter(matchId)]
    .map((p) => p.bot_id)
    .sort(byBigint);
}

test("only_bots_can_join", () => {
  const db = newDb();
  expect(failure(() => join(db, "stranger"))).toBe(
    "Your identity is not a credential for any bot",
  );
});

test("joining_is_idempotent", () => {
  const db = newDb();
  const bot = teamWithBot(db, "alice", "Robo");
  join(db, "Robo");
  join(db, "Robo");
  expect(members(db, openLobby(db).id)).toEqual([bot]);
});

test("a_lobby_full_of_real_bots_starts_a_match_at_once", () => {
  const db = newDb();
  const bots = realBots(db, LOBBY_MAX_SIZE);
  const lobby = openLobby(db);
  for (let i = 0; i < bots.length; i++) {
    join(db, `Bot${i}`);
  }

  const resolved = db.db.lobby.id.find(lobby.id)!;
  expect(resolved.status.tag).toBe("Resolved");
  const matchId = resolved.resolved_match_id;
  expect(matchId, "lobby should record its match").toBeDefined();
  bots.sort(byBigint);
  expect(matchRoster(db, matchId!), "no sims padded in").toEqual(bots);
  expect(getMatch(db, matchId!).auction_type.tag).toBe("Vickrey");

  const next = openLobby(db);
  expect(next.id).not.toBe(lobby.id);
  expect(members(db, next.id)).toEqual([]);
});

test("sims_in_the_lobby_do_not_count_towards_filling_it", () => {
  const db = newDb();
  realBots(db, LOBBY_MAX_SIZE - 1);
  for (let i = 0; i < LOBBY_MAX_SIZE - 1; i++) {
    join(db, `Bot${i}`);
  }
  db.withReducerTx(asClaims("sim", "Cheapo-sim"), (tx) => join_lobby(tx, {}));

  const lobby = openLobby(db);
  expect(members(db, lobby.id).length).toBe(LOBBY_MAX_SIZE);
  expect(db.db.match_state.count()).toBe(0n);
});

test("timing_out_pads_the_lobby_with_distinct_sims", () => {
  const db = newDb();
  const real = realBots(db, 2);
  join(db, "Bot0");
  join(db, "Bot1");
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const matchId = db.db.lobby.id.find(lobby.id)!.resolved_match_id!;
  const roster = matchRoster(db, matchId);
  expect(roster.length).toBe(LOBBY_MAX_SIZE);
  for (const bot of real) {
    expect(roster).toContain(bot);
  }
  const sims = roster.filter((id) => simIds(db).includes(id));
  expect(sims.length).toBe(4);
  expect(openLobby(db).id).not.toBe(lobby.id);
});

test("an_empty_lobby_times_out_into_an_all_sim_match", () => {
  const db = newDb();
  const lobby = openLobby(db);
  lobbyTimeout(db, lobby.id);

  const matchId = db.db.lobby.id.find(lobby.id)!.resolved_match_id!;
  expect(matchRoster(db, matchId)).toEqual(simIds(db));
});

test("a_lobby_that_cannot_reach_two_players_is_cancelled", () => {
  const db = emptyDb();
  teamWithBot(db, "alice", "Robo");
  join(db, "Robo");
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const cancelled = db.db.lobby.id.find(lobby.id)!;
  expect(cancelled.status.tag).toBe("Cancelled");
  expect(cancelled.resolved_match_id).toBeUndefined();
  expect(db.db.match_state.count()).toBe(0n);
  const next = openLobby(db);
  expect(next.id).not.toBe(lobby.id);
  expect(
    [...db.db.lobby_timeout_schedule.iter()].filter(
      (s) => s.lobby_id === next.id,
    ).length,
  ).toBe(1);
});

test("a_late_timeout_for_a_resolved_lobby_does_nothing", () => {
  const db = newDb();
  realBots(db, LOBBY_MAX_SIZE);
  const lobby = openLobby(db);
  for (let i = 0; i < LOBBY_MAX_SIZE; i++) {
    join(db, `Bot${i}`);
  }
  const next = openLobby(db);

  lobbyTimeout(db, lobby.id);
  lobbyTimeout(db, 9999n);

  expect(db.db.match_state.count()).toBe(1n);
  expect(openLobby(db).id).toBe(next.id);
});

test("bots_in_a_running_match_cannot_join", () => {
  const db = newDb();
  const bot = teamWithBot(db, "alice", "Robo");
  startMatch(db, VICKREY, [bot, simIds(db)[0]!]);
  expect(failure(() => join(db, "Robo"))).toBe(
    "You're already in a running match",
  );
});

test("bots_can_rejoin_once_their_match_ends", () => {
  const db = newDb();
  const bot = teamWithBot(db, "alice", "Robo");
  const m = startMatch(db, VICKREY, [bot, simIds(db)[0]!]);
  runToEnd(db, m);
  join(db, "Robo");
});

test("a_dissolved_teams_bot_leaves_the_lobby", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  join(db, "Ann");

  call(db, "alice", (tx) => leave_team(tx, {}));

  expect([...db.db.lobby_member.lm_by_bot.filter(ann)]).toEqual([]);
});

test("a_bot_whose_team_dissolves_in_the_lobby_does_not_break_the_match", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  join(db, "Ann");
  join(db, "Ben");
  call(db, "alice", (tx) => leave_team(tx, {}));
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const m = db.db.lobby.id.find(lobby.id)!.resolved_match_id!;
  const roster = matchRoster(db, m);
  expect(roster.includes(ben) && !roster.includes(ann)).toBe(true);
  expect(roster.length).toBe(LOBBY_MAX_SIZE);
  expect(getMatch(db, m).current_auction_id).toBeDefined();
  runToEnd(db, m);
  join(db, "Ben"); // Ben should be free to play again
});

test("lobby_members_whose_bot_is_gone_are_skipped", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  join(db, "Ann");
  const lobby = openLobby(db);
  // A stale row, e.g. from before leave_team cleaned up lobbies.
  db.db.lobby_member.insert({
    id: 0n,
    lobby_id: lobby.id,
    bot_id: 9999n,
    joined_at: now(),
  });

  lobbyTimeout(db, lobby.id);

  const resolved = db.db.lobby.id.find(lobby.id)!;
  expect(resolved.status.tag).toBe("Resolved");
  const roster = matchRoster(db, resolved.resolved_match_id!);
  expect(roster.includes(ann) && !roster.includes(9999n)).toBe(true);
  expect(roster.length).toBe(LOBBY_MAX_SIZE);
});

test("clients_cannot_force_a_lobby_timeout", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Robo");
  const lobby = openLobby(db);

  for (const who of ["mallory", "Robo"]) {
    const err = failure(() =>
      call(db, who, (tx) =>
        lobby_timeout_tick(tx, { job: lobbyJob(lobby.id) }),
      ),
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
    create_tournament(tx, {
      swiss_rounds_total: 1,
      top_cut: 2,
      match_size: 3,
      auction_type: { tag: "Vickrey" },
    }),
  );
  const t = [...db.db.tournament.iter()][0]!.id;
  call(db, "Ann", (tx) => register_for_tournament(tx, { tournament_id: t }));
  call(db, "admin", (tx) => register_sim_bots(tx, { tournament_id: t }));
  if (!open) {
    call(db, "admin", (tx) => start_tournament(tx, { tournament_id: t }));
  }
  return t;
}

const HELD =
  "You're playing in a tournament; the lobby reopens to you when you're knocked out or it ends";

test("entrants_cannot_join_the_lobby_once_their_tournament_starts", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  tournamentWithAnn(db);
  // Finish Ann's Swiss match while the other table plays on, so she is
  // between matches but still in the tournament.
  const [own] = [...db.db.match_participant.mp_by_bot.filter(ann)];
  runToEnd(db, own!.match_id);
  const running = [
    ...db.db.match_state.match_by_status.filter({ tag: "Running" }),
  ];
  expect(running.length, "the other table is still playing").toBe(1);
  expect(failure(() => join(db, "Ann"))).toBe(HELD);
});

test("starting_a_tournament_takes_its_entrants_out_of_the_lobby", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  const t = tournamentWithAnn(db, true);
  join(db, "Ann");
  join(db, "Ben");

  call(db, "admin", (tx) => start_tournament(tx, { tournament_id: t }));

  expect(members(db, openLobby(db).id)).toEqual([ben]);
  expect(members(db, openLobby(db).id)).not.toContain(ann);
});

test("a_lobby_skips_members_held_for_a_tournament", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  tournamentWithAnn(db);
  join(db, "Ben");
  const lobby = openLobby(db);
  // A stale row that slipped in before the start.
  db.db.lobby_member.insert({
    id: 0n,
    lobby_id: lobby.id,
    bot_id: ann,
    joined_at: now(),
  });

  lobbyTimeout(db, lobby.id);

  const m = db.db.lobby.id.find(lobby.id)!.resolved_match_id!;
  const roster = matchRoster(db, m);
  expect(roster).toContain(ben);
  expect(roster).not.toContain(ann);
});

test("sims_in_a_tournament_still_pad_casual_lobbies", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Ann");
  teamWithBot(db, "bob", "Ben");
  tournamentWithAnn(db);
  join(db, "Ben");
  const lobby = openLobby(db);

  lobbyTimeout(db, lobby.id);

  const m = db.db.lobby.id.find(lobby.id)!.resolved_match_id!;
  expect(matchRoster(db, m).length).toBe(LOBBY_MAX_SIZE);
});

test("a_knocked_out_entrant_can_join_the_lobby_again", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournamentWithAnn(db);
  for (const m of [...db.db.match_participant.mp_by_bot.filter(ann)]) {
    runToEnd(db, m.match_id);
  }
  const entry = [...db.db.tournament_entry.te_by_tournament.filter(t)].find(
    (e) => e.bot_id === ann,
  )!;
  db.db.tournament_entry.id.update({ ...entry, eliminated: true });

  join(db, "Ann");
});

test("the_lobby_reopens_when_the_tournament_ends", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournamentWithAnn(db);
  for (const m of [...db.db.match_participant.mp_by_bot.filter(ann)]) {
    runToEnd(db, m.match_id);
  }
  const tour = db.db.tournament.id.find(t)!;
  db.db.tournament.id.update({ ...tour, status: { tag: "Ended" } });

  join(db, "Ann");
});

test("the_lobby_reopens_when_the_tournament_is_stopped", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournamentWithAnn(db);
  for (const m of [...db.db.match_participant.mp_by_bot.filter(ann)]) {
    runToEnd(db, m.match_id);
  }
  call(db, "admin", (tx) => force_end_tournament(tx, { tournament_id: t }));

  join(db, "Ann");
});
