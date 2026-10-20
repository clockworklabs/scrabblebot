# ScrabbleBot

A Scrabble-style auction game where AI bots compete for letters.

Each round the module reveals one letter from a shared Scrabble bag and runs a
1-second sealed-bid auction. The highest bidder wins the letter, adds it to
their rack, and pays (Vickrey or first-price). Bots play words from their
collected letters at any time to earn currency, which funds future bids. Long
words pay a superlinear bonus, so hoarding is rewarded.

Built on [SpacetimeDB](https://spacetimedb.com): rules, timing, lobby
formation, dictionary — all inside a TypeScript module. Bots are external
SpacetimeDB clients (any language); the spectator UI is a Vite + React app.

Live at **[scrabblebot.vercel.app](https://scrabblebot.vercel.app)** ·
Bot-writing docs: **[/docs](https://scrabblebot.vercel.app/docs)**

## Repo layout

The web client lives at the repo root (standard SpacetimeDB project shape);
the module is nested inside it.

| Path | What it is |
|---|---|
| `src/`, `index.html`, `vite.config.ts` | Vite + React spectator UI |
| `spacetimedb/` | TypeScript module — schema, reducers, scheduled lobby + auction ticks, dictionary |
| `bot-starter/` | TypeScript starter bot — fork & edit `src/strategy.ts` |

## How a match comes together

There's a single rolling **lobby** that's always open for 60 seconds at a
time:

- Real bots `join_lobby()` at any time.
- If 6 real bots join → match starts immediately.
- If the timer expires → match starts with whoever's there, padded out to 6
  with idle simulated bots.
- A fresh lobby opens the moment the previous one resolves.

This means matches run continuously without anyone having to manually
schedule them. Bots that finish a match just call `join_lobby()` again.

## The rules

- **Auction:** 1-second sealed-bid window per letter. Highest bid wins; ties
  are broken at random.
- **Payment:** Vickrey by default (winner pays the runner-up's bid; reserve
  1). First-price is configurable per lobby.
- **Currency:** start at 100 per match. Reward for a word = base score ×
  length multiplier (1.0× ≤3 letters → 3.0× ≥7 letters). Reward goes into
  both `balance` (spendable) and `score` (ranking).
- **Letters:** standard 98-tile Scrabble bag (no blanks). Match ends when the
  bag empties. Tiles nobody bids on go back to the bag.
- **Visibility:** `Holding` and `BagLetter` are private. Bots see only their
  own rack via the `my_rack` view; nobody can subscribe to the full bag
  composition. The spectator reconstructs opponents' racks from public
  `AuctionResult` + `WordPlay` events.
- **Dictionary:** the public-domain
  [ENABLE](https://en.wikipedia.org/wiki/Moby_Project#ENABLE) wordlist
  (~173k words), embedded from `spacetimedb/wordlist.txt`. Swap in TWL or
  SOWPODS if you have a license.
- **Rating:** per-bot ELO updates pairwise at every match end (K=32).

## Writing a bot (5-minute version)

Three steps end-to-end:

1. **Get a token** — on the live site, link your spacetimedb.com identity at
   `/account`, then create a team at `/team/new`, then click *Generate token*
   on `/team`. You'll get a SpacetimeDB JWT bound to a credential for your
   team's bot persona (shown once).
2. **Fork the starter** and plug the token in:
   ```bash
   git clone https://github.com/clockworklabs/scrabblebot
   cd scrabblebot/bot-starter
   npm install
   npm run generate
   BOT_NAME=alice BOT_TOKEN=<token> npm start
   ```
3. **Edit `bot-starter/src/strategy.ts`** — two functions:
   - `decideBid(ctx)` — return how much to bid for the current letter.
   - `chooseWord(ctx)` — pick a word to play from your rack.

That's it. Your bot will auto-join the lobby, play in matches as they form,
and re-join after each one ends. Token is persisted to
`.token-<BOT_NAME>` after the first run.

For a deeper writeup — what's visible to your bot, the reducer API, the
SpacetimeDB connection snippet end-to-end — see **[/docs](https://scrabblebot.vercel.app/docs)**.

Bots can use any language SpacetimeDB has an SDK for (Rust, C#, TypeScript).
The starter is just convenience; the reducer interface is language-agnostic.

## Running the project locally

For development work on the module or UI:

```bash
npm install
npm install --prefix spacetimedb
npm run dev
```

This launches `spacetime dev` against maincloud — auto-builds the module,
publishes it, regenerates client bindings, and starts the Vite client on
http://localhost:5173. Edit `spacetimedb/src/` and changes flow
straight through to the browser.

The maincloud database name is set in `spacetime.local.json` (defaults to
`scrabblebot`). The `init` reducer seeds a default admin and the simulated
bot pool on every fresh database init.

### Other npm scripts

- `npm run dev:local` — same flow against a local `spacetime start` server.
- `npm run publish` — one-shot publish to the configured server.
- `npm run generate` — regenerate client bindings without the watcher.
- `npm run build` / `npm run preview` — production build of the spectator.

## Tournament mode

`/admin` (admin-only) has a tournament launcher: Swiss rounds → top-N cut →
single-elimination bracket → best-of-3 finals. Match size, Swiss round
count, and top cut are configurable. ELO ratings are updated independently
of tournament standings.

## Known limitations

- No human play — bots only.
- Token-recovery for bots is via the *rotate* model: mint a new credential
  on `/team` and the old token keeps working in parallel. The bot persona
  itself survives.

## License

MIT.
