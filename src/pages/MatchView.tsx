import { Link, useParams } from "react-router-dom";
import { useConn } from "../connection";
import type {
  Auction,
  AuctionResult,
  Bot,
  MatchParticipant,
  WordPlay,
} from "../module_bindings/types";
import { botName, fmtTimestamp, rackTiles, reconstructRacks } from "../util";

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
  const m = conn.db.match_state.id.find(matchId);
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
  for (const p of conn.db.match_participant.iter()) {
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
  for (const r of conn.db.auction_result.iter()) {
    if (r.matchId === matchId) allResults.push(r);
  }
  allResults.sort((a, b) => Number(a.auctionId - b.auctionId));

  const allPlays: WordPlay[] = [];
  for (const p of conn.db.word_play.iter()) {
    if (p.matchId === matchId) allPlays.push(p);
  }
  allPlays.sort((a, b) => Number(a.id - b.id));

  const racks = reconstructRacks(allResults, allPlays);

  const now = Date.now();
  const closesAtMs = auction ? fmtTimestamp(auction.closesAt) : 0;
  const msLeft = Math.max(0, closesAtMs - now);

  return (
    <>
      <div className="header full">
        <h1>
          Match #{String(m.id)}{" "}
          <span className="status">
            · {m.status.tag.toLowerCase()} · {m.auctionType.tag.toLowerCase()} · round{" "}
            {m.currentRound} · bag {m.bagTotal} left
          </span>
        </h1>
        <Link to="/matches">← all matches</Link>
      </div>

      <section className="panel">
        <h2>Current auction</h2>
        {auction ? (
          <>
            <div className="auction-letter">{auction.letter}</div>
            <div className="countdown">{(msLeft / 1000).toFixed(2)}s left</div>
          </>
        ) : (
          <div className="countdown">
            {m.status.tag === "Ended" ? "Match ended" : "Waiting…"}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Recent auctions</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Letter</th>
              <th>Winner</th>
              <th className="num">Bid</th>
              <th className="num">Paid</th>
            </tr>
          </thead>
          <tbody>
            {allResults
              .slice(-10)
              .reverse()
              .map((r) => (
                <tr key={String(r.auctionId)}>
                  <td>{String(r.auctionId)}</td>
                  <td>{r.letter}</td>
                  <td>
                    {r.winnerBotId !== undefined && r.winnerBotId !== null
                      ? botName(bots, r.winnerBotId)
                      : "no bid"}
                  </td>
                  <td className="num">{String(r.topBid)}</td>
                  <td className="num">{String(r.paid)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section className="panel full">
        <h2>Leaderboard</h2>
        {participants.map((p) => {
          const tiles = rackTiles(racks, p.botId);
          const bot = bots.find((b) => b.id === p.botId);
          return (
            <div key={String(p.id)} className="row">
              <div>
                <div className="name">{bot?.name ?? "?"}</div>
                <div className="rack">
                  {tiles.map((t, i) => (
                    <span key={i} className="tile">
                      {t}
                    </span>
                  ))}
                  {tiles.length === 0 && <span className="secondary">(no letters yet)</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div>{String(p.score)} pts</div>
                <div className="secondary">{String(p.balance)} balance</div>
              </div>
            </div>
          );
        })}
        {participants.length === 0 && (
          <div className="secondary">No participants in this match.</div>
        )}
      </section>

      <section className="panel full">
        <h2>Words played</h2>
        <table>
          <thead>
            <tr>
              <th>Bot</th>
              <th>Word</th>
              <th className="num">Base</th>
              <th className="num">Bonus</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {allPlays
              .slice(-15)
              .reverse()
              .map((p) => (
                <tr key={String(p.id)}>
                  <td>{botName(bots, p.botId)}</td>
                  <td>{p.word}</td>
                  <td className="num">{String(p.baseScore)}</td>
                  <td className="num">{String(p.bonus)}</td>
                  <td className="num">{String(p.totalReward)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
