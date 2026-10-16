import { Link, useParams } from "react-router-dom";
import { useConn } from "../connection";
import type {
  Auction,
  AuctionResult,
  Bot,
  MatchParticipant,
  WordPlay,
} from "../module_bindings/types";
import {
  BAG_SIZE,
  botName,
  fmtTimestamp,
  rackTiles,
  reconstructRacks,
} from "../util";
import { Rack, Tile, TileWord } from "../Tile";

export default function MatchView() {
  const { conn, version } = useConn();
  void version;
  const { id } = useParams<{ id: string }>();
  const matchId = id ? BigInt(id) : null;
  if (!conn || matchId === null) {
    return (
      <div className="header full">
        <h1>Match…</h1>
      </div>
    );
  }
  const m = conn.db.matchState.id.find(matchId);
  if (!m) {
    return (
      <div className="header full">
        <h1>Match not found</h1>
      </div>
    );
  }

  const bots: Bot[] = [];
  for (const b of conn.db.bot.iter()) bots.push(b);

  const participants: MatchParticipant[] = [];
  for (const p of conn.db.matchParticipant.iter()) {
    if (p.matchId === matchId) participants.push(p);
  }
  participants.sort((a, b) => Number(b.score - a.score));

  let auction: Auction | null = null;
  for (const a of conn.db.auction.iter()) {
    if (a.matchId === matchId && a.status.tag === "Open") {
      auction = a;
      break;
    }
  }

  const allResults: AuctionResult[] = [];
  for (const r of conn.db.auctionResult.iter()) {
    if (r.matchId === matchId) allResults.push(r);
  }
  allResults.sort((a, b) => Number(a.auctionId - b.auctionId));

  const allPlays: WordPlay[] = [];
  for (const p of conn.db.wordPlay.iter()) {
    if (p.matchId === matchId) allPlays.push(p);
  }
  allPlays.sort((a, b) => Number(a.id - b.id));

  // Live top_bids (Running matches) come through the
  // `visible_auction_top_bids` view, hidden from bot clients. Once a match
  // ends, on_match_ended moves the rows to the public
  // `auction_top_bid_archive` table for historical replay.
  const topBidByAuction = new Map<string, bigint>();
  for (const t of conn.db.visibleAuctionTopBids.iter()) {
    if (t.matchId === matchId) {
      topBidByAuction.set(String(t.auctionId), t.topBid);
    }
  }
  for (const t of conn.db.auctionTopBidArchive.iter()) {
    if (t.matchId === matchId) {
      topBidByAuction.set(String(t.auctionId), t.topBid);
    }
  }

  const racks = reconstructRacks(allResults, allPlays);

  const now = Date.now();
  const closesAtMs = auction ? fmtTimestamp(auction.closesAt) : 0;
  const msLeft = Math.max(0, closesAtMs - now);

  // Bots level on points share a rank, so a tie for first shows as a tie.
  const rankOf = (score: bigint) =>
    participants.findIndex((q) => q.score === score) + 1;
  const topScore = participants[0]?.score;
  const ended = m.status.tag === "Ended";
  const drawn = BAG_SIZE - m.bagTotal;

  return (
    <>
      <div className="header full">
        <div>
          <h1>Match #{String(m.id)}</h1>
          <span className="status">
            {m.status.tag.toLowerCase()} · {m.auctionType.tag.toLowerCase()}{" "}
            auction · round {m.currentRound}
          </span>
        </div>
        <Link to="/matches">← all matches</Link>
        <div className="bag-progress">
          <div className="bag-bar">
            <div style={{ width: `${(drawn / BAG_SIZE) * 100}%` }} />
          </div>
          <span className="status">
            {drawn} of {BAG_SIZE} tiles drawn
          </span>
        </div>
      </div>

      {ended ? (
        <MatchResult participants={participants} plays={allPlays} bots={bots} />
      ) : (
        <section className="panel">
          <h2>Current auction</h2>
          <div className="auction-stage">
            {auction ? (
              <>
                <Tile
                  key={String(auction.id)}
                  letter={auction.letter}
                  size="xl"
                />
                <div className="countdown">
                  {(msLeft / 1000).toFixed(2)}s left to bid
                </div>
              </>
            ) : (
              <div className="countdown">
                {m.status.tag === "Lobby"
                  ? "Waiting for the lobby to fill…"
                  : "Waiting for the next tile…"}
              </div>
            )}
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Scoreboard</h2>
        {participants.length === 0 ? (
          <div className="secondary">No participants in this match.</div>
        ) : (
          <table className="scoreboard">
            <thead>
              <tr>
                <th>#</th>
                <th>Bot</th>
                <th className="num">Points</th>
                <th className="num">Balance</th>
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => {
                const tiles = rackTiles(racks, p.botId);
                const leading = p.score === topScore && p.score > 0n;
                return (
                  <tr key={String(p.id)} className={leading ? "leading" : ""}>
                    <td className="sb-rank">{rankOf(p.score)}</td>
                    <td>
                      <div className="sb-name">{botName(bots, p.botId)}</div>
                      <Rack {...tiles} className="sb-rack" />
                    </td>
                    <td className="num sb-points">{String(p.score)}</td>
                    <td className="num">{String(p.balance)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <h2>Auctions</h2>
        {allResults.length === 0 ? (
          <div className="secondary">No tiles sold yet.</div>
        ) : (
          <div className="scroll-box">
            <table>
              <thead>
                <tr>
                  <th>Tile</th>
                  <th>Winner</th>
                  <th className="num">Bid</th>
                  <th className="num">Paid</th>
                </tr>
              </thead>
              <tbody>
                {allResults
                  .slice()
                  .reverse()
                  .map((r) => {
                    const topBid = topBidByAuction.get(String(r.auctionId));
                    return (
                      <tr key={String(r.auctionId)}>
                        <td>
                          <Tile letter={r.letter} size="xs" />
                        </td>
                        <td>
                          {r.winnerBotId !== undefined &&
                          r.winnerBotId !== null ? (
                            botName(bots, r.winnerBotId)
                          ) : (
                            <span className="secondary">no bid</span>
                          )}
                        </td>
                        <td className="num">
                          {topBid !== undefined ? String(topBid) : "—"}
                        </td>
                        <td className="num">{String(r.paid)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Words played</h2>
        {allPlays.length === 0 ? (
          <div className="secondary">No words played yet.</div>
        ) : (
          <div className="scroll-box">
            <table>
              <thead>
                <tr>
                  <th>Word</th>
                  <th>Bot</th>
                  <th className="num">Points</th>
                </tr>
              </thead>
              <tbody>
                {allPlays
                  .slice()
                  .reverse()
                  .map((p) => (
                    <tr key={String(p.id)}>
                      <td>
                        <TileWord word={p.word} />
                      </td>
                      <td>{botName(bots, p.botId)}</td>
                      <td
                        className="num"
                        title={`${p.baseScore} base + ${p.bonus} length bonus`}
                      >
                        {String(p.totalReward)}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function MatchResult({
  participants,
  plays,
  bots,
}: {
  participants: MatchParticipant[];
  plays: WordPlay[];
  bots: Bot[];
}) {
  const top = participants[0]?.score ?? 0n;
  const winners = participants.filter((p) => p.score === top);
  const runnerUp = participants.find((p) => p.score < top);
  const best = plays.reduce<WordPlay | null>(
    (acc, p) => (acc === null || p.totalReward > acc.totalReward ? p : acc),
    null,
  );
  return (
    <section className="panel">
      <h2>Result</h2>
      <div className="result">
        <div className="result-label">
          {winners.length > 1 ? "Tied for first" : "Winner"}
        </div>
        <div className="result-winner">
          {winners.map((w) => botName(bots, w.botId)).join(" & ")}
        </div>
        <div className="result-meta">
          {String(top)} points
          {runnerUp && winners.length === 1 && (
            <>, ahead by {String(top - runnerUp.score)}</>
          )}
        </div>
        {best && (
          <div className="result-best">
            <div className="result-label">Best word</div>
            <TileWord word={best.word} size="sm" />
            <div className="result-meta">
              {String(best.totalReward)} points to {botName(bots, best.botId)}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
