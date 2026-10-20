// Tournament registration: creating a tournament, bots signing up from
// their own processes, and the checks made when the admin starts it.

import { expect, test } from "vitest";
import {
  cancel_tournament,
  create_tournament,
  join_lobby,
  join_team,
  leave_team,
  register_for_tournament,
  register_sim_bots,
  start_tournament,
  unregister_from_tournament,
} from "../index";
import type { TournamentEntry } from "../schema";
import {
  asClaims,
  byBigint,
  call,
  failure,
  makeAdmin,
  newDb,
  runToEnd,
  simIds,
  startMatch,
  teamWithBot,
  VICKREY,
  type Test,
} from "./harness";

function adminDb(): Test {
  const db = newDb();
  makeAdmin(db, "admin");
  return db;
}

function create(db: Test, matchSize = 3): bigint {
  call(db, "admin", (tx) =>
    create_tournament(tx, {
      swiss_rounds_total: 1,
      top_cut: 2,
      match_size: matchSize,
      auction_type: { tag: "Vickrey" },
    }),
  );
  return [...db.db.tournament.iter()]
    .map((t) => t.id)
    .reduce((a, b) => (a > b ? a : b));
}

const register = (db: Test, who: string, tournament_id: bigint) =>
  call(db, who, (tx) => register_for_tournament(tx, { tournament_id }));
const unregister = (db: Test, who: string, tournament_id: bigint) =>
  call(db, who, (tx) => unregister_from_tournament(tx, { tournament_id }));
const start = (db: Test, tournament_id: bigint) =>
  call(db, "admin", (tx) => start_tournament(tx, { tournament_id }));
const registerSims = (db: Test, tournament_id: bigint) =>
  call(db, "admin", (tx) => register_sim_bots(tx, { tournament_id }));

function entrants(db: Test, t: bigint): bigint[] {
  return [...db.db.tournament_entry.te_by_tournament.filter(t)]
    .map((e: TournamentEntry) => e.bot_id)
    .sort(byBigint);
}

test("a_new_tournament_opens_for_registration", () => {
  const db = adminDb();
  const t = create(db);
  const tour = db.db.tournament.id.find(t)!;
  expect(tour.status.tag).toBe("Registration");
  expect(entrants(db, t)).toEqual([]);
  expect(db.db.match_state.count(), "nothing starts yet").toBe(0n);
});

test("only_one_tournament_can_be_active", () => {
  const db = adminDb();
  const t = create(db);
  expect(failure(() => create(db))).toBe(
    "Another tournament is already in progress",
  );
  call(db, "admin", (tx) => cancel_tournament(tx, { tournament_id: t }));
  create(db);
});

test("bots_register_and_unregister_themselves", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);

  register(db, "Ann", t);
  register(db, "Ann", t); // idempotent
  expect(entrants(db, t)).toEqual([ann]);

  unregister(db, "Ann", t);
  expect(entrants(db, t)).toEqual([]);
});

test("only_a_bots_own_credential_can_register_it", () => {
  const db = adminDb();
  teamWithBot(db, "alice", "Ann");
  const t = create(db);
  // The team's human, or a browser linked to them, is not the bot.
  for (const who of ["alice", "stranger"]) {
    expect(failure(() => register(db, who, t))).toBe(
      "Your identity is not a credential for any bot",
    );
  }
  expect(failure(() => register(db, "Ann", 999n))).toBe("Unknown tournament");
});

test("registration_closes_when_the_tournament_starts", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  teamWithBot(db, "bob", "Ben");
  const t = create(db);
  register(db, "Ann", t);
  registerSims(db, t);
  start(db, t);

  expect(failure(() => register(db, "Ben", t))).toBe(
    "Tournament is not taking registrations",
  );
  expect(failure(() => unregister(db, "Ann", t))).toBe(
    "Tournament is not taking registrations",
  );
  expect(entrants(db, t)).toContain(ann);
});

test("register_sim_bots_enters_each_sim_once", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  registerSims(db, t);
  expect(entrants(db, t)).toEqual(simIds(db));
});

test("starting_moves_to_swiss_and_plays_round_one", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  start(db, t);

  const tour = db.db.tournament.id.find(t)!;
  expect([tour.status.tag, tour.current_round]).toEqual(["Swiss", 1]);
  expect(db.db.tournament_match.count()).toBe(2n);
  expect(failure(() => start(db, t))).toBe("Tournament has already started");
});

test("starting_drops_entrants_whose_bot_is_gone", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  registerSims(db, t);
  db.db.bot.id.delete(ann); // e.g. its team dissolved

  start(db, t);

  expect(entrants(db, t)).toEqual(simIds(db));
});

// With bots cycling through the lobby, some entrant is nearly always in a
// casual match, so the start can't wait for a moment when none are.
test("round_one_waits_for_entrants_in_running_matches", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  registerSims(db, t);
  const casual = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);

  start(db, t);

  const tour = db.db.tournament.id.find(t)!;
  expect([tour.status.tag, tour.current_round]).toEqual(["Swiss", 0]);
  expect(db.db.tournament_match.count()).toBe(0n);

  runToEnd(db, casual);

  expect(db.db.tournament.id.find(t)!.current_round).toBe(1);
  const seated = [...db.db.tournament_match.tm_by_tournament.filter(t)]
    .flatMap((tm) => [
      ...db.db.match_participant.mp_by_match.filter(tm.match_id),
    ])
    .map((p) => p.bot_id);
  expect(seated).toContain(ann);
});

test("sim_entrants_in_running_matches_do_not_hold_up_the_start", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  startMatch(db, VICKREY, simIds(db).slice(0, 2));

  start(db, t);

  expect(db.db.tournament.id.find(t)!.status.tag).toBe("Swiss");
});

test("cancelling_removes_a_tournament_that_has_not_started", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);

  call(db, "admin", (tx) => cancel_tournament(tx, { tournament_id: t }));

  expect(db.db.tournament.count()).toBe(0n);
  expect(db.db.tournament_entry.count()).toBe(0n);
});

test("a_started_tournament_cannot_be_cancelled", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  start(db, t);
  expect(
    failure(() =>
      call(db, "admin", (tx) => cancel_tournament(tx, { tournament_id: t })),
    ),
  ).toBe("Only a tournament that hasn't started can be cancelled");
});

test("bots_in_registration_can_still_play_casual_matches", () => {
  const db = adminDb();
  teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  call(db, "Ann", (tx) => join_lobby(tx, {}));
  db.withReducerTx(asClaims("sim", "Cheapo-sim"), (tx) => join_lobby(tx, {}));
  expect(db.db.lobby_member.count()).toBe(2n);
});

// ---------- Leaving a team ----------

const leave = (db: Test, who: string) =>
  call(db, who, (tx) => leave_team(tx, {}));

/** Ann's tournament, started, with her own match played out. */
function underwayWithAnn(db: Test): [bigint, bigint] {
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  registerSims(db, t);
  start(db, t);
  for (const m of [...db.db.match_participant.mp_by_bot.filter(ann)]) {
    runToEnd(db, m.match_id);
  }
  return [t, ann];
}

test("a_team_with_a_bot_in_a_tournament_cannot_dissolve", () => {
  const db = adminDb();
  const [t, ann] = underwayWithAnn(db);
  call(db, "bob", (tx) => join_team(tx, { team_name: "Team Ann" }));

  leave(db, "bob"); // not the last member, so the team stays
  expect(failure(() => leave(db, "alice"))).toBe(
    "Your bot is still playing in a tournament; the last member can leave once it's knocked out or the tournament ends",
  );
  expect(db.db.bot.id.find(ann)).not.toBeNull();
  expect(entrants(db, t)).toContain(ann);
});

test("a_team_can_dissolve_once_its_bot_is_knocked_out", () => {
  const db = adminDb();
  const [t, ann] = underwayWithAnn(db);
  const e = [...db.db.tournament_entry.te_by_bot.filter(ann)][0]!;
  db.db.tournament_entry.id.update({ ...e, eliminated: true });

  leave(db, "alice");

  expect(db.db.bot.id.find(ann)).toBeNull();
  expect(entrants(db, t), "its entry stays on the record").toContain(ann);
});

test("dissolving_a_team_keeps_its_entries_in_finished_tournaments", () => {
  const db = adminDb();
  const [t, ann] = underwayWithAnn(db);
  const tour = db.db.tournament.id.find(t)!;
  db.db.tournament.id.update({ ...tour, status: { tag: "Ended" } });

  leave(db, "alice");

  expect(entrants(db, t)).toContain(ann);
});

test("dissolving_a_team_withdraws_its_bot_from_registration", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);

  leave(db, "alice");

  expect(entrants(db, t)).not.toContain(ann);
  expect(db.db.tournament_entry.count()).toBe(0n);
});
