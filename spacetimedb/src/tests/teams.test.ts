// Teams, membership and bot credential provisioning.

import { ScheduleAt } from "spacetimedb";
import { expect, test } from "vitest";
import { afterSeconds, NONCE_TTL_SECONDS } from "../game";
import {
  claim_credential,
  create_team,
  join_team,
  leave_team,
  mint_credential_nonce,
  nonce_expiry_tick,
  promote_to_owner,
} from "../index";
import type { NonceExpirySchedule, TeamMember } from "../schema";
import {
  botNamed,
  byBigint,
  call,
  failure,
  identity,
  internal,
  newDb,
  noncesFor,
  now,
  plusMicros,
  teamWithBot,
  type Test,
} from "./harness";

function create(db: Test, who: string, team: string, bot: string) {
  call(db, who, (tx) => create_team(tx, { team_name: team, bot_name: bot }));
}

function member(db: Test, who: string): TeamMember | null {
  return db.db.team_member.user.find(identity(who));
}

const mint = (db: Test, who: string) =>
  call(db, who, (tx) => mint_credential_nonce(tx, {}));
const claim = (db: Test, who: string, code: string) =>
  call(db, who, (tx) => claim_credential(tx, { code }));
const join = (db: Test, who: string, team: string) =>
  call(db, who, (tx) => join_team(tx, { team_name: team }));
const leave = (db: Test, who: string) =>
  call(db, who, (tx) => leave_team(tx, {}));

test("create_team_makes_a_team_its_bot_and_an_owner", () => {
  const db = newDb();
  create(db, "alice", "  The Alices  ", " Robo ");

  const team = db.db.team.name.find("The Alices")!;
  const bot = botNamed(db, "Robo");
  expect(bot.team_id).toBe(team.id);
  expect(bot.is_simulated).toBe(false);
  expect(bot.strategy.tag).toBe("Human");
  const m = member(db, "alice")!;
  expect([m.team_id, m.role.tag]).toEqual([team.id, "Owner"]);
  expect([...db.db.bot_credential.cred_by_bot.filter(bot.id)].length).toBe(0);
});

test("create_team_validates_names", () => {
  const db = newDb();
  const cases: [string, string, string][] = [
    ["", "Robo", "Team name must be 1-48 characters"],
    ["t".repeat(49), "Robo", "Team name must be 1-48 characters"],
    ["Team", "  ", "Bot name must be 1-32 characters"],
    ["Team", "b".repeat(33), "Bot name must be 1-32 characters"],
    ["Team", "Cheapo-sim", "Bot name already taken"],
  ];
  for (const [team, bot, expected] of cases) {
    expect(
      failure(() => create(db, "alice", team, bot)),
      `${team}/${bot}`,
    ).toBe(expected);
  }
  expect(db.db.team.count()).toBe(0n);
  expect(db.db.team_member.count()).toBe(0n);
});

test("create_team_rejects_duplicates_and_double_membership", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  expect(failure(() => create(db, "bob", "Team", "Other"))).toBe(
    "Team name already taken",
  );
  expect(failure(() => create(db, "alice", "Team 2", "Other"))).toBe(
    "You're already on a team",
  );
  expect(db.db.team.count()).toBe(1n);
  expect(db.db.bot.count()).toBe(7n);
});

test("join_team_adds_a_member", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  join(db, "bob", " Team ");

  const bob = member(db, "bob")!;
  expect(bob.role.tag).toBe("Member");
  expect(bob.team_id).toBe(member(db, "alice")!.team_id);

  expect(failure(() => join(db, "bob", "Team"))).toBe(
    "You're already on a team",
  );
  expect(failure(() => join(db, "carol", "Nope"))).toBe("No such team");
});

test("leaving_keeps_the_team_while_members_remain", () => {
  const db = newDb();
  const botId = teamWithBot(db, "alice", "Robo");
  const teamId = member(db, "alice")!.team_id;
  join(db, "bob", "Team Robo");

  leave(db, "alice");

  expect(member(db, "alice")).toBeNull();
  expect(db.db.team.id.find(teamId)).not.toBeNull();
  expect(db.db.bot.id.find(botId)).not.toBeNull();
  expect(failure(() => leave(db, "alice"))).toBe("You're not on a team");
});

test("the_last_member_leaving_dissolves_the_team_bot_and_credentials", () => {
  const db = newDb();
  const botId = teamWithBot(db, "alice", "Robo");
  const teamId = member(db, "alice")!.team_id;

  leave(db, "alice");

  expect(db.db.team.id.find(teamId)).toBeNull();
  expect(db.db.bot.id.find(botId)).toBeNull();
  expect([...db.db.bot_credential.cred_by_bot.filter(botId)].length).toBe(0);
  // The sims are untouched.
  expect(db.db.bot.count()).toBe(6n);
});

test("owners_can_promote_teammates", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  join(db, "bob", "Team");

  call(db, "alice", (tx) =>
    promote_to_owner(tx, { target_user: identity("bob") }),
  );
  expect(member(db, "bob")!.role.tag).toBe("Owner");
  expect(member(db, "alice")!.role.tag).toBe("Owner");
});

test("promotion_rules", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  join(db, "bob", "Team");
  join(db, "carol", "Team");
  create(db, "dave", "Other", "Other");

  const promote = (who: string, target: string) =>
    failure(() =>
      call(db, who, (tx) =>
        promote_to_owner(tx, { target_user: identity(target) }),
      ),
    );
  expect(promote("bob", "carol")).toBe("Only owners can promote");
  expect(promote("alice", "dave")).toBe("Target user is not on your team");
  expect(promote("alice", "stranger")).toBe("Target user is not on a team");
  expect(promote("stranger", "alice")).toBe("You're not on a team");
  expect(member(db, "carol")!.role.tag).toBe("Member");
});

test("minting_a_nonce_requires_a_team", () => {
  const db = newDb();
  const err = failure(() => mint(db, "alice"));
  expect(err).toContain("not on a team");
  expect(db.db.credential_nonce.count()).toBe(0n);
});

test("minted_nonces_are_unique_codes_with_a_one_hour_ttl", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  mint(db, "alice");
  mint(db, "alice");

  const nonces = noncesFor(db, "alice");
  expect(nonces.length).toBe(2);
  expect(nonces[0]!.code).not.toBe(nonces[1]!.code);
  for (const n of nonces) {
    expect(n.code.length).toBe(12);
    expect(/^[A-Z0-9]+$/.test(n.code)).toBe(true);
    expect(/[IO01]/.test(n.code), `ambiguous chars in ${n.code}`).toBe(false);
    expect(n.bot_id).toBe(botNamed(db, "Robo").id);
    expect(n.expires_at).toEqual(afterSeconds(now(), NONCE_TTL_SECONDS));
  }
});

// On the host, the SDK maps many timestamps to the same few ctx.random
// seeds. Codes drawn from them collided, and the second mint failed.
test("mints_that_share_an_rng_seed_get_different_codes", () => {
  const db = newDb();
  create(db, "alice", "Alices", "Robo");
  create(db, "bob", "Bobs", "Bobo");
  db.rng.setSeed(1);
  mint(db, "alice");
  db.rng.setSeed(1);
  db.clock.set(plusMicros(now(), 1n));
  mint(db, "bob");
  expect(noncesFor(db, "alice")[0]!.code).not.toBe(
    noncesFor(db, "bob")[0]!.code,
  );
});

test("any_team_member_can_mint_for_the_team_bot", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  join(db, "bob", "Team");
  mint(db, "bob");
  expect(noncesFor(db, "bob")[0]!.bot_id).toBe(botNamed(db, "Robo").id);
});

test("claiming_a_nonce_makes_the_caller_a_bot_credential", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  mint(db, "alice");
  const code = noncesFor(db, "alice")[0]!.code;

  claim(db, "robo-process", code);

  const cred = db.db.bot_credential.identity.find(identity("robo-process"))!;
  expect(cred.bot_id).toBe(botNamed(db, "Robo").id);
  expect(cred.connected).toBe(true);
  expect(noncesFor(db, "alice"), "nonce is single-use").toEqual([]);

  expect(failure(() => claim(db, "another", code))).toBe("No such nonce");
});

test("an_identity_can_only_be_a_credential_for_one_bot", () => {
  const db = newDb();
  teamWithBot(db, "alice", "Robo");
  create(db, "bob", "Other", "Other");
  mint(db, "bob");
  const code = noncesFor(db, "bob")[0]!.code;

  expect(failure(() => claim(db, "Robo", code))).toBe(
    "Your identity is already a credential for a bot",
  );
  expect(noncesFor(db, "bob").length, "failed claim leaves the nonce").toBe(1);
});

test("expired_nonces_are_rejected", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  mint(db, "alice");
  const code = noncesFor(db, "alice")[0]!.code;

  db.clock.set(afterSeconds(now(), NONCE_TTL_SECONDS));
  const err = failure(() => claim(db, "robo-process", code));

  expect(err).toBe("This nonce has expired");
  expect(
    db.db.bot_credential.identity.find(identity("robo-process")),
  ).toBeNull();
});

function expiryJobs(db: Test): NonceExpirySchedule[] {
  return [...db.db.nonce_expiry_schedule.iter()];
}

test("minting_schedules_the_nonce_to_expire", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  mint(db, "alice");

  const nonce = noncesFor(db, "alice").pop()!;
  const jobs = expiryJobs(db);
  expect(jobs.length).toBe(1);
  expect(jobs[0]!.nonce_id).toBe(nonce.id);
  expect(jobs[0]!.scheduled_at).toEqual(
    ScheduleAt.time(nonce.expires_at.microsSinceUnixEpoch),
  );
});

test("expired_nonces_are_cleaned_up", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  mint(db, "alice");
  mint(db, "alice");
  const job = expiryJobs(db).sort((a, b) =>
    byBigint(a.nonce_id, b.nonce_id),
  )[0]!;

  db.clock.set(afterSeconds(now(), NONCE_TTL_SECONDS));
  internal(db, (tx) => nonce_expiry_tick(tx, { job }));

  const left = noncesFor(db, "alice");
  expect(left.length, "only the expired nonce goes").toBe(1);
  expect(left[0]!.id).not.toBe(job.nonce_id);
});

test("the_expiry_job_tolerates_an_already_claimed_nonce", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  mint(db, "alice");
  const code = noncesFor(db, "alice")[0]!.code;
  claim(db, "robo-process", code);

  const job = expiryJobs(db).pop()!;
  internal(db, (tx) => nonce_expiry_tick(tx, { job }));
});

test("clients_cannot_expire_nonces", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  mint(db, "alice");
  const job = expiryJobs(db).pop()!;

  const err = failure(() =>
    call(db, "mallory", (tx) => nonce_expiry_tick(tx, { job })),
  );
  expect(err).toBe("Only the scheduler may call this");
  expect(noncesFor(db, "alice").length).toBe(1);
});

test("dissolving_a_team_revokes_its_nonces", () => {
  const db = newDb();
  create(db, "alice", "Team", "Robo");
  create(db, "bob", "Other", "Other");
  mint(db, "alice");
  mint(db, "bob");
  const code = noncesFor(db, "alice")[0]!.code;
  leave(db, "alice");

  expect(failure(() => claim(db, "robo-process", code))).toBe("No such nonce");
  expect(noncesFor(db, "bob").length, "other teams keep theirs").toBe(1);
});
