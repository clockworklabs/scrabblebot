# Developing ScrabbleBot

This is the architecture and design-decisions notebook for ScrabbleBot. If
you're only writing a bot, see [README.md](README.md) and
[/docs](https://scrabblebot.vercel.app/docs) instead.

## Pieces

| Where | What it is | Stack |
|---|---|---|
| `spacetimedb/` | The whole game — schema, reducers, scheduled ticks, dictionary | Rust → WASM via [SpacetimeDB](https://spacetimedb.com) |
| `src/` | Spectator + admin + team UI | Vite + React + react-router-dom |
| `bot-starter/` | Reference bot client | Node + TypeScript + SpacetimeDB SDK |
| `spacetime.json` / `spacetime.local.json` | Project config (module path, db name, dev client command) | — |
| `vercel.json` | SPA-rewrite rules for the deployed UI | — |

Everything talks to one SpacetimeDB database (`scrabblebot` on maincloud).
There is no separate backend or auth server.

## Data flow at a glance

```
                 humans (CLI / browser)
                          │
                          ▼
                  ┌─────────────────┐
              ┌──▶│   reducers      │──┐
              │   │   (lib.rs)      │  │
              │   └─────────────────┘  │
              │                        ▼
              │              ┌─────────────────┐
              │              │  tables + views │
              │              └─────────────────┘
              │                        │
              │                        ▼
              └──────────────  clients (subscribe)
                               • bot processes
                               • spectator UI
```

## Identity model

Three distinct identity flavors, all SpacetimeDB `Identity` values:

| Flavor | Source | Stored where |
|---|---|---|
| **Web identity** | Anonymous, issued by SpacetimeDB to the browser on first visit | localStorage `scrabblebot-token` |
| **Human identity** | The developer's spacetimedb.com identity via `spacetime login` | Used as `ctx.sender()` for CLI reducer calls |
| **Bot credential** | Anonymous, issued to a bot process when it first connects | Persisted on disk by the bot (`.token-<name>`) |

The three are wired up by two link tables:

- `HumanLink { web_identity → human_identity }` — written by the
  `connect_id` reducer when a developer runs the linking command from CLI.
- `BotCredential { identity → bot_id }` — written by `claim_credential`
  when a fresh client redeems a one-time `CredentialNonce`. **Many
  credentials can act as the same bot**; old ones keep working when new
  ones are added.

A `Bot` is keyed by its own `u64 id` and is decoupled from any specific
identity. This is the key trick: humans can re-issue tokens for the same
bot persona indefinitely without ever "losing" the bot.

## Match formation — the lobby

Matches aren't started manually. There's a single rolling **Lobby** at all
times:

1. `init` opens the first Lobby and schedules `lobby_timeout_tick` at
   `now + LOBBY_DURATION_SECONDS` (60s).
2. Bots call `join_lobby()` — they're recorded in `LobbyMember`.
3. If **6 real bots** join, the lobby resolves immediately into a Match.
4. If the timer fires first, `lobby_timeout_tick` pads the roster up to 6
   with idle simulated bots and resolves.
5. The resolving step in both cases is `resolve_lobby()`: marks the lobby
   `Resolved`, starts the match (`start_match_with`), and calls
   `open_lobby_or_create()` to spawn the next one.

The cycle is self-sustaining as long as there are at least 2 participants
(real or sim) available at resolve time. If fewer, the lobby is
`Cancelled` and a fresh one opens.

Lobby `auction_type` is currently hardcoded to `Vickrey` in
`open_lobby_or_create`. Easy knob to expose later if we want to alternate.

## Match lifecycle

Each match has its own row in `Match`. State is fully per-match:

- `MatchParticipant { match_id, bot_id, balance, score }` — replaces what
  used to live on `Bot` (we're a multi-match game).
- `BagLetter { match_id, letter, remaining }` — each match has its own
  bag, drawn via `ctx.rng()` for determinism.
- `Auction { match_id, letter, status, opens_at, closes_at }` — one open
  auction at a time per match. The next auction is scheduled by
  `auction_tick`.
- `PendingBid { auction_id, bidder_bot_id, amount }` — **private** table.
  Bots can't subscribe, so sealed bids stay sealed.
- `AuctionResult { auction_id, winner_bot_id, top_bid, paid }` — public
  history.
- `Holding { match_id, bot_id, letter, count }` — **private** table. The
  `my_rack` view exposes only the calling identity's holdings, filtered
  via `BotCredential` → `bot_id`.
- `WordPlay { match_id, bot_id, word, base_score, bonus, total_reward }`
  — public.

`auction_tick` is a self-rescheduling scheduled reducer that runs every
`AUCTION_DURATION_MS` (1s). It closes the current auction (computes winner
and `paid` according to `AuctionType`), credits the rack, opens the next
auction, and on bag empty calls `on_match_ended(match_id)`.

`on_match_ended` does two things:

1. **ELO update** — `update_elo_at_match_end` runs pairwise: for each
   pair `(i, j)` of participants sorted by score, compute expected
   probability from current ratings, observe the outcome (1/0/0.5),
   accumulate a delta per bot, apply averaged over `(n − 1)` opponents.
   K=32.
2. **Tournament hook** — if the match was part of a tournament, advance
   the tournament (award Swiss points, eliminate bracket losers, etc.).

## Tournament

Three phases on a single Tournament row:

- **Swiss**: `start_tournament` pairs all bots randomly into matches of
  about `match_size` for round 1. Subsequent rounds sort by `swiss_points`
  and pair adjacently. Nobody sits out: there are `floor(n / match_size)`
  tables and any leftover bots are spread one per table, so 7 bots at
  size 3 play at tables of 4 and 3. Points per finishing position are
  `match_size − place` (1st = `match_size`), floored at 0, so first is
  worth the same at every table.
- **Bracket**: after the configured number of Swiss rounds, top
  `top_cut` advance. Each round eliminates the last-place finisher per
  match. Continues until only 2 remain.
- **Final**: best-of-3 between the last 2. Aggregate score across all 3
  games determines the winner.

`TournamentMatch` links `Tournament` ↔ `Match` rows with `round` and
`phase`. The advancement logic lives in `on_match_ended` and the
`advance_tournament` / `start_swiss_round` / `start_elimination_round` /
`start_final_game` helpers.

## Sealed-bid implementation

`PendingBid` is **not** declared `public`. SpacetimeDB clients can't
subscribe to private tables, so bidders see only their own bid as
acknowledged client-side — they can't snoop on the others. The auction
resolves entirely inside the module, then the result is written to the
public `AuctionResult`.

For real privacy, we'd also need to prevent bots from inferring opponent
bids via subscription deltas, but for a hackathon this is sufficient.

## Views

| View | Returns | Purpose |
|---|---|---|
| `my_rack` | `Vec<Holding>` | The caller's letters across all matches they're in (private to caller) |
| `my_team` | `Option<MyTeam>` | The calling human's team summary (resolves browser→human via `HumanLink`) |
| `my_nonces` | `Vec<CredentialNonce>` | Nonces the caller has minted (private to caller) |
| `my_admin` | `Option<Admin>` | Caller's admin row if present |

Views are how we let clients query data that depends on the caller's
identity without exposing it to everyone. Two helpers handle the
browser-vs-CLI ambiguity:

```rust
fn resolve_human(ctx: &ReducerContext) -> Identity;
fn resolve_human_view(ctx: &ViewContext) -> Identity;
```

Both look up `HumanLink` by `ctx.sender()`; if the caller is a linked
browser session, return the linked spacetime.com identity, otherwise
assume the caller already *is* the human.

## Reducer surface — who can call what

| Reducer | Caller | Notes |
|---|---|---|
| `connect_id(web_identity)` | Human (CLI) | Writes a `HumanLink` |
| `create_team(team, bot)` / `join_team` / `leave_team` / `promote_to_owner` | Human | Resolves caller via `resolve_human` |
| `mint_credential_nonce()` | Team member | Writes a `CredentialNonce` |
| `claim_credential(code)` | Fresh anonymous client | Writes a `BotCredential` |
| `join_lobby()` | Bot credential | Looks up `caller_bot_id` via `BotCredential` |
| `submit_bid(auction_id, amount)` | Bot credential | Idempotent — replaces any earlier bid by this bot on this auction |
| `submit_word(match_id, word)` | Bot credential | Validates dictionary + ownership, deducts letters, credits score |
| `bootstrap_admin()` | Anyone (first time only) | Allowed iff `Admin` table is empty |
| `add_admin` / `remove_admin` | Admin | Caller checked via `require_admin` |
| `spawn_simulated_bot(name, strategy)` | Admin | Bypasses team flow — creates Bot + BotCredential with a fabricated identity |
| `start_tournament(...)` | Admin | — |
| `auction_tick` / `lobby_timeout_tick` | Scheduler only | `require_scheduler` rejects any client caller |

Reducers that move shared state are admin-gated via `require_admin(ctx)?`
at the top of the function.

## Init seeding

`init` runs on every fresh database (`--delete-data on-conflict` during
dev republishes counts). It seeds:

1. **Admins** from `SEED_ADMIN_HEX` (currently just Tyler) — so dev wipes
   don't lock us out of `/admin`.
2. **Simulated bots** — `Cheapo`, `Valor`, `Brutus`, `Hagrid`, `Maverick`,
   `Snippet` — the pool used to pad lobby timeouts.
3. **The first lobby** — kicks the perpetual lobby cycle into motion.

To add yourself as a permanent admin, add your spacetime.com identity hex
to `SEED_ADMIN_HEX` in `lib.rs`.

## Frontend architecture

`src/connection.tsx` owns the single SpacetimeDB connection and exposes
it via React context (`useConn()`). It subscribes to all tables/views and
maintains a `version` counter that increments on any row change, giving
pages reactive re-renders without per-table state.

Pages:

| Route | What it shows |
|---|---|
| `/` (Home) | Open lobby panel + running matches + recently completed |
| `/matches` | List of all matches (running + ended) with top scorer |
| `/matches/:id` | Live spectator for one match — current auction with countdown, recent auctions, per-bot rack + balance + score (reconstructed from public events), words played |
| `/team`, `/team/new` | Team management; "Generate token" button does mint-nonce → fresh anon connect → claim-credential → display token, all behind the scenes |
| `/account` | Web identity hex + `connect_id` CLI instructions; or linked-human view |
| `/leaderboard` | ELO ratings |
| `/tournament` | Current tournament's Swiss standings + bracket; drill-down to `/matches/:id` |
| `/docs` | Bot-writing guide |
| `/admin` | Admin-only: manage admins, launch tournament. Hidden from non-admins. |

Reconstructing opponents' racks: `src/util.ts` has `reconstructRacks()`
which folds `AuctionResult` + `WordPlay` events into a `Map<bot_id_hex,
Map<letter, count>>`. Symmetric with what bots can derive from the same
public events.

## Bot starter design

`bot-starter/src/index.ts` is the reference implementation:

- Loads `BOT_TOKEN` from env or `.token-<BOT_NAME>` on disk.
- On `claimCredential`-needed (first run with `BOT_NONCE`), persists the
  fresh token automatically.
- Subscribes to all tables, resolves `myBotId` via `BotCredential`.
- On connect: `joinLobby()`.
- On `match_state` update where `Ended` and this bot was a participant:
  `joinLobby()` again (perpetual loop).
- On `auction.onInsert`: calls `decideBid` from `strategy.ts` and submits
  via `submitBid`.
- On `my_rack.onUpdate`: calls `chooseWord` from `strategy.ts` and submits
  via `submitWord`. Debounced to one attempt per 500ms per match.

`src/strategy.ts` is the *only* file participants are expected to edit.

## Dev workflow

```bash
npm install      # web
npm run dev      # spacetime dev + Vite together
```

`npm run dev` runs:
- `spacetime dev --server maincloud --delete-data on-conflict -y`
  which watches `spacetimedb/`, rebuilds the module, publishes to
  maincloud on every change (wipes data only on breaking schema changes).
- The Vite client (via `dev.run` in `spacetime.json`).

For local development, use `npm run dev:local` (requires
`spacetime start` running in another terminal).

### Tests

The module has native unit tests under `spacetimedb/src/tests/`. They use
SpacetimeDB's test harness (`spacetimedb::test_utils`, the `test-utils`
feature, 2.12.0+): each test builds a fresh in-memory database from the
module schema, calls reducers and views directly as a chosen caller, and
inspects every table, private ones included. No server needed.

```bash
cd spacetimedb
cargo test                 # the suite (~10s)
cargo test -- --ignored    # known bugs / open questions, expected to fail
```

Tests marked `#[ignore = "bug: ..."]` or `"TODO.md: ..."` pin down known
problems; un-ignore one when you fix it.

`Cargo.lock` is tracked on purpose: the harness pulls in the SpacetimeDB
engine, and an unlocked resolve picks an `icu_calendar` that its
`temporal_rs` dependency can't compile against.

### Database name

Set in `spacetime.local.json`. Currently `scrabblebot`. To rename in
place on maincloud (preserving data): `spacetime rename <db-identity-hex>
--to <new-name>`.

### Versions matter

`spacetimedb` Cargo crate, npm `spacetimedb` (web app and bot-starter),
and the `spacetime` CLI should all be on the same version — currently
2.12.0. A version mismatch manifests as TypeScript generated bindings
using `name:` while the SDK expects `accessor:` for `IndexOpts` —
typecheck fails immediately.

Since 2.7, generated TypeScript handles are camelCase
(`conn.db.matchState`, `conn.db.myRack`) even though the module's
accessors and SQL table names stay snake_case (`match_state`). Use the
camelCase handles in client code; the snake_case ones are deprecated
aliases due to be removed in the next major version. Index accessors
(`.web_identity`, `.identity`) are not renamed.

## Deployment

- **Module → maincloud**: `npm run publish` (one-shot) or `npm run dev`
  (continuous).
- **Web UI → Vercel**: `npx vercel --yes --name scrabblebot` from repo
  root. SPA-rewrite is configured in `vercel.json` so direct URLs to
  `/team`, `/matches/123`, etc. work. Env vars
  (`VITE_STDB_HOST`, `VITE_STDB_DB`) come from `.env.production` —
  defaults to maincloud + scrabblebot.

## Things we deliberately didn't do

- **No SpacetimeAuth integration.** We bridge to spacetime.com identity
  via a CLI `connect_id` call instead of running an OAuth flow.
- **No backend.** All logic lives in the SpacetimeDB module; the React
  app talks to it directly via WebSocket.
- **No bot rotation/retire.** "Rotating credentials" means adding a new
  one alongside the old one. The bot persona survives forever.
- **No human play.** Bots only.

## Known limitations

- The dictionary is the public-domain ENABLE list. Real Scrabble play
  uses TWL (US) or SOWPODS (international); drop one in at
  `spacetimedb/wordlist.txt` (sorted, uppercase, one word per line) if
  you have a license.
- We don't handle bot crashes inside a match — the bot's slot just goes
  silent. The match continues; that bot just won't bid or play words.
