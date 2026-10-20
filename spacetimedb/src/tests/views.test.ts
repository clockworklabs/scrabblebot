// Per-caller views: what each identity is allowed to see.

import { TestAuth } from "spacetimedb/server/test-utils";
import { expect, test } from "vitest";
import { STARTING_RACK_SIZE } from "../game";
import {
  claim_credential,
  connect_id,
  join_team,
  mint_credential_nonce,
  my_admin,
  my_nonces,
  my_rack,
  my_team,
  submit_bid,
  visible_auction_top_bids,
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

test("my_rack_shows_only_the_callers_tiles_across_matches", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  const m1 = startMatch(db, VICKREY, [ann, ben]);
  const m2 = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);

  const tiles = my_rack(view(db, "Ann"));
  expect(tiles.every((h) => h.bot_id === ann)).toBe(true);
  const total = tiles.reduce((sum, h) => sum + h.count, 0);
  expect(total).toBe(2 * STARTING_RACK_SIZE);
  expect(tiles.some((h) => h.match_id === m1)).toBe(true);
  expect(tiles.some((h) => h.match_id === m2)).toBe(true);

  expect(my_rack(view(db, "alice")), "the human isn't the bot").toEqual([]);
  expect(my_rack(db.viewContext(TestAuth.internal()))).toEqual([]);
});

test("my_team_summarises_the_callers_team", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  call(db, "bob", (tx) => join_team(tx, { team_name: "Team Ann" }));
  call(db, "alice", (tx) => mint_credential_nonce(tx, {}));
  const code = noncesFor(db, "alice")[0]!.code;
  call(db, "ann-2", (tx) => claim_credential(tx, { code }));

  const t = my_team(view(db, "alice"))!;
  expect([t.team_name, t.bot_id, t.bot_name]).toEqual(["Team Ann", ann, "Ann"]);
  expect(t.role.tag).toBe("Owner");
  expect(t.credential_count).toBe(2);

  expect(my_team(view(db, "bob"))!.role.tag).toBe("Member");
  expect(my_team(view(db, "stranger"))).toBeUndefined();
});

test("views_resolve_a_linked_browser_to_its_human", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Ann");
  makeAdmin(db, "alice");
  call(db, "alice", (tx) => mint_credential_nonce(tx, {}));
  call(db, "alice", (tx) =>
    connect_id(tx, { web_identity: identity("browser") }),
  );

  const v = view(db, "browser");
  expect(my_team(v)!.bot_name).toBe("Ann");
  expect(my_nonces(v).length).toBe(1);
  expect(my_admin(v)!.human_identity).toEqual(identity("alice"));
});

test("my_nonces_only_shows_the_callers_own", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Ann");
  call(db, "bob", (tx) => join_team(tx, { team_name: "Team Ann" }));
  call(db, "alice", (tx) => mint_credential_nonce(tx, {}));
  call(db, "bob", (tx) => mint_credential_nonce(tx, {}));
  call(db, "bob", (tx) => mint_credential_nonce(tx, {}));

  expect(my_nonces(view(db, "alice")).length).toBe(1);
  expect(my_nonces(view(db, "bob")).length).toBe(2);
  expect(my_nonces(view(db, "stranger"))).toEqual([]);
});

test("my_admin_is_only_set_for_admins", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  expect(my_admin(view(db, "alice"))).toBeDefined();
  expect(my_admin(view(db, "bob"))).toBeUndefined();
});

test("live_top_bids_are_hidden_from_bots", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const m = startMatch(db, VICKREY, [ann, simIds(db)[0]!]);
  tick(db, m);
  tick(db, m);

  const spectator = visible_auction_top_bids(view(db, "spectator"));
  expect(spectator.length).toBe(2);
  expect(spectator.every((t) => t.match_id === m)).toBe(true);

  expect(visible_auction_top_bids(view(db, "Ann"))).toEqual([]);
  const sim = db.viewContext(asClaims("sim", "Cheapo-sim"));
  expect(visible_auction_top_bids(sim)).toEqual([]);
});

test("finished_matches_drop_out_of_the_live_top_bids", () => {
  const db = newDb();
  const sims = simIds(db);
  const finished = startMatch(db, VICKREY, sims.slice(0, 2));
  runToEnd(db, finished);
  const live = startMatch(db, VICKREY, sims.slice(2, 4));
  tick(db, live);

  const bids = visible_auction_top_bids(view(db, "spectator"));
  expect(bids.length).toBe(1);
  expect(bids[0]!.match_id).toBe(live);
});

// TODO.md: AuctionResult is public, and its `paid` exposes the runner-up's bid
// under Vickrey. That's by design; this pins down that `top_bid` itself is
// not in the public result table.
test("auction_results_do_not_reveal_the_top_bid", () => {
  const db = newDb();
  const ann = teamWithBot(db, "alice", "Ann");
  const ben = teamWithBot(db, "bob", "Ben");
  const m = startMatch(db, VICKREY, [ann, ben]);
  const a = currentAuction(db, m).id;
  call(db, "Ann", (tx) => submit_bid(tx, { auction_id: a, amount: 40n }));
  call(db, "Ben", (tx) => submit_bid(tx, { auction_id: a, amount: 3n }));
  tick(db, m);

  const r = db.db.auction_result.auction_id.find(a)!;
  expect(r.paid).toBe(3n);
  expect(db.db.auction_top_bid.auction_id.find(a)!.top_bid).toBe(40n);
});
