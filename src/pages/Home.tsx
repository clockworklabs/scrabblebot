import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type {
  Auction,
  Bot,
  Lobby,
  LobbyMember,
  Match,
  MatchParticipant,
  WordPlay,
} from "../module_bindings/types";
import {
  botNames,
  matchHistory,
  openAuctions,
  standingsByMatch,
  type BotNames,
} from "../data";
import {
  matchOutcome,
  msUntil,
  plural,
  reconstructRacks,
  type PublicRack,
} from "../util";
import { Tile } from "../Tile";
import { Standings } from "../Standings";
import { BagBar, BagCount, Panel } from "../ui";

export default function Home() {
  const { conn } = useConn();
  const now = Date.now();

  const bots = conn ? [...conn.db.bot.iter()] : [];
  const botName = botNames(conn);
  const standings = standingsByMatch(conn);
  const standingsOf = (m: Match) => standings.get(m.id) ?? [];

  const matches = conn ? [...conn.db.matchState.iter()] : [];
  matches.sort((a, b) => Number(b.id - a.id));
  const running = matches.filter((m) => m.status.tag === "Running");
  const ended = matches.filter((m) => m.status.tag === "Ended");

  // The single open lobby (there's only ever one).
  const lobby = conn
    ? [...conn.db.lobby.iter()].find((l) => l.status.tag === "Open")
    : undefined;
  const lobbyMembers =
    conn && lobby
      ? [...conn.db.lobbyMember.iter()].filter((lm) => lm.lobbyId === lobby.id)
      : [];

  // The featured live match, with racks rebuilt from its public history.
  const live = running[0];
  const history =
    conn && live ? matchHistory(conn, live.id) : { results: [], plays: [] };

  return (
    <>
      <section className="hero full">
        <div className="hero-rack" aria-label="ScrabbleBot">
          {[..."SCRABBLEBOT"].map((c, i) => (
            <Tile
              key={i}
              letter={c}
              style={{ "--i": i } as React.CSSProperties}
            />
          ))}
        </div>
        <div className="hero-body">
          <Pitch
            bots={bots.length}
            running={running.length}
            ended={ended.length}
          />
          {live ? (
            <LiveCard
              key={String(live.id)}
              match={live}
              auction={openAuctions(conn).get(live.id)}
              standings={standingsOf(live)}
              racks={reconstructRacks(
                history.results,
                history.plays,
                live.startingRackSize,
              )}
              plays={history.plays}
              others={running.slice(1)}
              botName={botName}
              now={now}
            />
          ) : (
            <IdleCard lobby={lobby} members={lobbyMembers.length} now={now} />
          )}
        </div>
      </section>

      <NextMatch lobby={lobby} members={lobbyMembers} bots={bots} now={now} />
      <RecentResults
        ended={ended}
        standingsOf={standingsOf}
        botName={botName}
      />
    </>
  );
}

function Pitch({
  bots,
  running,
  ended,
}: {
  bots: number;
  running: number;
  ended: number;
}) {
  return (
    <div>
      <h1>Buy letters, sell words, write the smartest bot.</h1>
      <p className="lede">
        Start with 5 tiles and 100 scrabble-coins. Each round a new tile goes up
        for auction, and every bot has one second to submit a private bid. The
        highest bidder buys the new tile.
      </p>
      <p className="lede">
        Play completed words to earn points and more money.
      </p>
      <p className="lede">
        How much should you spend? How much is the current letter worth to you?
        Be fast and bid wisely. Highest score wins.
      </p>
      <div className="hero-actions">
        <Link to="/team/new" className="button">
          Register a bot
        </Link>
        <Link to="/docs" className="button quiet">
          How to write a bot
        </Link>
      </div>
      <div className="hero-stats">
        <span>
          <b>{bots}</b>
          {plural(bots, "bot", "bots")} registered
        </span>
        <span>
          <b>{running}</b>
          {plural(running, "match", "matches")} running
        </span>
        <span>
          <b>{ended}</b>
          {plural(ended, "match", "matches")} completed
        </span>
      </div>
    </div>
  );
}

function IdleCard({
  lobby,
  members,
  now,
}: {
  lobby: Lobby | undefined;
  members: number;
  now: number;
}) {
  const seats = lobby ? lobby.maxSize - members : 0;
  return (
    <aside className="live-card idle" aria-label="Next match">
      <div className="live-head">
        <span className="live-title">No match running</span>
      </div>
      {lobby ? (
        <p>
          The next match starts in{" "}
          <b>{(msUntil(lobby.closesAt, now) / 1000).toFixed(0)}s</b>, with{" "}
          {seats} {plural(seats, "seat", "seats")} still open.
        </p>
      ) : (
        <p>A new lobby opens when the next match is scheduled.</p>
      )}
    </aside>
  );
}

function LiveCard({
  match,
  auction,
  standings,
  racks,
  plays,
  others,
  botName,
  now,
}: {
  match: Match;
  auction: Auction | undefined;
  standings: MatchParticipant[];
  racks: Map<bigint, PublicRack>;
  plays: WordPlay[];
  others: Match[];
  botName: BotNames;
  now: number;
}) {
  return (
    <aside className="live-card" aria-label="Live match">
      <div className="live-head">
        <span className="live-title">
          <span className="live-dot" />
          Live now
        </span>
        <Link to={`/matches/${match.id}`}>Match #{String(match.id)}</Link>
      </div>
      <div className="live-body">
        <div className="live-tile">
          {auction ? (
            <Tile key={String(auction.id)} letter={auction.letter} size="lg" />
          ) : (
            <span className="tile-slot" />
          )}
          <span className="countdown">
            {auction
              ? `${(msUntil(auction.closesAt, now) / 1000).toFixed(1)}s`
              : "—"}
          </span>
        </div>
        <Standings
          participants={standings}
          racks={racks}
          plays={plays}
          botName={botName}
          now={now}
          limit={3}
          startingRackSize={match.startingRackSize}
        />
      </div>
      <BagBar bagTotal={match.bagTotal} />
      <div className="live-foot">
        <BagCount bagTotal={match.bagTotal} />
        <Link to={`/matches/${match.id}`} className="button quiet">
          Watch match
        </Link>
      </div>
      {others.length > 0 && (
        <div className="live-others status">
          Also running:{" "}
          {others.map((m, i) => (
            <span key={String(m.id)}>
              {i > 0 && ", "}
              <Link to={`/matches/${m.id}`}>#{String(m.id)}</Link>
            </span>
          ))}
        </div>
      )}
    </aside>
  );
}

function NextMatch({
  lobby,
  members,
  bots,
  now,
}: {
  lobby: Lobby | undefined;
  members: LobbyMember[];
  bots: Bot[];
  now: number;
}) {
  if (!lobby) {
    return (
      <Panel title="Next match">
        <div className="secondary">No open lobby right now.</div>
      </Panel>
    );
  }
  const openSeats = Math.max(0, lobby.maxSize - members.length);
  return (
    <Panel title="Next match">
      <div className="lobby-head">
        <div>
          <div className="lobby-fill">
            {members.length} of {lobby.maxSize} seats filled
          </div>
          <div className="secondary">
            Match #{String(lobby.id)} · {lobby.auctionType.tag.toLowerCase()}{" "}
            auction
          </div>
        </div>
        <div>
          <div className="lobby-timer">
            {(msUntil(lobby.closesAt, now) / 1000).toFixed(0)}s
          </div>
          <div className="secondary">until it starts anyway</div>
        </div>
      </div>
      <div className="seats">
        {members.map((lm) => {
          const bot = bots.find((b) => b.id === lm.botId);
          const sim = !!bot?.isSimulated;
          return (
            <span
              key={String(lm.id)}
              className={sim ? "seat sim" : "seat"}
              title={sim ? "simulated" : "real bot"}
            >
              {bot?.name ?? `#${lm.botId}`}
            </span>
          );
        })}
        {Array.from({ length: openSeats }, (_, i) => (
          <span key={`empty-${i}`} className="seat empty">
            open seat
          </span>
        ))}
      </div>
      <p className="secondary">
        The match starts when the lobby fills with real bots, or when the timer
        runs out. Empty seats are filled with simulated bots.
      </p>
    </Panel>
  );
}

function RecentResults({
  ended,
  standingsOf,
  botName,
}: {
  ended: Match[];
  standingsOf: (m: Match) => MatchParticipant[];
  botName: BotNames;
}) {
  return (
    <Panel title="Recent results">
      {ended.length === 0 ? (
        <div className="secondary">No completed matches yet.</div>
      ) : (
        <table className="results">
          <thead>
            <tr>
              <th>Match</th>
              <th>Winner</th>
              <th className="num">Points</th>
              <th className="num">Margin</th>
            </tr>
          </thead>
          <tbody>
            {ended.slice(0, 6).map((m) => {
              const { top, winners, runnerUp } = matchOutcome(standingsOf(m));
              return (
                <tr key={String(m.id)}>
                  <td>
                    <Link to={`/matches/${m.id}`}>#{String(m.id)}</Link>
                  </td>
                  <td className="results-winner">
                    {winners.length === 0
                      ? "—"
                      : winners.map((w) => botName(w.botId)).join(" & ")}
                  </td>
                  <td className="num">{String(top)}</td>
                  <td className="num">
                    {winners.length > 1
                      ? "tie"
                      : runnerUp
                        ? `+${top - runnerUp.score}`
                        : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {ended.length > 6 && (
        <Link to="/matches" className="panel-more">
          All {ended.length} results
        </Link>
      )}
    </Panel>
  );
}
