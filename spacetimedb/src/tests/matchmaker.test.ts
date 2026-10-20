// Match defaults: the auction length, starting rack size and lobby size an
// admin can set, and which matches and lobbies they apply to.

import { TimeDuration } from "spacetimedb";
import { expect, test } from "vitest";
import { afterMillis } from "../game";
import { set_matchmaker_config } from "../index";
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
    set_matchmaker_config(tx, {
      starting_rack_size: rackSize,
      lobby_max_size: lobbySize,
      auction_duration_ms: auctionMs,
    }),
  );
}

function openLobby(db: Test) {
  return [...db.db.lobby.lobby_by_status.filter({ tag: "Open" })][0]!;
}

test("matches_use_the_built_in_defaults_until_an_admin_sets_some", () => {
  const db = adminDb();
  const m = startMatch(db, VICKREY, simIds(db).slice(0, 2));
  const match = getMatch(db, m);
  expect([match.auction_duration_ms, match.starting_rack_size]).toEqual([
    1000n,
    5,
  ]);
  expect(openLobby(db).max_size).toBe(6);
});

test("set_matchmaker_config_checks_its_values", () => {
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
  expect(db.db.matchmaker_config.count()).toBe(0n);
});

test("new_matches_take_the_new_defaults", () => {
  const db = adminDb();
  setDefaults(db, 3, 4, 2000n);
  setDefaults(db, 3, 4, 2500n); // saving again updates the one row
  expect(db.db.matchmaker_config.count()).toBe(1n);

  const sims = simIds(db).slice(0, 2);
  const m = startMatch(db, VICKREY, sims);

  const match = getMatch(db, m);
  expect([match.auction_duration_ms, match.starting_rack_size]).toEqual([
    2500n,
    3,
  ]);
  for (const bot of sims) {
    expect(rack(db, m, bot).reduce((n, [, count]) => n + count, 0)).toBe(3);
  }
  expect(currentAuction(db, m).closes_at).toEqual(afterMillis(now(), 2500n));
});

test("a_match_being_played_keeps_its_auction_length", () => {
  const db = adminDb();
  const m = startMatch(db, VICKREY, simIds(db).slice(0, 2));
  setDefaults(db, 5, 6, 4000n);

  db.clock.advance(new TimeDuration(1_000_000n));
  tick(db, m);

  expect(currentAuction(db, m).closes_at).toEqual(
    afterMillis(db.clock.now(), 1000n),
  );
});

test("the_open_lobby_keeps_its_size_and_the_next_one_takes_the_new_one", () => {
  const db = adminDb();
  const first = openLobby(db);
  setDefaults(db, 5, 4, 1000n);
  expect(openLobby(db).max_size).toBe(6);

  lobbyTimeout(db, first.id);

  const next = openLobby(db);
  expect(next.id).not.toBe(first.id);
  expect(next.max_size).toBe(4);
  const padded = [
    ...db.db.match_participant.mp_by_match.filter(
      db.db.lobby.id.find(first.id)!.resolved_match_id!,
    ),
  ];
  expect(padded.length, "the old lobby filled to its own size").toBe(6);
});
