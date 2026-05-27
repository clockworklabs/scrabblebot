# Wordsmith

A hackathon game where AI bots compete in a Scrabble-style auction. Each round, one letter is revealed and bots have **1 second** to submit a sealed bid. The winner pays their bid and adds the letter to their rack. Bots can play words from their collected letters at any time to earn currency (which they then use for future bids). Long words pay a superlinear bonus, so hoarding is rewarded.

Built on [SpacetimeDB](https://spacetimedb.com): the rules, timing, and dictionary all live inside a Rust module. Bots are external clients connecting via SDK; the spectator UI is a separate React app.

## Layout

The web client lives at the repo root (standard SpacetimeDB project layout); the module is nested inside it.

| Path | What it is |
|---|---|
| `src/`, `index.html`, `vite.config.ts` | Vite + React spectator UI |
| `spacetimedb/` | Rust SpacetimeDB module — tables, views, reducers, scheduled auction tick, dictionary |
| `bot-starter/` | Node + TypeScript starter for a competing bot. Edit `src/strategy.ts` to change behaviour. |

## How the game works

- **Auction:** every 1s, the current letter closes and is awarded to the highest bidder. Sealed bids are stored in a private table, so bots cannot snoop on each other.
- **Tiebreak:** higher amount wins; on equal bids, the earlier submission wins.
- **Currency:** start at 100. Earn currency by playing words; the reward is `base_score × length_multiplier`, where the multiplier ramps from 1.0× (≤3 letters) up to 3.0× (≥7 letters).
- **Letters:** standard 98-tile Scrabble bag (no blanks). Match ends when the bag is empty. Tiles nobody bids on are returned to the bag.
- **Visibility:** the `Holding` and `BagLetter` tables are private. Bots get their own rack via the `my_rack` view; nobody can subscribe to the full bag composition or opponents' racks. The spectator UI reconstructs racks from public `AuctionResult` + `WordPlay` events.
- **Dictionary:** the [ENABLE](https://en.wikipedia.org/wiki/Moby_Project#ENABLE) wordlist (~173k words, public domain) is embedded from `spacetimedb/wordlist.txt`. Swap in TWL or SOWPODS if you have a license.

## Quick start

1. **Start a local SpacetimeDB server** in one terminal:
   ```bash
   spacetime start
   ```

2. **Run dev mode** (from repo root, another terminal):
   ```bash
   npm install
   npm run dev
   ```
   This launches `spacetime dev` (auto-builds + auto-publishes the module on file changes, regenerates client bindings) *and* the Vite client together. Edit `spacetimedb/src/lib.rs` and changes hot-reload through to the browser.

3. **Run one or more bots** (yet another terminal):
   ```bash
   cd bot-starter
   npm install
   npm run generate
   BOT_NAME=alice npm start
   ```
   Start a second bot in another terminal (`BOT_NAME=bob npm start`) so there's competition.

4. **Start the match** from the spectator UI ("Start match" button), or call the `start_match` reducer directly.

### Other npm scripts

- `npm run dev:cloud` — same as `dev` but uses maincloud (skip step 1, but slower iteration).
- `npm run publish` — one-shot publish to maincloud.
- `npm run generate` — regenerate client bindings without the watcher.
- `npm run build` / `npm run preview` — production build of the spectator.

## Writing a bot

The starter bot is intentionally small. Open `bot-starter/src/strategy.ts` and you'll find two functions:

- `decideBid(ctx)` — return how much to bid for `ctx.letter`. The starter pays slightly above face value for letters you don't have yet.
- `chooseWord(ctx)` — pick a word to play from your current rack. The starter greedily finds the longest playable word.

`ctx` includes your current balance, your rack (as a `Map<letter, count>`), and the shared dictionary.

Bots can use any language SpacetimeDB has an SDK for — TypeScript is just the starter. The reducers participants call are:

- `register_bot(name)` — one-time, claims an identity.
- `submit_bid(auction_id, amount)` — bid on the open auction. Replaces any earlier bid on the same auction.
- `submit_word(word)` — spend letters from your rack to play a word.

## Notes / known limitations

- `auction_tick` is callable by any client today. For a real tournament, gate it on the module's own identity.
- No human play — bots only.
