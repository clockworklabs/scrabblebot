import { Link } from "react-router-dom";
import { STARTER_ENV, useConn } from "../connection";
import { PageHeader, Panel } from "../ui";

export default function Docs() {
  const { dbName } = useConn();
  return (
    <>
      <PageHeader title="How to write a bot" />

      <Panel full>
        <h2>The game in one paragraph</h2>
        <p>
          Each round the module reveals one letter from a shared Scrabble bag
          and runs a <b>1-second sealed-bid auction</b>. The highest bidder wins
          the letter and adds it to their private rack. With those letters, bots
          can play any dictionary word at any time, earning currency that funds
          future bids. Long words pay a length bonus (1×→3×). A match ends when
          the bag empties. Matches are formed by a{" "}
          <Link to="/">rolling 60-second lobby</Link>: bots queue up, and either
          the lobby fills with real entrants or the timer expires and idle
          simulated bots fill empty slots.
        </p>

        <h2>Auction types</h2>
        <ul>
          <li>
            <b>Vickrey (default).</b> Winner pays the runner-up's bid.
            Truth-telling is optimal; strategy = modeling letter value.
          </li>
          <li>
            <b>First-price.</b> Winner pays their own bid. Bid shading required
            to avoid the winner's curse.
          </li>
        </ul>

        <h2>What's visible to a bot</h2>
        <ul>
          <li>
            <code>lobby</code> + <code>lobby_member</code> — the currently open
            lobby and who's queued in it.
          </li>
          <li>
            <code>match_state</code> / <code>match_participant</code> — match
            metadata and your per-match balance / score.
          </li>
          <li>
            <code>auction</code> — open auctions across matches you're in.
          </li>
          <li>
            <code>auction_result</code> — every completed auction (letter,
            winner_bot_id, top_bid, paid).
          </li>
          <li>
            <code>word_play</code> — every word played (letters used).
          </li>
          <li>
            <code>my_rack</code> view — your own letters across all matches;
            clients filter by
            <code> match_id</code>. Opponents' racks and remaining bag
            composition stay hidden, though both are derivable from public
            auction + word-play events if you're motivated.
          </li>
          <li>
            <code>bot</code> + <code>bot_credential</code> — the bots you can
            act as, plus the full list of registered bots.
          </li>
        </ul>

        <h2>Reducers you'll call</h2>
        <pre className="code-block">{`join_lobby()                                 // enter the open lobby
submit_bid(auction_id: u64, amount: i64)     // bid on an open auction
submit_word(match_id: u64, word: String)     // spend letters from rack`}</pre>
        <p className="secondary">
          You don't manually start matches — the lobby handles that. Just call{" "}
          <code>join_lobby</code> when you're free (your bot starts a new match
          or rejoins after its previous one ends).
        </p>

        <h2>Scoring</h2>
        <ul>
          <li>Letter values are standard Scrabble (A=1 … Q,Z=10).</li>
          <li>
            Base score = sum of letter values. Length multiplier: 1× for ≤3
            letters, 1.5× at 4, 2× at 5, 2.5× at 6, 3× at 7+.
          </li>
          <li>
            Reward goes into both <code>balance</code> (spendable on future
            bids) and <code>score</code> (ranking).
          </li>
          <li>
            Match ends when the shared bag empties. Tiles with no bid are
            returned to the bag.
          </li>
          <li>
            After every match, each bot's ELO rating updates pairwise based on
            relative finishing score. See{" "}
            <Link to="/leaderboard">the leaderboard</Link>.
          </li>
        </ul>

        <h2>Get a token for your bot</h2>
        <ol>
          <li>
            <Link to="/team/new">Create a team</Link> (or join an existing one).
            You'll need to link your spacetimedb.com identity from{" "}
            <Link to="/account">/account</Link> first.
          </li>
          <li>
            On your <Link to="/team">team page</Link>, click{" "}
            <b>Generate token</b>. You'll get a SpacetimeDB JWT bound to a fresh
            credential for your team's bot.
          </li>
          <li>Save that token — it's shown only once.</li>
        </ol>

        <h2>Use the token in your bot</h2>
        <p>
          The token authenticates your bot as a credential for your team's bot
          persona. Drop it into the SDK's <code>withToken()</code> call:
        </p>
        <pre className="code-block">{`import { DbConnection } from "./module_bindings";

DbConnection.builder()
  .withUri("https://maincloud.spacetimedb.com")
  .withDatabaseName("${dbName}")
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
  .build();`}</pre>

        <h2>Starter kit</h2>
        <p>
          The repo's <code>bot-starter/</code> directory is a TypeScript
          skeleton wired up with all the boilerplate above (token handling,
          lobby joining, rack tracking, match lifecycle). Edit{" "}
          <code>src/strategy.ts</code> — it has two functions you'll want to
          tune:
        </p>
        <ul>
          <li>
            <code>decideBid(ctx)</code> — returns the amount to bid on the
            current letter, given your balance and rack.
          </li>
          <li>
            <code>chooseWord(ctx)</code> — picks a word to play from your tiles,
            given the shared dictionary.
          </li>
        </ul>
        <pre className="code-block">{`git clone <repo>
cd scrabblebot/bot-starter
npm install
npm run generate

# Use the token from /team:
${STARTER_ENV}BOT_NAME=alice BOT_TOKEN=<token from /team> npm start`}</pre>
        <p className="secondary">
          The starter persists the token to <code>.token-&lt;BOT_NAME&gt;</code>{" "}
          so future runs don't need <code>BOT_TOKEN</code>. To rotate, mint a
          new token on <Link to="/team">/team</Link>.
        </p>

        <h2 id="tournaments">Tournaments</h2>
        <p>
          An admin opens a tournament for registration, and{" "}
          <Link to="/tournament">the tournament page</Link> shows its id and who
          has signed up. Your bot registers itself, from the process that plays
          for it: the module only accepts a registration from one of the bot's
          own credentials. That's why there's no Register button on the website,
          which is signed in as you, not your bot.
        </p>
        <pre className="code-block">{`# With the starter:
${STARTER_ENV}BOT_NAME=<name> TOURNAMENT_ID=<id> npm start

# From your own bot, once it's connected:
conn.reducers.registerForTournament({ tournamentId: <id>n });
// Changed your mind before it starts?
conn.reducers.unregisterFromTournament({ tournamentId: <id>n });`}</pre>
        <ul>
          <li>
            <b>Format.</b> Swiss rounds at tables of about the match size,
            scored by finishing place; bots on the same score share the place.
            Then the top bots by Swiss points play off: each elimination match
            knocks out its last-place finisher until two remain, and three final
            games decide the champion by their total score. The admin starts
            each finals match, so the finals can be followed one match at a
            time.
          </li>
          <li>
            <b>Ties.</b> Level on Swiss points at the cut, or level for last
            place in an elimination match, the bot with the higher total score
            over the tournament goes through, then the one with the lower bot
            id. There are no replays.
          </li>
          <li>
            <b>Your code doesn't change.</b> Tournament matches use the same
            tables and reducers as lobby matches, so a bot that bids on{" "}
            <code>auction.onInsert</code> and plays words when{" "}
            <code>my_rack</code> changes plays them as it is.
          </li>
          <li>
            <b>Be free when it starts.</b> The admin can't start the tournament
            while a registered bot is in the middle of a match, so the start
            waits for yours to finish.
          </li>
          <li>
            <b>No lobby matches while you're in it.</b> Once the tournament
            starts, <code>join_lobby</code> refuses its entrants until they're
            knocked out or it ends, so your bot is always free for its next
            tournament match. The starter just logs the refusal and waits.
          </li>
          <li>
            <b>Stay connected.</b> A registered bot that's offline still gets
            seated, and loses every auction it doesn't bid in.
          </li>
        </ul>

        <h2>Other languages</h2>
        <p>
          SpacetimeDB has SDKs for Rust, C#, and TypeScript. The reducer
          interface is language-agnostic; the starter is just a convenience.
          Generate bindings with{" "}
          <code>spacetime generate --lang &lt;lang&gt;</code> against this
          module.
        </p>
      </Panel>
    </>
  );
}
