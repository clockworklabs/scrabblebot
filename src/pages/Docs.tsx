export default function Docs() {
  return (
    <>
      <div className="header full">
        <h1>How to write a bot</h1>
      </div>

      <section className="panel full">
        <h2>The game</h2>
        <p>
          Each round the module reveals one letter from a shared Scrabble bag and runs a{" "}
          <b>1-second sealed-bid auction</b>. The highest bidder wins the letter and adds it to
          their private rack. With those letters, bots can play any dictionary word at any time,
          earning currency that funds future bids. Long words pay a length bonus (1×→3×).
        </p>

        <h2 style={{ marginTop: 16 }}>Auction types</h2>
        <ul>
          <li>
            <b>Vickrey (default).</b> Winner pays the runner-up's bid. Truth-telling is optimal;
            strategy = modeling letter value.
          </li>
          <li>
            <b>First-price.</b> Winner pays their own bid. Bid shading required to avoid the
            winner's curse.
          </li>
        </ul>

        <h2 style={{ marginTop: 16 }}>What's visible to a bot</h2>
        <ul>
          <li>
            <code>auction</code> — open auctions across matches you're in.
          </li>
          <li>
            <code>auction_result</code> — every completed auction (letter, winner, bids).
          </li>
          <li>
            <code>word_play</code> — every word played (letters used).
          </li>
          <li>
            <code>match_state</code> / <code>match_participant</code> — match metadata and your
            balance / score per match.
          </li>
          <li>
            <code>my_rack</code> view — your own letters across all matches. Opponents' racks and
            the remaining bag composition stay hidden, but you can derive both from public
            auction + word-play events if you're motivated.
          </li>
        </ul>

        <h2 style={{ marginTop: 16 }}>Reducers</h2>
        <pre style={{
          background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 6, padding: 12, overflow: "auto", fontSize: 13,
        }}>{`register_bot(name)                            // one-time, claims your name
submit_bid(auction_id: u64, amount: i64)      // bid on an open auction
submit_word(match_id: u64, word: String)      // spend letters from rack
`}</pre>

        <h2 style={{ marginTop: 16 }}>Scoring</h2>
        <ul>
          <li>Letter values are standard Scrabble (A=1 … Q,Z=10).</li>
          <li>
            Base score = sum of letter values. Length multiplier: 1× for ≤3 letters, 1.5× at 4,
            2× at 5, 2.5× at 6, 3× at 7+.
          </li>
          <li>Reward goes into both <code>balance</code> (spendable) and <code>score</code>.</li>
          <li>
            Match ends when the shared bag empties. Tiles with no bid are returned to the bag.
          </li>
        </ul>

        <h2 style={{ marginTop: 16 }}>Starter kit</h2>
        <p>
          The repo at <code>bot-starter/</code> has a TypeScript bot you can fork. Edit{" "}
          <code>src/strategy.ts</code> — two functions: <code>decideBid(ctx)</code> returns a bid
          amount, <code>chooseWord(ctx)</code> picks a word from your rack.
        </p>
        <pre style={{
          background: "var(--bg)", border: "1px solid var(--border)",
          borderRadius: 6, padding: 12, overflow: "auto", fontSize: 13,
        }}>{`cd bot-starter
npm install
npm run generate
BOT_NAME=alice BOT_TOKEN=<your token> npm start`}</pre>
        <p>
          SpacetimeDB has SDKs for Rust, C#, and TypeScript — pick whatever you like; the
          reducers are language-agnostic.
        </p>
      </section>
    </>
  );
}
