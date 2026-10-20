// Tournament registration: creating a tournament, bots signing up from
// their own processes, and the checks made when the admin starts it.

import { expect, test } from "vitest";
import {
  cancel_tournament,
  create_tournament,
  join_lobby,
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

test("starting_waits_for_entrants_in_running_matches", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  registerSims(db, t);
  startMatch(db, VICKREY, [ann, simIds(db)[0]!]);

  expect(failure(() => start(db, t))).toBe(
    "Waiting for these entrants to finish their matches: Ann",
  );
  expect(db.db.tournament.id.find(t)!.status.tag).toBe("Registration");
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
