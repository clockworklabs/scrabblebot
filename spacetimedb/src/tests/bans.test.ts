import { expect, test } from "vitest";
import {
  banBot,
  claimCredential,
  createTournament,
  joinLobby,
  mintCredentialNonce,
  registerForTournament,
  registerSimBots,
  startTournament,
  submitBid,
  submitWord,
  unbanBot,
} from "../index";
import {
  call,
  currentAuction,
  failure,
  makeAdmin,
  newDb,
  noncesFor,
  simIds,
  startMatch,
  teamWithBot,
  VICKREY,
  type Test,
} from "./harness";

function setup(): Test {
  const db = newDb();
  makeAdmin(db, "admin");
  return db;
}

function tournament(db: Test): bigint {
  call(db, "admin", (tx) =>
    createTournament(tx, {
      swissRoundsTotal: 1,
      topCut: 2,
      matchSize: 3,
      auctionType: VICKREY,
    }),
  );
  return [...db.db.tournament.iter()][0]!.id;
}

test("admin ban withdraws registration and blocks re-entry, even with existing credentials", () => {
  const db = setup();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournament(db);
  call(db, "Ann", (tx) => registerForTournament(tx, { tournamentId: t }));
  call(db, "Ann", (tx) => joinLobby(tx, {}));

  expect(failure(() => call(db, "alice", (tx) => banBot(tx, { botId: ann })))).toBe(
    "Admin only",
  );
  expect(db.db.tournamentEntry.count()).toBe(1n);
  call(db, "admin", (tx) => banBot(tx, { botId: ann }));

  expect(db.db.botBan.botId.find(ann)).not.toBeNull();
  expect(db.db.tournamentEntry.count()).toBe(0n);
  expect([...db.db.lobbyMember.lmByBot.filter(ann)]).toEqual([]);
  expect(
    failure(() =>
      call(db, "Ann", (tx) => registerForTournament(tx, { tournamentId: t })),
    ),
  ).toBe("This bot is banned");
  expect(failure(() => call(db, "Ann", (tx) => joinLobby(tx, {})))).toBe(
    "This bot is banned",
  );
  call(db, "alice", (tx) => mintCredentialNonce(tx, {}));
  const code = noncesFor(db, "alice").pop()!.code;
  call(db, "Ann-new", (tx) => claimCredential(tx, { code }));
  expect(
    failure(() =>
      call(db, "Ann-new", (tx) =>
        registerForTournament(tx, { tournamentId: t }),
      ),
    ),
  ).toBe("This bot is banned");

  expect(failure(() => call(db, "alice", (tx) => unbanBot(tx, { botId: ann })))).toBe(
    "Admin only",
  );
  call(db, "admin", (tx) => unbanBot(tx, { botId: ann }));
  expect(db.db.botBan.botId.find(ann)).toBeNull();
  expect(db.db.tournamentEntry.count(), "unban does not restore the entry").toBe(0n);
  call(db, "Ann", (tx) => registerForTournament(tx, { tournamentId: t }));
  expect(db.db.tournamentEntry.count()).toBe(1n);
});

test("ban removes pending bids and blocks actions in an already-running match", () => {
  const db = setup();
  const ann = teamWithBot(db, "alice", "Ann");
  const matchId = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);
  const auctionId = currentAuction(db, matchId).id;
  call(db, "Ann", (tx) => submitBid(tx, { auctionId, amount: 10n }));
  expect([...db.db.pendingBid.bidByAuction.filter(auctionId)].some((b) => b.bidderBotId === ann)).toBe(true);

  call(db, "admin", (tx) => banBot(tx, { botId: ann }));

  expect([...db.db.pendingBid.bidByAuction.filter(auctionId)].some((b) => b.bidderBotId === ann)).toBe(false);
  expect(failure(() => call(db, "Ann", (tx) => submitBid(tx, { auctionId, amount: 1n })))).toBe(
    "This bot is banned",
  );
  expect(failure(() => call(db, "Ann", (tx) => submitWord(tx, { matchId, word: "AT" })))).toBe(
    "This bot is banned",
  );
});

test("ban excludes simulated bots from tournament registration", () => {
  const db = setup();
  const sim = simIds(db)[0]!;
  const t = tournament(db);
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId: t }));
  call(db, "admin", (tx) => banBot(tx, { botId: sim }));
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId: t }));

  expect([...db.db.tournamentEntry.teByBot.filter(sim)]).toEqual([]);
  expect(failure(() => startMatch(db, VICKREY, [sim, simIds(db)[1]!]))).toBe(
    `Banned bot in roster: ${sim}`,
  );
});

test("ban refuses an active tournament entrant without changing its entry", () => {
  const db = setup();
  const ann = teamWithBot(db, "alice", "Ann");
  const t = tournament(db);
  call(db, "Ann", (tx) => registerForTournament(tx, { tournamentId: t }));
  call(db, "admin", (tx) => registerSimBots(tx, { tournamentId: t }));
  call(db, "admin", (tx) => startTournament(tx, { tournamentId: t }));

  expect(failure(() => call(db, "admin", (tx) => banBot(tx, { botId: ann })))).toBe(
    "Cannot ban an active tournament entrant",
  );
  expect(db.db.botBan.botId.find(ann)).toBeNull();
  expect([...db.db.tournamentEntry.teByBot.filter(ann)]).toHaveLength(1);
});
