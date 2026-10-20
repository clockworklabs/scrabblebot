// Per-caller views: what each identity is allowed to see.

import { TestAuth } from "spacetimedb/server/test-utils";
import { expect, test } from "vitest";
import { STARTING_RACK_SIZE } from "../game";
import {
  claimCredential,
  connectId,
  joinTeam,
  mintCredentialNonce,
  myAdmin,
  myNonces,
  myRack,
  myTeam,
  submitBid,
  visibleAuctionTopBids,
} from "../index";
import {
  asClaims,
  call,
  client,
  currentAuction,
  identity,
  makeAdmin,
  newDb,
  noncesFor,
  runToEnd,
  simIds,
  startMatch,
  teamWithBot,
  tick,
  VICKREY,
  type Test,
} from "./harness";

function view(db: Test, subject: string) {
  return db.viewContext(client(subject));
}

test("my rack shows only the callers tiles across matches", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  const m1 = startMatch(db, VICKREY, [ann, ben]);
  const m2 = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);

  const tiles = myRack(view(db, "Ann"));
  expect(tiles.every((h) => h.botId === ann)).toBe(true);
  const total = tiles.reduce((sum, h) => sum + h.count, 0);
  expect(total).toBe(2 * STARTING_RACK_SIZE);
  expect(tiles.some((h) => h.matchId === m1)).toBe(true);
  expect(tiles.some((h) => h.matchId === m2)).toBe(true);

  expect(myRack(view(db, "alice")), "the human isn't the bot").toEqual([]);
  expect(myRack(db.viewContext(TestAuth.internal()))).toEqual([]);
});

test("my team summarises the callers team", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  call(db, "bob", (tx) => joinTeam(tx, { teamName: "Team Ann" }));
  call(db, "alice", (tx) => mintCredentialNonce(tx, {}));
  const code = noncesFor(db, "alice")[0]!.code;
  call(db, "ann-2", (tx) => claimCredential(tx, { code }));

  const t = myTeam(view(db, "alice"))!;
  expect([t.teamName, t.botId, t.botName]).toEqual(["Team Ann", ann, "Ann"]);
  expect(t.role.tag).toBe("Owner");
  expect(t.credentialCount).toBe(2);

  expect(myTeam(view(db, "bob"))!.role.tag).toBe("Member");
  expect(myTeam(view(db, "stranger"))).toBeUndefined();
});

test("views resolve a linked browser to its human", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Ann");
  makeAdmin(db, "alice");
  call(db, "alice", (tx) => mintCredentialNonce(tx, {}));
  call(db, "alice", (tx) =>
    connectId(tx, { webIdentity: identity("browser") }),
  );

  const v = view(db, "browser");
  expect(myTeam(v)!.botName).toBe("Ann");
  expect(myNonces(v).length).toBe(1);
  expect(myAdmin(v)!.humanIdentity).toEqual(identity("alice"));
});

test("my nonces only shows the callers own", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Ann");
  call(db, "bob", (tx) => joinTeam(tx, { teamName: "Team Ann" }));
  call(db, "alice", (tx) => mintCredentialNonce(tx, {}));
  call(db, "bob", (tx) => mintCredentialNonce(tx, {}));
  call(db, "bob", (tx) => mintCredentialNonce(tx, {}));

  expect(myNonces(view(db, "alice")).length).toBe(1);
  expect(myNonces(view(db, "bob")).length).toBe(2);
  expect(myNonces(view(db, "stranger"))).toEqual([]);
});

test("my admin is only set for admins", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  expect(myAdmin(view(db, "alice"))).toBeDefined();
  expect(myAdmin(view(db, "bob"))).toBeUndefined();
});

test("live top bids are hidden from bots", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const m = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);
  tick(db, m);
  tick(db, m);

  const spectator = visibleAuctionTopBids(view(db, "spectator"));
  expect(spectator.length).toBe(2);
  expect(spectator.every((t) => t.matchId === m)).toBe(true);

  expect(visibleAuctionTopBids(view(db, "Ann"))).toEqual([]);
  const sim = db.viewContext(asClaims("sim", "Cheapo-sim"));
  expect(visibleAuctionTopBids(sim)).toEqual([]);
});

test("finished matches drop out of the live top bids", () => {
  const db = newDb();
  const sims = simIds(db);
  const finished = startMatch(db, VICKREY, sims.slice(0, 2));
  runToEnd(db, finished);
  const live = startMatch(db, VICKREY, sims.slice(2, 4));
  tick(db, live);

  const bids = visibleAuctionTopBids(view(db, "spectator"));
  expect(bids.length).toBe(1);
  expect(bids[0]!.matchId).toBe(live);
});

// TODO.md: AuctionResult is public, and its `paid` exposes the runner-up's bid
// under Vickrey. That's by design; this pins down that `topBid` itself is
// not in the public result table.
test("auction results do not reveal the top bid", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;
  call(db, "Ann", (tx) => submitBid(tx, { auctionId: a, amount: 40n }));
  call(db, "Ben", (tx) => submitBid(tx, { auctionId: a, amount: 3n }));
  tick(db, m);

  const r = db.db.auctionResult.auctionId.find(a)!;
  expect(r.paid).toBe(3n);
  expect(db.db.auctionTopBid.auctionId.find(a)!.topBid).toBe(40n);
});
