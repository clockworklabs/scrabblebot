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
  addAdmin,
  backfillElo,
  backfillTopBidArchive,
  bootstrapAdmin,
  clientConnected,
  clientDisconnected,
  connectId,
  init,
  removeAdmin,
  spawnSimulatedBot,
  startTournament,
  createTournament,
  cancelTournament,
  registerSimBots,
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

test("init seeds admin sim bots and a lobby", () => {
  const db = newDb();

  const seed = Identity.fromString(SEED_ADMIN_HEX[0]!);
  const admin = db.db.admin.humanIdentity.find(seed)!;
  expect(admin.addedBy).toBeUndefined();

  expect(simIds(db).length).toBe(6);
  for (const bot of db.db.bot.iter()) {
    expect(bot.isSimulated).toBe(true);
    expect(bot.teamId).toBe(0n);
    const cred = db.db.botCredential.identity.find(
      identityFromClaims("sim", bot.name),
    )!;
    expect(cred.botId).toBe(bot.id);
  }

  const lobbies = [...db.db.lobby.iter()];
  expect(lobbies.length).toBe(1);
  expect(lobbies[0]!.status.tag).toBe("Open");
  expect(lobbies[0]!.maxSize).toBe(LOBBY_MAX_SIZE);
  expect(lobbies[0]!.closesAt).toEqual(
    plusMicros(now(), LOBBY_DURATION_SECONDS * 1_000_000n),
  );
  const timeout = [...db.db.lobbyTimeoutSchedule.iter()][0]!;
  expect(timeout.lobbyId).toBe(lobbies[0]!.id);
  expect(timeout.scheduledAt).toEqual(
    ScheduleAt.time(lobbies[0]!.closesAt.microsSinceUnixEpoch),
  );
});

test("init is idempotent", () => {
  const db = newDb();
  internal(db, (tx) => init(tx, {}));

  expect(db.db.admin.count()).toBe(1n);
  expect(db.db.bot.count()).toBe(6n);
  expect(db.db.botCredential.count()).toBe(6n);
  expect(db.db.lobby.count()).toBe(1n);
});

test("connecting and disconnecting tracks bot credentials", () => {
  const db = newDb();
  const botId = teamWithBot(db, "alice", "Robo");
  db.clock.advance(new TimeDuration(5_000_000n));

  call(db, "Robo", (tx) => clientDisconnected(tx, {}));
  const cred = db.db.botCredential.identity.find(identity("Robo"))!;
  expect(cred.botId).toBe(botId);
  expect(cred.connected).toBe(false);
  expect(cred.lastSeen).toEqual(db.clock.now());

  call(db, "Robo", (tx) => clientConnected(tx, {}));
  expect(db.db.botCredential.identity.find(identity("Robo"))!.connected).toBe(
    true,
  );
});

test("connecting without a credential writes nothing", () => {
  const db = newDb();
  const before = db.db.botCredential.count();
  call(db, "stranger", (tx) => clientConnected(tx, {}));
  expect(db.db.botCredential.count()).toBe(before);
});

test("connect id links a web identity to the caller", () => {
  const db = newDb();
  call(db, "alice", (tx) =>
    connectId(tx, { webIdentity: identity("alice-browser") }),
  );

  const link = db.db.humanLink.webIdentity.find(identity("alice-browser"))!;
  expect(link.humanIdentity).toEqual(identity("alice"));

  // Linking again is a no-op.
  call(db, "alice", (tx) =>
    connectId(tx, { webIdentity: identity("alice-browser") }),
  );
  expect(db.db.humanLink.count()).toBe(1n);
});

test("connect id refuses self links and stealing", () => {
  const db = newDb();
  let err = failure(() =>
    call(db, "alice", (tx) =>
      connectId(tx, { webIdentity: identity("alice") }),
    ),
  );
  expect(err).toContain("same as your identity");

  call(db, "alice", (tx) =>
    connectId(tx, { webIdentity: identity("browser") }),
  );
  err = failure(() =>
    call(db, "mallory", (tx) =>
      connectId(tx, { webIdentity: identity("browser") }),
    ),
  );
  expect(err).toContain("already linked");
  expect(
    db.db.humanLink.webIdentity.find(identity("browser"))!.humanIdentity,
  ).toEqual(identity("alice"));
});

test("bootstrap admin only works on an empty admin table", () => {
  const db = emptyDb();
  call(db, "alice", (tx) => bootstrapAdmin(tx, {}));
  expect(db.db.admin.humanIdentity.find(identity("alice"))).not.toBeNull();

  const err = failure(() => call(db, "bob", (tx) => bootstrapAdmin(tx, {})));
  expect(err).toContain("Admins already exist");
  expect(db.db.admin.count()).toBe(1n);
});

test("bootstrap admin resolves a linked browser to its human", () => {
  const db = emptyDb();
  call(db, "alice", (tx) =>
    connectId(tx, { webIdentity: identity("browser") }),
  );
  call(db, "browser", (tx) => bootstrapAdmin(tx, {}));
  expect(db.db.admin.humanIdentity.find(identity("alice"))).not.toBeNull();
  expect(db.db.admin.humanIdentity.find(identity("browser"))).toBeNull();
});

test("admins can add and remove admins", () => {
  const db = newDb();
  makeAdmin(db, "alice");

  call(db, "alice", (tx) => addAdmin(tx, { humanIdentity: identity("bob") }));
  const bob = db.db.admin.humanIdentity.find(identity("bob"))!;
  expect(bob.addedBy).toEqual(identity("alice"));

  let err = failure(() =>
    call(db, "alice", (tx) => addAdmin(tx, { humanIdentity: identity("bob") })),
  );
  expect(err).toBe("Already an admin");

  call(db, "bob", (tx) =>
    removeAdmin(tx, { humanIdentity: identity("alice") }),
  );
  expect(db.db.admin.humanIdentity.find(identity("alice"))).toBeNull();

  err = failure(() =>
    call(db, "bob", (tx) =>
      removeAdmin(tx, { humanIdentity: identity("nobody") }),
    ),
  );
  expect(err).toBe("Not an admin");
});

test("admins cannot remove themselves", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  const err = failure(() =>
    call(db, "alice", (tx) =>
      removeAdmin(tx, { humanIdentity: identity("alice") }),
    ),
  );
  expect(err).toBe("You can't remove yourself");
});

test("admin reducers reject non admins", () => {
  const db = newDb();
  const eve = (body: Parameters<typeof call>[2]) =>
    failure(() => call(db, "eve", body));
  const checks: [string, string][] = [
    ["addAdmin", eve((tx) => addAdmin(tx, { humanIdentity: identity("eve") }))],
    [
      "removeAdmin",
      eve((tx) =>
        removeAdmin(tx, {
          humanIdentity: Identity.fromString(SEED_ADMIN_HEX[0]!),
        }),
      ),
    ],
    [
      "spawnSimulatedBot",
      eve((tx) =>
        spawnSimulatedBot(tx, {
          name: "Evil",
          strategy: { tag: "Aggressive" },
        }),
      ),
    ],
    [
      "createTournament",
      eve((tx) =>
        createTournament(tx, {
          swissRoundsTotal: 1,
          topCut: 2,
          matchSize: 2,
          auctionType: { tag: "Vickrey" },
        }),
      ),
    ],
    ["startTournament", eve((tx) => startTournament(tx, { tournamentId: 1n }))],
    [
      "cancelTournament",
      eve((tx) => cancelTournament(tx, { tournamentId: 1n })),
    ],
    ["registerSimBots", eve((tx) => registerSimBots(tx, { tournamentId: 1n }))],
    ["backfillElo", eve((tx) => backfillElo(tx, {}))],
    [
      "backfillTopBidArchive",
      eve((tx) => backfillTopBidArchive(tx, { maxRows: 10 })),
    ],
  ];
  for (const [name, err] of checks) {
    expect(err, name).toBe("Admin only");
  }
  expect(db.db.admin.count()).toBe(1n);
  expect(db.db.bot.count()).toBe(6n);
  expect(db.db.tournament.count()).toBe(0n);
});

test("a linked browser acts with its humans admin rights", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  call(db, "alice", (tx) =>
    connectId(tx, { webIdentity: identity("browser") }),
  );

  call(db, "browser", (tx) => addAdmin(tx, { humanIdentity: identity("bob") }));
  const bob = db.db.admin.humanIdentity.find(identity("bob"))!;
  expect(bob.addedBy).toEqual(identity("alice"));
});

test("spawn simulated bot creates a bot with a sim credential", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  call(db, "alice", (tx) =>
    spawnSimulatedBot(tx, {
      name: "  Zed-sim  ",
      strategy: { tag: "Cheapskate" },
    }),
  );

  const bot = botNamed(db, "Zed-sim");
  expect(bot.isSimulated).toBe(true);
  expect(bot.strategy.tag).toBe("Cheapskate");
  const cred = db.db.botCredential.identity.find(
    identityFromClaims("sim", "Zed-sim"),
  )!;
  expect(cred.botId).toBe(bot.id);
});

test("spawn simulated bot validates its input", () => {
  const db = newDb();
  makeAdmin(db, "alice");
  const spawn = (name: string, strategy: BotStrategy) =>
    failure(() =>
      call(db, "alice", (tx) => spawnSimulatedBot(tx, { name, strategy })),
    );
  expect(spawn("   ", { tag: "Cheapskate" })).toContain("1-32");
  expect(spawn("x".repeat(33), { tag: "Cheapskate" })).toContain("1-32");
  expect(spawn("Human-sim", { tag: "Human" })).toContain("Human strategy");
  expect(spawn("Cheapo-sim", { tag: "Cheapskate" })).toBe("Name already taken");
  expect(db.db.bot.count()).toBe(6n);
});
