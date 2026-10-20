// init, connection lifecycle, identity linking, admins and sim bots.

import { Identity, ScheduleAt, TimeDuration } from "spacetimedb";
import { expect, test } from "vitest";
import {
  LOBBY_DURATION_SECONDS,
  LOBBY_MAX_SIZE,
  SEED_ADMIN_HEX,
} from "../game";
import { identityFromClaims } from "../identity";
import {
  add_admin,
  backfill_elo,
  backfill_top_bid_archive,
  bootstrap_admin,
  client_connected,
  client_disconnected,
  connect_id,
  init,
  remove_admin,
  spawn_simulated_bot,
  start_tournament,
  create_tournament,
  cancel_tournament,
  register_sim_bots,
} from "../index";
import type { BotStrategy } from "../schema";
import {
  botNamed,
  call,
  emptyDb,
  failure,
  identity,
  internal,
  makeAdmin,
  newDb,
  now,
  plusMicros,
  simIds,
  teamWithBot,
} from "./harness";

test("init_seeds_admin_sim_bots_and_a_lobby", () => {
  const db = newDb();

  const seed = Identity.fromString(SEED_ADMIN_HEX[0]!);
  const admin = db.db.admin.human_identity.find(seed)!;
  expect(admin.added_by).toBeUndefined();

  expect(simIds(db).length).toBe(6);
  for (const bot of db.db.bot.iter()) {
    expect(bot.is_simulated).toBe(true);
    expect(bot.team_id).toBe(0n);
    const cred = db.db.bot_credential.identity.find(
      identityFromClaims("sim", bot.name),
    )!;
    expect(cred.bot_id).toBe(bot.id);
  }

  const lobbies = [...db.db.lobby.iter()];
  expect(lobbies.length).toBe(1);
  expect(lobbies[0]!.status.tag).toBe("Open");
  expect(lobbies[0]!.max_size).toBe(LOBBY_MAX_SIZE);
  expect(lobbies[0]!.closes_at).toEqual(
    plusMicros(now(), LOBBY_DURATION_SECONDS * 1_000_000n),
  );
  const timeout = [...db.db.lobby_timeout_schedule.iter()][0]!;
  expect(timeout.lobby_id).toBe(lobbies[0]!.id);
  expect(timeout.scheduled_at).toEqual(
    ScheduleAt.time(lobbies[0]!.closes_at.microsSinceUnixEpoch),
  );
});

test("init_is_idempotent", () => {
  const db = newDb();
  internal(db, (tx) => init(tx, {}));

  expect(db.db.admin.count()).toBe(1n);
  expect(db.db.bot.count()).toBe(6n);
  expect(db.db.bot_credential.count()).toBe(6n);
  expect(db.db.lobby.count()).toBe(1n);
});

test("connecting_and_disconnecting_tracks_bot_credentials", () => {
  const db = newDb();
  const botId = teamWithBot(db, "alice", "Robo");
  db.clock.advance(new TimeDuration(5_000_000n));

  call(db, "Robo", (tx) => client_disconnected(tx, {}));
  const cred = db.db.bot_credential.identity.find(identity("Robo"))!;
  expect(cred.bot_id).toBe(botId);
  expect(cred.connected).toBe(false);
  expect(cred.last_seen).toEqual(db.clock.now());

  call(db, "Robo", (tx) => client_connected(tx, {}));
  expect(db.db.bot_credential.identity.find(identity("Robo"))!.connected).toBe(
    true,
  );
});

test("connecting_without_a_credential_writes_nothing", () => {
  const db = newDb();
  const before = db.db.bot_credential.count();
  call(db, "stranger", (tx) => client_connected(tx, {}));
  expect(db.db.bot_credential.count()).toBe(before);
});

test("connect_id_links_a_web_identity_to_the_caller", () => {
  const db = newDb();
  call(db, "alice", (tx) =>
    connect_id(tx, { web_identity: identity("alice-browser") }),
  );

  const link = db.db.human_link.web_identity.find(identity("alice-browser"))!;
  expect(link.human_identity).toEqual(identity("alice"));

  // Linking again is a no-op.
  call(db, "alice", (tx) =>
    connect_id(tx, { web_identity: identity("alice-browser") }),
  );
  expect(db.db.human_link.count()).toBe(1n);
});

test("connect_id_refuses_self_links_and_stealing", () => {
  const db = newDb();
  let err = failure(() =>
    call(db, "alice", (tx) =>
      connect_id(tx, { web_identity: identity("alice") }),
    ),
  );
  expect(err).toContain("same as your identity");

  call(db, "alice", (tx) =>
    connect_id(tx, { web_identity: identity("browser") }),
  );
  err = failure(() =>
    call(db, "mallory", (tx) =>
      connect_id(tx, { web_identity: identity("browser") }),
    ),
  );
  expect(err).toContain("already linked");
  expect(
    db.db.human_link.web_identity.find(identity("browser"))!.human_identity,
  ).toEqual(identity("alice"));
});

test("bootstrap_admin_only_works_on_an_empty_admin_table", () => {
  const db = emptyDb();
  call(db, "alice", (tx) => bootstrap_admin(tx, {}));
  expect(db.db.admin.human_identity.find(identity("alice"))).not.toBeNull();

  const err = failure(() => call(db, "bob", (tx) => bootstrap_admin(tx, {})));
  expect(err).toContain("Admins already exist");
  expect(db.db.admin.count()).toBe(1n);
});

test("bootstrap_admin_resolves_a_linked_browser_to_its_human", () => {
  const db = emptyDb();
  call(db, "alice", (tx) =>
    connect_id(tx, { web_identity: identity("browser") }),
  );
  call(db, "browser", (tx) => bootstrap_admin(tx, {}));
  expect(db.db.admin.human_identity.find(identity("alice"))).not.toBeNull();
  expect(db.db.admin.human_identity.find(identity("browser"))).toBeNull();
});

test("admins_can_add_and_remove_admins", () => {
  const db = newDb();
  makeAdmin(db, "alice");

  call(db, "alice", (tx) => add_admin(tx, { human_identity: identity("bob") }));
  const bob = db.db.admin.human_identity.find(identity("bob"))!;
  expect(bob.added_by).toEqual(identity("alice"));

  let err = failure(() =>
    call(db, "alice", (tx) =>
      add_admin(tx, { human_identity: identity("bob") }),
    ),
  );
  expect(err).toBe("Already an admin");

  call(db, "bob", (tx) =>
    remove_admin(tx, { human_identity: identity("alice") }),
  );
  expect(db.db.admin.human_identity.find(identity("alice"))).toBeNull();

  err = failure(() =>
    call(db, "bob", (tx) =>
      remove_admin(tx, { human_identity: identity("nobody") }),
    ),
  );
  expect(err).toBe("Not an admin");
});

test("admins_cannot_remove_themselves", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  const err = failure(() =>
    call(db, "alice", (tx) =>
      remove_admin(tx, { human_identity: identity("alice") }),
    ),
  );
  expect(err).toBe("You can't remove yourself");
});

test("admin_reducers_reject_non_admins", () => {
  const db = newDb();
  const eve = (body: Parameters<typeof call>[2]) =>
    failure(() => call(db, "eve", body));
  const checks: [string, string][] = [
    [
      "add_admin",
      eve((tx) => add_admin(tx, { human_identity: identity("eve") })),
    ],
    [
      "remove_admin",
      eve((tx) =>
        remove_admin(tx, {
          human_identity: Identity.fromString(SEED_ADMIN_HEX[0]!),
        }),
      ),
    ],
    [
      "spawn_simulated_bot",
      eve((tx) =>
        spawn_simulated_bot(tx, {
          name: "Evil",
          strategy: { tag: "Aggressive" },
        }),
      ),
    ],
    [
      "create_tournament",
      eve((tx) =>
        create_tournament(tx, {
          swiss_rounds_total: 1,
          top_cut: 2,
          match_size: 2,
          auction_type: { tag: "Vickrey" },
        }),
      ),
    ],
    [
      "start_tournament",
      eve((tx) => start_tournament(tx, { tournament_id: 1n })),
    ],
    [
      "cancel_tournament",
      eve((tx) => cancel_tournament(tx, { tournament_id: 1n })),
    ],
    [
      "register_sim_bots",
      eve((tx) => register_sim_bots(tx, { tournament_id: 1n })),
    ],
    ["backfill_elo", eve((tx) => backfill_elo(tx, {}))],
    [
      "backfill_top_bid_archive",
      eve((tx) => backfill_top_bid_archive(tx, { max_rows: 10 })),
    ],
  ];
  for (const [name, err] of checks) {
    expect(err, name).toBe("Admin only");
  }
  expect(db.db.admin.count()).toBe(1n);
  expect(db.db.bot.count()).toBe(6n);
  expect(db.db.tournament.count()).toBe(0n);
});

test("a_linked_browser_acts_with_its_humans_admin_rights", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  call(db, "alice", (tx) =>
    connect_id(tx, { web_identity: identity("browser") }),
  );

  call(db, "browser", (tx) =>
    add_admin(tx, { human_identity: identity("bob") }),
  );
  const bob = db.db.admin.human_identity.find(identity("bob"))!;
  expect(bob.added_by).toEqual(identity("alice"));
});

test("spawn_simulated_bot_creates_a_bot_with_a_sim_credential", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  call(db, "alice", (tx) =>
    spawn_simulated_bot(tx, {
      name: "  Zed-sim  ",
      strategy: { tag: "Cheapskate" },
    }),
  );

  const bot = botNamed(db, "Zed-sim");
  expect(bot.is_simulated).toBe(true);
  expect(bot.strategy.tag).toBe("Cheapskate");
  const cred = db.db.bot_credential.identity.find(
    identityFromClaims("sim", "Zed-sim"),
  )!;
  expect(cred.bot_id).toBe(bot.id);
});

test("spawn_simulated_bot_validates_its_input", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  const spawn = (name: string, strategy: BotStrategy) =>
    failure(() =>
      call(db, "alice", (tx) => spawn_simulated_bot(tx, { name, strategy })),
    );
  expect(spawn("   ", { tag: "Cheapskate" })).toContain("1-32");
  expect(spawn("x".repeat(33), { tag: "Cheapskate" })).toContain("1-32");
  expect(spawn("Human-sim", { tag: "Human" })).toContain("Human strategy");
  expect(spawn("Cheapo-sim", { tag: "Cheapskate" })).toBe("Name already taken");
  expect(db.db.bot.count()).toBe(6n);
});
