# How to write a bot

## The game in one paragraph

Each round the module reveals one letter from a shared Scrabble bag and runs a
**1-second sealed-bid auction**. The highest bidder wins the letter and adds it
to their private rack. With those letters, bots can play any dictionary word at
any time, earning currency that funds future bids. Long words pay a length bonus
(1×→3×). A match ends when the bag empties. Matches are formed by a
[rolling 60-second lobby](/): bots queue up, and either the lobby fills with
real entrants or the timer expires and idle simulated bots fill empty slots.

## Auction types

- **Vickrey (default).** Winner pays the runner-up's bid. Truth-telling is
  optimal; strategy = modeling letter value.
- **First-price.** Winner pays their own bid. Bid shading required to avoid the
  winner's curse.

## What's visible to a bot

- `lobby` + `lobby_member` — the currently open lobby and who's queued in it.
- `match_state` / `match_participant` — match metadata and your per-match
  balance / score.
- `auction` — open auctions across matches you're in.
- `auction_result` — every completed auction (letter, winner_bot_id, top_bid,
  paid).
- `word_play` — every word played (letters used).
- `my_rack` view — your own letters across all matches; clients filter by
  `match_id`. Opponents' racks and remaining bag composition stay hidden, though
  both are derivable from public auction + word-play events if you're
  motivated.
- `bot` + `bot_credential` — the bots you can act as, plus the full list of
  registered bots.

## Reducers you'll call

```
join_lobby()                                 // enter the open lobby
submit_bid(auction_id: u64, amount: i64)     // bid on an open auction
submit_word(match_id: u64, word: String)     // spend letters from rack
```

You don't manually start matches — the lobby handles that. Just call
`join_lobby` when you're free (your bot starts a new match or rejoins after its
previous one ends).

## Scoring

- Letter values are standard Scrabble (A=1 … Q,Z=10).
- Base score = sum of letter values. Length multiplier: 1× for ≤3 letters, 1.5×
  at 4, 2× at 5, 2.5× at 6, 3× at 7+.
- Reward goes into both `balance` (spendable on future bids) and `score`
  (ranking).
- Match ends when the shared bag empties. Tiles with no bid are returned to the
  bag.
- After every match, each bot's OpenSkill rating updates based on relative
  finishing score. Ratings are scaled like Elo, and new bots start at 1500.
  The ± after a rating is how unsure it still is, and it narrows as the bot
  plays. A bot is provisional, listed without a rank, until its ± is within
  175, which takes roughly 20 to 30 matches. See
  [the leaderboard](/leaderboard).
- Changed your bot enough that its old rating no longer fits? Anyone on your
  team can start a new version from [the Team page](/team). Its rating starts
  over at 1500, and the old version stays on the leaderboard as a retired row.
  The bot keeps its name and tokens, and you don't need to regenerate its
  bindings.

## Get a token for your bot

1. [Create a team](/team/new), or join an existing one with an invite code
   from one of its owners. You'll need to link your spacetimedb.com identity
   from [/account](/account) first.
2. On your [team page](/team), click **Generate token**. You'll get a
   SpacetimeDB JWT bound to a fresh credential for your team's bot.
3. Save that token — it's shown only once.

## Use the token in your bot

The token authenticates your bot as a credential for your team's bot persona.
Drop it into the SDK's `withToken()` call:

```ts
import { DbConnection } from "./module_bindings";

DbConnection.builder()
  .withUri("https://maincloud.spacetimedb.com")
  .withDatabaseName("{{DB_NAME}}")
  .withToken(process.env.BOT_TOKEN)   // <-- the token from /team
  .onConnect((conn, identity, token) => {
    conn.subscriptionBuilder()
      .onApplied(() => {
        // 1. Find which bot you are.
        const cred = conn.db.botCredential.identity.find(identity);
        const myBotId = cred?.botId;
        if (myBotId === undefined) {
          console.error("No bot for this token — get a fresh one from /team");
          return;
        }

        // 2. Hop into the lobby. The match starts when it fills or
        //    the 60s timer expires.
        conn.reducers.joinLobby({});
      })
      .subscribeToAllTables();

    // 3. When a new auction opens, decide your bid.
    conn.db.auction.onInsert((_ctx, a) => {
      if (a.status.tag !== "Open") return;
      // ... your strategy ...
      conn.reducers.submitBid({ auctionId: a.id, amount: BigInt(/* your bid */) });
    });

    // 4. When your rack changes, look for words you can play.
    conn.db.myRack.onUpdate(() => {
      // ... pick a word from your tiles ...
      // conn.reducers.submitWord({ matchId, word });
    });

    // 5. Re-join the lobby after each match ends.
    conn.db.matchState.onUpdate((_ctx, oldRow, newRow) => {
      if (oldRow.status.tag !== "Ended" && newRow.status.tag === "Ended") {
        conn.reducers.joinLobby({});
      }
    });
  })
  .build();
```

## Starter kit

The repo's `bot-starter/` directory is a TypeScript skeleton wired up with all
the boilerplate above (token handling, lobby joining, rack tracking, match
lifecycle). Edit `src/strategy.ts` — it has two functions you'll want to tune:

- `decideBid(ctx)` — returns the amount to bid on the current letter, given your
  balance and rack.
- `chooseWord(ctx)` — picks a word to play from your tiles, given the shared
  dictionary.

```sh
git clone https://github.com/clockworklabs/scrabblebot
cd scrabblebot/bot-starter
npm install
npm run generate

# Use the token from /team:
{{STARTER_ENV}}BOT_NAME=alice BOT_TOKEN=<token from /team> npm start
```

The starter persists the token to `.token-<BOT_NAME>` so future runs don't need
`BOT_TOKEN`. To rotate, mint a new token on [/team](/team).

## Tournaments

An admin opens a tournament for registration, and
[the tournament page](/tournament) shows its id and who has signed up. Your bot
registers itself, from the process that plays for it: the module only accepts a
registration from one of the bot's own credentials. That's why there's no
Register button on the website, which is signed in as you, not your bot.

```
# With the starter:
{{STARTER_ENV}}BOT_NAME=<name> TOURNAMENT_ID=<id> npm start

# From your own bot, once it's connected:
conn.reducers.registerForTournament({ tournamentId: <id>n });
// Changed your mind before it starts?
conn.reducers.unregisterFromTournament({ tournamentId: <id>n });
```

- **Format.** Swiss rounds at tables of about the match size, scored by
  finishing place; bots on the same score share the place. Then the top bots by
  Swiss points play off: each elimination match knocks out its last-place
  finisher until two remain, and three final games decide the champion by their
  total score. The admin starts each finals match, so the finals can be followed
  one match at a time.
- **Ties.** Level on Swiss points at the cut, or level for last place in an
  elimination match, the bot with the higher total score over the tournament
  goes through, then the one with the lower bot id. There are no replays.
- **Your code doesn't change.** Tournament matches use the same tables and
  reducers as lobby matches, so a bot that bids on `auction.onInsert` and plays
  words when `my_rack` changes plays them as it is.
- **Be free when it starts.** The admin can't start the tournament while a
  registered bot is in the middle of a match, so the start waits for yours to
  finish.
- **No lobby matches while you're in it.** Once the tournament starts,
  `join_lobby` refuses its entrants until they're knocked out or it ends, so
  your bot is always free for its next tournament match. The starter just logs
  the refusal and waits.
- **Stay connected.** A registered bot that's offline still gets seated, and
  loses every auction it doesn't bid in.

## Other languages

SpacetimeDB has SDKs for Rust, C#, and TypeScript. The reducer interface is
language-agnostic; the starter is just a convenience. Generate bindings with
`spacetime generate --lang <lang>` against this module.
