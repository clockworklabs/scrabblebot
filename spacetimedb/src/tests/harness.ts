// Shared helpers for the module's unit tests. Each test builds its own
// in-memory database from this module's schema via `spacetimedb`'s test
// harness, calls reducers directly and inspects the tables (private ones
// included). See `npm test`.

import {
  ConnectionId,
  ScheduleAt,
  TimeDuration,
  Timestamp,
  type Identity,
} from "spacetimedb";
import type { InferSchema } from "spacetimedb/server";
import {
  createModuleTestHarness,
  TestAuth,
  type ModuleTestHarness,
} from "spacetimedb/server/test-utils";
import { AUCTION_DURATION_MS, isErr, startMatchWith, type Ctx } from "../game";
import { identityFromClaims } from "../identity";
import * as moduleExports from "../index";
import {
  auctionTick,
  claimCredential,
  createTeam,
  init,
  lobbyTimeoutTick,
  mintCredentialNonce,
} from "../index";
import spacetimedb, {
  type Auction,
  type AuctionSchedule,
  type AuctionType,
  type Bot,
  type CredentialNonce,
  type LobbyTimeoutSchedule,
  type Match,
  type MatchParticipant,
} from "../schema";

export type Test = ModuleTestHarness<InferSchema<typeof spacetimedb>>;

export const ISSUER = "https://auth.example.com";

// 12/10/2026 12:00:00 UTC.
export const NOW_MICROS = 1_791_806_400_000_000n;

export function now(): Timestamp {
  return new Timestamp(NOW_MICROS);
}

export function plusMicros(ts: Timestamp, micros: bigint): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + micros);
}

/** A fresh, empty database with the clock at `now()`. No `init`. */
export function emptyDb(): Test {
  const test = createModuleTestHarness(spacetimedb, moduleExports);
  test.clock.set(now());
  return test;
}

/** A fresh database after `init`: seed admin, six sim bots, one open lobby. */
export function newDb(): Test {
  const test = emptyDb();
  internal(test, (tx) => init(tx, {}));
  return test;
}

let nextConnection = 1n;

/** A client signed in as `subject` with our test issuer. */
export function client(subject: string): TestAuth {
  return asClaims(ISSUER, subject);
}

/**
 * A client whose token carries exactly these `iss`/`sub` claims. Sim bots'
 * credentials are `identityFromClaims("sim", name)`, so
 * `asClaims("sim", "Cheapo-sim")` acts as that sim bot.
 */
export function asClaims(issuer: string, subject: string): TestAuth {
  return TestAuth.fromJwtPayload(
    JSON.stringify({ iss: issuer, sub: subject }),
    new ConnectionId(nextConnection++),
  );
}

/** The identity `client(subject)` will have. */
export function identity(subject: string): Identity {
  return identityFromClaims(ISSUER, subject);
}

/** Run `body` as the client `subject`. */
export function call<T>(test: Test, subject: string, body: (ctx: Ctx) => T): T {
  return test.withReducerTx(client(subject), body);
}

/** Run `body` as the database itself (init, scheduled reducers). */
export function internal<T>(test: Test, body: (ctx: Ctx) => T): T {
  return test.withReducerTx(TestAuth.internal(), body);
}

/** The message of the error `f` throws. Fails the test if it doesn't throw. */
export function failure(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("expected an error, but the call succeeded");
}

/** Make `subject` an admin by writing the row directly. */
export function makeAdmin(test: Test, subject: string) {
  test.db.admin.insert({
    humanIdentity: identity(subject),
    addedAt: now(),
    addedBy: undefined,
  });
}

/**
 * Create a team owned by `owner` with a bot named `botName`, and give the
 * bot a credential whose identity is `client(botName)`. Returns the bot id.
 */
export function teamWithBot(
  test: Test,
  owner: string,
  botName: string,
): bigint {
  call(test, owner, (tx) =>
    createTeam(tx, { teamName: `Team ${botName}`, botName: botName }),
  );
  call(test, owner, (tx) => mintCredentialNonce(tx, {}));
  const code = noncesFor(test, owner).pop()!.code;
  call(test, botName, (tx) => claimCredential(tx, { code }));
  return botNamed(test, botName).id;
}

export function botNamed(test: Test, name: string): Bot {
  const bot = test.db.bot.name.find(name);
  if (!bot) throw new Error(`no bot named ${name}`);
  return bot;
}

export function byBigint(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function noncesFor(test: Test, subject: string): CredentialNonce[] {
  return [
    ...test.db.credentialNonce.nonceByCreator.filter(identity(subject)),
  ].sort((a, b) => byBigint(a.id, b.id));
}

/** Start a match directly, bypassing the lobby. Returns the match id. */
export function startMatch(
  test: Test,
  auctionType: AuctionType,
  bots: bigint[],
): bigint {
  return internal(test, (tx) => {
    const r = startMatchWith(tx, auctionType, [...bots]);
    if (isErr(r)) throw new Error(r.err);
    return r.ok;
  });
}

export const VICKREY: AuctionType = { tag: "Vickrey" };
export const FIRST_PRICE: AuctionType = { tag: "FirstPrice" };

export function getMatch(test: Test, matchId: bigint): Match {
  return test.db.matchState.id.find(matchId)!;
}

export function currentAuction(test: Test, matchId: bigint): Auction {
  const id = getMatch(test, matchId).currentAuctionId!;
  return test.db.auction.id.find(id)!;
}

export function participant(
  test: Test,
  matchId: bigint,
  botId: bigint,
): MatchParticipant {
  return [...test.db.matchParticipant.mpByMatch.filter(matchId)].find(
    (p) => p.botId === botId,
  )!;
}

/** The bot's rack in a match, as sorted [letter, count] pairs. */
export function rack(
  test: Test,
  matchId: bigint,
  botId: bigint,
): [string, number][] {
  return [...test.db.holding.holdingByMatchBot.filter([matchId, botId])]
    .map((h): [string, number] => [h.letter, h.count])
    .sort(([a, an], [b, bn]) => (a < b ? -1 : a > b ? 1 : an - bn));
}

/** Replace the bot's rack in a match with exactly `letters`. */
export function setRack(
  test: Test,
  matchId: bigint,
  botId: bigint,
  letters: string,
) {
  const old = [
    ...test.db.holding.holdingByMatchBot.filter([matchId, botId]),
  ].map((h) => h.id);
  for (const id of old) {
    test.db.holding.id.delete(id);
  }
  const counts = new Map<string, number>();
  for (const c of [...letters].sort()) {
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  for (const [c, count] of counts) {
    test.db.holding.insert({
      id: 0n,
      matchId: matchId,
      botId: botId,
      letter: c,
      count,
    });
  }
}

/** The schedule row that closes `matchId`'s current auction. */
export function auctionJob(matchId: bigint): AuctionSchedule {
  return {
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(NOW_MICROS),
    matchId: matchId,
  };
}

/** The schedule row that times out `lobbyId`. */
export function lobbyJob(lobbyId: bigint): LobbyTimeoutSchedule {
  return {
    scheduledId: 0n,
    scheduledAt: ScheduleAt.time(NOW_MICROS),
    lobbyId: lobbyId,
  };
}

/** Close the current auction as the scheduler would. */
export function tick(test: Test, matchId: bigint) {
  internal(test, (tx) => auctionTick(tx, { job: auctionJob(matchId) }));
}

/** Time out a lobby as the scheduler would. */
export function lobbyTimeout(test: Test, lobbyId: bigint) {
  internal(test, (tx) => lobbyTimeoutTick(tx, { job: lobbyJob(lobbyId) }));
}

/** Tick the match until the bag runs out. Returns the number of ticks. */
export function runToEnd(test: Test, matchId: bigint): number {
  let ticks = 0;
  while (getMatch(test, matchId).status.tag === "Running") {
    test.clock.advance(new TimeDuration(AUCTION_DURATION_MS * 1000n));
    tick(test, matchId);
    ticks += 1;
    if (ticks > 200) throw new Error(`match ${matchId} never ended`);
  }
  return ticks;
}

export function simIds(test: Test): bigint[] {
  return [...test.db.bot.iter()]
    .filter((b) => b.isSimulated)
    .map((b) => b.id)
    .sort(byBigint);
}
