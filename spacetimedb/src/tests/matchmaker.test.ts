// Match defaults: the auction length, starting rack size and lobby size an
// admin can set, and which matches and lobbies they apply to.

import { TimeDuration } from "spacetimedb";
import { expect, test } from "vitest";
import { afterMillis } from "../game";
import { setMatchmakerConfig } from "../index";
import {
  call,
  currentAuction,
  failure,
  getMatch,
  lobbyTimeout,
  makeAdmin,
  newDb,
  now,
  rack,
  simIds,
  startMatch,
  tick,
  VICKREY,
  type Test,
} from "./harness";

function adminDb(): Test {
  const db = newDb();
  makeAdmin(db, "admin");
  return db;
}

function setDefaults(
  db: Test,
  rackSize: number,
  lobbySize: number,
  auctionMs: bigint,
  who = "admin",
) {
  call(db, who, (tx) =>
    setMatchmakerConfig(tx, {
      startingRackSize: rackSize,
      lobbyMaxSize: lobbySize,
      auctionDurationMs: auctionMs,
    }),
  );
}

function openLobby(db: Test) {
  return [...db.db.lobby.lobbyByStatus.filter({ tag: "Open" })][0]!;
}

test("matches use the built in defaults until an admin sets some", () => {
  const db = adminDb();
  const m = startMatch(db, VICKREY, simIds(db).slice(0, 2));
  const match = getMatch(db, m);
  expect([match.auctionDurationMs, match.startingRackSize]).toEqual([1000n, 5]);
  expect(openLobby(db).maxSize).toBe(6);
});

test("set matchmaker config checks its values", () => {
  const db = adminDb();
  const refused = (r: number, l: number, a: bigint, who = "admin") =>
    failure(() => setDefaults(db, r, l, a, who));
  expect(refused(5, 6, 1000n, "stranger")).toBe("Admin only");
  expect(refused(21, 6, 1000n)).toBe("Starting rack size must be 0-20");
  expect(refused(5, 1, 1000n)).toBe("Lobby size must be 2-12");
  expect(refused(5, 13, 1000n)).toBe("Lobby size must be 2-12");
  expect(refused(5, 6, 249n)).toBe("Auction length must be 250-10000 ms");
  expect(refused(5, 6, 10_001n)).toBe("Auction length must be 250-10000 ms");
  expect(refused(9, 11, 1000n)).toBe(
    "A full lobby would be dealt more tiles than the bag's 98",
  );
  expect(db.db.matchmakerConfig.count()).toBe(0n);
});

test("new matches take the new defaults", () => {
  const db = adminDb();
  setDefaults(db, 3, 4, 2000n);
  setDefaults(db, 3, 4, 2500n); // saving again updates the one row
  expect(db.db.matchmakerConfig.count()).toBe(1n);

  const sims = simIds(db).slice(0, 2);
  const m = startMatch(db, VICKREY, sims);

  const match = getMatch(db, m);
  expect([match.auctionDurationMs, match.startingRackSize]).toEqual([2500n, 3]);
  for (const bot of sims) {
    expect(rack(db, m, bot).reduce((n, [, count]) => n + count, 0)).toBe(3);
  }
  expect(currentAuction(db, m).closesAt).toEqual(afterMillis(now(), 2500n));
});

test("a match being played keeps its auction length", () => {
  const db = adminDb();
  const m = startMatch(db, VICKREY, simIds(db).slice(0, 2));
  setDefaults(db, 5, 6, 4000n);

  db.clock.advance(new TimeDuration(1_000_000n));
  tick(db, m);

  expect(currentAuction(db, m).closesAt).toEqual(
    afterMillis(db.clock.now(), 1000n),
  );
});

test("the open lobby keeps its size and the next one takes the new one", () => {
  const db = adminDb();
  const first = openLobby(db);
  setDefaults(db, 5, 4, 1000n);
  expect(openLobby(db).maxSize).toBe(6);

  lobbyTimeout(db, first.id);

  const next = openLobby(db);
  expect(next.id).not.toBe(first.id);
  expect(next.maxSize).toBe(4);
  const padded = [
    ...db.db.matchParticipant.mpByMatch.filter(
      db.db.lobby.id.find(first.id)!.resolvedMatchId!,
    ),
  ];
  expect(padded.length, "the old lobby filled to its own size").toBe(6);
});
