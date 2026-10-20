// Tournament registration: creating a tournament, bots signing up from
// their own processes, and the checks made when the admin starts it.

import { expect, test } from "vitest";
import {
  cancelTournament,
  createTournament,
  joinLobby,
  joinTeam,
  leaveTeam,
  registerForTournament,
  registerSimBots,
  startTournament,
  unregisterFromTournament,
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
    createTournament(tx, {
      swissRoundsTotal: 1,
      topCut: 2,
      matchSize: matchSize,
      auctionType: { tag: "Vickrey" },
    }),
  );
  return [...db.db.tournament.iter()]
    .map((t) => t.id)
    .reduce((a, b) => (a > b ? a : b));
}

const register = (db: Test, who: string, tournamentId: bigint) =>
  call(db, who, (tx) => registerForTournament(tx, { tournamentId }));
const unregister = (db: Test, who: string, tournamentId: bigint) =>
  call(db, who, (tx) => unregisterFromTournament(tx, { tournamentId }));
const start = (db: Test, tournamentId: bigint) =>
  call(db, "admin", (tx) => startTournament(tx, { tournamentId }));
const registerSims = (db: Test, tournamentId: bigint) =>
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId }));

function entrants(db: Test, t: bigint): bigint[] {
  return [...db.db.tournamentEntry.teByTournament.filter(t)]
    .map((e: TournamentEntry) => e.botId)
    .sort(byBigint);
}

test("a new tournament opens for registration", () => {
  const db = adminDb();
  const t = create(db);
  const tour = db.db.tournament.id.find(t)!;
  expect(tour.status.tag).toBe("Registration");
  expect(entrants(db, t)).toEqual([]);
  expect(db.db.matchState.count(), "nothing starts yet").toBe(0n);
});

test("only one tournament can be active", () => {
  const db = adminDb();
  const t = create(db);
  expect(failure(() => create(db))).toBe(
    "Another tournament is already in progress",
  );
  call(db, "admin", (tx) => cancelTournament(tx, { tournamentId: t }));
  create(db);
});

test("bots register and unregister themselves", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);

  register(db, "Ann", t);
  register(db, "Ann", t); // idempotent
  expect(entrants(db, t)).toEqual([ann]);

  unregister(db, "Ann", t);
  expect(entrants(db, t)).toEqual([]);
});

test("only a bots own credential can register it", () => {
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

test("registration closes when the tournament starts", () => {
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

test("register sim bots enters each sim once", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  registerSims(db, t);
  expect(entrants(db, t)).toEqual(simIds(db));
});

test("starting moves to swiss and plays round one", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  start(db, t);

  const tour = db.db.tournament.id.find(t)!;
  expect([tour.status.tag, tour.currentRound]).toEqual(["Swiss", 1]);
  expect(db.db.tournamentMatch.count()).toBe(2n);
  expect(failure(() => start(db, t))).toBe("Tournament has already started");
});

test("starting drops entrants whose bot is gone", () => {
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
test("round one waits for entrants in running matches", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  registerSims(db, t);
  const casual = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);

  start(db, t);

  const tour = db.db.tournament.id.find(t)!;
  expect([tour.status.tag, tour.currentRound]).toEqual(["Swiss", 0]);
  expect(db.db.tournamentMatch.count()).toBe(0n);

  runToEnd(db, casual);

  expect(db.db.tournament.id.find(t)!.currentRound).toBe(1);
  const seated = [...db.db.tournamentMatch.tmByTournament.filter(t)]
    .flatMap((tm) => [...db.db.matchParticipant.mpByMatch.filter(tm.matchId)])
    .map((p) => p.botId);
  expect(seated).toContain(ann);
});

test("sim entrants in running matches do not hold up the start", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  startMatch(db, VICKREY, simIds(db).slice(0, 2));

  start(db, t);

  expect(db.db.tournament.id.find(t)!.status.tag).toBe("Swiss");
});

test("cancelling removes a tournament that has not started", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);

  call(db, "admin", (tx) => cancelTournament(tx, { tournamentId: t }));

  expect(db.db.tournament.count()).toBe(0n);
  expect(db.db.tournamentEntry.count()).toBe(0n);
});

test("a started tournament cannot be cancelled", () => {
  const db = adminDb();
  const t = create(db);
  registerSims(db, t);
  start(db, t);
  expect(
    failure(() =>
      call(db, "admin", (tx) => cancelTournament(tx, { tournamentId: t })),
    ),
  ).toBe("Only a tournament that hasn't started can be cancelled");
});

test("bots in registration can still play casual matches", () => {
  const db = adminDb();
  teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  call(db, "Ann", (tx) => joinLobby(tx, {}));
  db.withReducerTx(asClaims("sim", "Cheapo-sim"), (tx) => joinLobby(tx, {}));
  expect(db.db.lobbyMember.count()).toBe(2n);
});

// ---------- Leaving a team ----------

const leave = (db: Test, who: string) =>
  call(db, who, (tx) => leaveTeam(tx, {}));

/** Ann's tournament, started, with her own match played out. */
function underwayWithAnn(db: Test): [bigint, bigint] {
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);
  registerSims(db, t);
  start(db, t);
  for (const m of [...db.db.matchParticipant.mpByBot.filter(ann)]) {
    runToEnd(db, m.matchId);
  }
  return [t, ann];
}

test("a team with a bot in a tournament cannot dissolve", () => {
  const db = adminDb();
  const [t, ann] = underwayWithAnn(db);
  call(db, "bob", (tx) => joinTeam(tx, { teamName: "Team Ann" }));

  leave(db, "bob"); // not the last member, so the team stays
  expect(failure(() => leave(db, "alice"))).toBe(
    "Your bot is still playing in a tournament; the last member can leave once it's knocked out or the tournament ends",
  );
  expect(db.db.bot.id.find(ann)).not.toBeNull();
  expect(entrants(db, t)).toContain(ann);
});

test("a team can dissolve once its bot is knocked out", () => {
  const db = adminDb();
  const [t, ann] = underwayWithAnn(db);
  const e = [...db.db.tournamentEntry.teByBot.filter(ann)][0]!;
  db.db.tournamentEntry.id.update({ ...e, eliminated: true });

  leave(db, "alice");

  expect(db.db.bot.id.find(ann)).toBeNull();
  expect(entrants(db, t), "its entry stays on the record").toContain(ann);
});

test("dissolving a team keeps its entries in finished tournaments", () => {
  const db = adminDb();
  const [t, ann] = underwayWithAnn(db);
  const tour = db.db.tournament.id.find(t)!;
  db.db.tournament.id.update({ ...tour, status: { tag: "Ended" } });

  leave(db, "alice");

  expect(entrants(db, t)).toContain(ann);
});

test("dissolving a team withdraws its bot from registration", () => {
  const db = adminDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = create(db);
  register(db, "Ann", t);

  leave(db, "alice");

  expect(entrants(db, t)).not.toContain(ann);
  expect(db.db.tournamentEntry.count()).toBe(0n);
});
