# Developing ScrabbleBot

This is the architecture and design-decisions notebook for ScrabbleBot. If
you're only writing a bot, see [README.md](README.md) and
[/docs](https://scrabblebot.vercel.app/docs) instead.

## Pieces

| Where | What it is | Stack |
|---|---|---|
| `spacetimedb/` | The whole game — schema, reducers, scheduled ticks, dictionary | TypeScript module on [SpacetimeDB](https://spacetimedb.com) |
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
              │   │   (index.ts)    │  │
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
5. The resolving step in both cases is `resolveLobby()`: marks the lobby
   `Resolved`, starts the match (`startMatchWith`), and calls
   `openLobbyOrCreate()` to spawn the next one.

The cycle is self-sustaining as long as there are at least 2 participants
(real or sim) available at resolve time. If fewer, the lobby is
`Cancelled` and a fresh one opens.

Lobby `auction_type` is currently hardcoded to `Vickrey` in
`openLobbyOrCreate`. Easy knob to expose later if we want to alternate.

## Match lifecycle

Each match has its own row in `Match`. State is fully per-match:

- `MatchParticipant { match_id, bot_id, balance, score }` — replaces what
  used to live on `Bot` (we're a multi-match game).
- `BagLetter { match_id, letter, remaining }` — each match has its own
  bag, drawn via `ctx.random` for determinism.
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
auction, and on bag empty calls `onMatchEnded(match_id)`.

`onMatchEnded` does two things:

1. **ELO update** — `updateEloAtMatchEnd` rates each participant
   against every other by final score, with Elo (K=32) and Weng-Lin
   (OpenSkill). `ratings.ts` is a port of the Rust `skillratings` crate
   the module used before, and reproduces its results exactly.
2. **Tournament hook** — if the match was part of a tournament, advance
   the tournament (award Swiss points, eliminate bracket losers, etc.).

## Match defaults

The auction length, starting rack size and lobby size come from the
single `matchmaker_config` row (id 0) once an admin has saved one with
`set_matchmaker_config`, and from the constants in `game.ts` until then.
Each match copies the auction length and rack size into its own row when
it starts (`auction_duration_ms`, `starting_rack_size`), and each lobby
its `max_size` when it opens, so changing the defaults never changes a
match or lobby already under way. The spectator UI reads a match's
`startingRackSize` to count its face-down tiles.

## Tournament

An admin creates a tournament with `create_tournament`, which opens it
for registration (status `Registration`); only one tournament can be open
or under way at a time. Bots enter with `register_for_tournament` and
leave with `unregister_from_tournament`, both called from the bot's own
process: the caller has to be one of the bot's credentials, and a browser
identity never is. `register_sim_bots` enters every sim for a rehearsal.
`cancel_tournament` deletes a tournament that hasn't started.

`start_tournament` drops entries whose bot has been deleted and needs at
least `match_size` entrants. It takes entrants out of the open lobby, and
until they're knocked out or the tournament ends, `join_lobby` refuses
them and `resolve_lobby` skips them (`heldForTournament`), so they're free
for every tournament match. Sims are exempt, so they keep padding casual
lobbies. A real (non-sim) entrant still in a casual match finishes it
first: the tournament sits at Swiss round 0, and round 1 starts when the
last of those matches ends (`startRoundOneWhenFree`). Then three phases
run on the Tournament row:

- **Swiss**: `start_tournament` pairs the entrants randomly into matches of
  about `match_size` for round 1. Later rounds sort by the standings and
  pair adjacently. Nobody sits out: there are `floor(n / match_size)`
  tables and any leftover bots are spread one per table, so 7 bots at
  size 3 play at tables of 4 and 3. Points per finishing position are
  `match_size − place` (1st = `match_size`), floored at 0, so first is
  worth the same at every table. Bots on the same score share the higher
  place, as tied leaders all get a win in `bot_stats`.
- **The cut**: after the configured number of Swiss rounds the top
  `top_cut` go through, ranked by Swiss points, then `total_score` (the
  bot's score over all its matches in the tournament), then the lower bot
  id. The tournament moves to `Bracket`, or straight to `Final` if only two
  went through.
- **Bracket**: each elimination match seats every bot still in and knocks
  out its last-place finisher, a tie going to `total_score` and then the
  higher bot id, so there are no replays. The knocked-out bot's
  `final_finish_position` is the number left before the match. With two
  left the tournament moves to `Final`.
- **Final**: three games between the last two. Their score over the three
  games, then `total_score`, then bot id, decides 1st and 2nd. The
  tournament is then `Ended` with `winner_bot_id` set.

Matches after the cut wait for the admin: `start_next_finals_match` starts
the next elimination match or final game, and refuses while one is being
played, so the finals can be run from a stage.

A tournament can't seat a deleted bot, so `leave_team` won't let the last
member dissolve a team whose bot is still in contention in a tournament
under way. Dissolving withdraws the bot from tournaments still in
registration, and keeps its entries in ones it has played.

`force_end_tournament` stops a tournament that's under way, leaving it
`ForceEnded` with no champion. Its matches in progress play out as
ordinary matches.

`TournamentMatch` links `Tournament` ↔ `Match` rows with `round` and
`phase`. The logic lives in `tournament.ts`: `onTournamentMatchEnded`
scores each result, and stops moving a tournament once it has finished or
been stopped.

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
| `my_rack` | `Holding[]` | The caller's letters across all matches they're in (private to caller) |
| `my_team` | `TeamSummary \| undefined` | The calling human's team summary (resolves browser→human via `HumanLink`) |
| `my_nonces` | `CredentialNonce[]` | Nonces the caller has minted (private to caller) |
| `my_admin` | `Admin \| undefined` | Caller's admin row if present |

Views are how we let clients query data that depends on the caller's
identity without exposing it to everyone. Two helpers handle the
browser-vs-CLI ambiguity:

```ts
function resolveHuman(ctx: Ctx): Identity;
function resolveHumanView(ctx: ViewContext): Identity;
```

Both look up `HumanLink` by `ctx.sender`; if the caller is a linked
browser session, return the linked spacetime.com identity, otherwise
assume the caller already *is* the human.

## Reducer surface — who can call what

| Reducer | Caller | Notes |
|---|---|---|
| `connect_id(web_identity)` | Human (CLI) | Writes a `HumanLink` |
| `create_team(team, bot)` / `join_team` / `leave_team` / `promote_to_owner` | Human | Resolves caller via `resolveHuman` |
| `mint_credential_nonce()` | Team member | Writes a `CredentialNonce` |
| `claim_credential(code)` | Fresh anonymous client | Writes a `BotCredential` |
| `join_lobby()` | Bot credential | Looks up `callerBotId` via `BotCredential` |
| `submit_bid(auction_id, amount)` | Bot credential | Idempotent — replaces any earlier bid by this bot on this auction |
| `submit_word(match_id, word)` | Bot credential | Validates dictionary + ownership, deducts letters, credits score |
| `bootstrap_admin()` | Anyone (first time only) | Allowed iff `Admin` table is empty |
| `add_admin` / `remove_admin` | Admin | Caller checked via `requireAdmin` |
| `spawn_simulated_bot(name, strategy)` | Admin | Bypasses team flow — creates Bot + BotCredential with a fabricated identity |
| `create_tournament(...)` / `start_tournament(id)` / `cancel_tournament(id)` / `register_sim_bots(id)` | Admin | |
| `start_next_finals_match(id)` | Admin | One finals match at a time |
| `set_matchmaker_config(rack, lobby, auction_ms)` | Admin | Defaults for new matches and lobbies |
| `force_end_tournament(id)` | Admin | Stops a tournament under way: status `ForceEnded`, no champion |
| `register_for_tournament(id)` / `unregister_from_tournament(id)` | Bot credential | Only while the tournament is in `Registration` |
| `auction_tick` / `lobby_timeout_tick` | Scheduler only | `requireScheduler` rejects any client caller |

Reducers that move shared state are admin-gated via `requireAdmin(ctx)`
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
to `SEED_ADMIN_HEX` in `game.ts`.

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
npm install                       # web
npm install --prefix spacetimedb  # module
npm run dev                       # spacetime dev + Vite together
```

`npm run dev` runs:
- `spacetime dev --server maincloud --delete-data on-conflict -y`
  which watches `spacetimedb/`, rebuilds the module, publishes to
  maincloud on every change (wipes data only on breaking schema changes).
- The Vite client (via `dev.run` in `spacetime.json`).

For local development, use `npm run dev:local` (requires
`spacetime start` running in another terminal).

### Tests

The module has unit tests under `spacetimedb/src/tests/`. They use
SpacetimeDB's test harness (`spacetimedb/server/test-utils`, 2.12.0+) with
Vitest: each test builds a fresh in-memory database from the module
schema, calls reducers and views directly as a chosen caller, and inspects
every table, private ones included. No server needed.

```bash
cd spacetimedb
npm test                   # the suite (~3s)
```

The harness doesn't run scheduled reducers or check `senderAuth` the way a
host does, so also try changes against a real server (`npm run
dev:local`).

### Database name

Set in `spacetime.local.json`. Currently `scrabblebot`. To rename in
place on maincloud (preserving data): `spacetime rename <db-identity-hex>
--to <new-name>`.

### Versions matter

npm `spacetimedb` (module, web app and bot-starter) and the `spacetime`
CLI should all be on the same version, currently 2.12.0. A version mismatch manifests as TypeScript generated bindings
using `name:` while the SDK expects `accessor:` for `IndexOpts` —
typecheck fails immediately.

TypeScript identifiers are camelCase everywhere: table accessors
(`ctx.db.matchState`, `conn.db.myRack`), columns, index accessors
(`.webIdentity`), reducers and views. The canonical names that SQL, the
CLI and the HTTP API use are snake_case (`match_state`,
`start_tournament`), derived by the SDK's default case conversion.
Renaming an index accessor is not an automatic migration in 2.12, so a
change that renames one has to be published with `--delete-data`.

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
