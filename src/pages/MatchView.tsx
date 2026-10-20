import { Link, useParams } from "react-router-dom";
import { useConn } from "../connection";
import type { DbConnection } from "../module_bindings";
import type {
  Auction,
  AuctionResult,
  Match,
  MatchParticipant,
  WordPlay,
} from "../module_bindings/types";
import {
  betterPlay,
  botNames,
  matchHistory,
  openAuctions,
  standingsByMatch,
  type BotNames,
} from "../data";
import { matchOutcome, msUntil, reconstructRacks } from "../util";
import { Tile, TileWord } from "../Tile";
import { Standings } from "../Standings";
import { BagBar, BagCount, PageHeader, Panel } from "../ui";

export default function MatchView() {
  const { conn } = useConn();
  const { id } = useParams<{ id: string }>();
  const matchId = id ? BigInt(id) : null;
  if (!conn || matchId === null) return <PageHeader title="Match…" />;
  const m = conn.db.matchState.id.find(matchId);
  if (!m) return <PageHeader title="Match not found" />;

  const botName = botNames(conn);
  const participants = standingsByMatch(conn).get(matchId) ?? [];
  const { results, plays } = matchHistory(conn, matchId);
  const racks = reconstructRacks(results, plays, m.startingRackSize);

  return (
    <>
      <PageHeader
        title={`Match #${m.id}`}
        subtitle={
          <>
            {m.status.tag.toLowerCase()} · {m.auctionType.tag.toLowerCase()}{" "}
            auction · round {m.currentRound}
          </>
        }
      >
        <Link to="/matches">← all matches</Link>
        <div className="bag-progress">
          <BagBar bagTotal={m.bagTotal} />
          <BagCount bagTotal={m.bagTotal} />
        </div>
      </PageHeader>

      {m.status.tag === "Ended" ? (
        <MatchResult
          participants={participants}
          plays={plays}
          botName={botName}
        />
      ) : (
        <AuctionStage match={m} auction={openAuctions(conn).get(matchId)} />
      )}
      <Panel title="Scoreboard">
        {participants.length === 0 ? (
          <div className="secondary">No participants in this match.</div>
        ) : (
          <Standings
            participants={participants}
            racks={racks}
            plays={plays}
            botName={botName}
            now={Date.now()}
            startingRackSize={m.startingRackSize}
          />
        )}
      </Panel>
      <AuctionLog
        results={results}
        topBids={topBids(conn, matchId)}
        botName={botName}
      />
      <WordLog plays={plays} botName={botName} />
    </>
  );
}

// The winning bid on each auction, by auction id. While a match runs these
// come through the `visibleAuctionTopBids` view, which is hidden from bot
// clients. Once it ends, onMatchEnded moves them to the public
// `auctionTopBidArchive` table for replay.
function topBids(conn: DbConnection, matchId: bigint): Map<bigint, bigint> {
  const bids = new Map<bigint, bigint>();
  for (const t of conn.db.visibleAuctionTopBids.iter()) {
    if (t.matchId === matchId) bids.set(t.auctionId, t.topBid);
  }
  for (const t of conn.db.auctionTopBidArchive.iter()) {
    if (t.matchId === matchId) bids.set(t.auctionId, t.topBid);
  }
  return bids;
}

function AuctionStage({
  match,
  auction,
}: {
  match: Match;
  auction: Auction | undefined;
}) {
  return (
    <Panel title="Current auction">
      <div className="auction-stage">
        {auction ? (
          <>
            <Tile key={String(auction.id)} letter={auction.letter} size="xl" />
            <div className="countdown">
              {(msUntil(auction.closesAt, Date.now()) / 1000).toFixed(2)}s left
              to bid
            </div>
          </>
        ) : (
          <div className="countdown">
            {match.status.tag === "Lobby"
              ? "Waiting for the lobby to fill…"
              : "Waiting for the next tile…"}
          </div>
        )}
      </div>
    </Panel>
  );
}

function AuctionLog({
  results,
  topBids,
  botName,
}: {
  results: AuctionResult[];
  topBids: Map<bigint, bigint>;
  botName: BotNames;
}) {
  return (
    <Panel title="Auctions">
      {results.length === 0 ? (
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
              {[...results].reverse().map((r) => {
                const topBid = topBids.get(r.auctionId);
                return (
                  <tr key={String(r.auctionId)}>
                    <td>
                      <Tile letter={r.letter} size="xs" />
                    </td>
                    <td>
                      {r.winnerBotId !== undefined && r.winnerBotId !== null ? (
                        botName(r.winnerBotId)
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
    </Panel>
  );
}

function WordLog({ plays, botName }: { plays: WordPlay[]; botName: BotNames }) {
  return (
    <Panel title="Words played">
      {plays.length === 0 ? (
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
              {[...plays].reverse().map((p) => (
                <tr key={String(p.id)}>
                  <td>
                    <TileWord word={p.word} />
                  </td>
                  <td>{botName(p.botId)}</td>
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
    </Panel>
  );
}

function MatchResult({
  participants,
  plays,
  botName,
}: {
  participants: MatchParticipant[];
  plays: WordPlay[];
  botName: BotNames;
}) {
  const { top, winners, runnerUp } = matchOutcome(participants);
  const best = plays.reduce<WordPlay | null>(
    (acc, p) => (acc === null || betterPlay(p, acc) ? p : acc),
    null,
  );
  return (
    <Panel title="Result">
      <div className="result">
        <div className="result-label">
          {winners.length > 1 ? "Tied for first" : "Winner"}
        </div>
        <div className="result-winner">
          {winners.map((w) => botName(w.botId)).join(" & ")}
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
              {String(best.totalReward)} points to {botName(best.botId)}
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
