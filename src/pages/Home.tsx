import { useRef } from "react";
import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type {
  Auction,
  AuctionResult,
  Lobby,
  LobbyMember,
  Match,
  MatchParticipant,
  Bot,
  WordPlay,
} from "../module_bindings/types";
import { BAG_SIZE, fmtTimestamp, rackTiles, reconstructRacks } from "../util";
import { Rack, Tile, TileWord } from "../Tile";

// How long a freshly played word lingers under its player's score.
const WORD_FADE_MS = 4000;
// Words older than this by the server's clock were already history when the
// page loaded, so they don't get the fresh-word treatment.
const WORD_STALE_MS = 10000;

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

export default function Home() {
  const { conn, version } = useConn();
  void version;

  const matches: Match[] = [];
  const bots: Bot[] = [];
  const lobbies: Lobby[] = [];
  const allLobbyMembers: LobbyMember[] = [];
  const participantsByMatch = new Map<string, MatchParticipant[]>();
  const openAuctionByMatch = new Map<string, Auction>();
  if (conn) {
    for (const m of conn.db.matchState.iter()) matches.push(m);
    for (const b of conn.db.bot.iter()) bots.push(b);
    for (const l of conn.db.lobby.iter()) lobbies.push(l);
    for (const lm of conn.db.lobbyMember.iter()) allLobbyMembers.push(lm);
    for (const p of conn.db.matchParticipant.iter()) {
      const key = String(p.matchId);
      const list = participantsByMatch.get(key) ?? [];
      list.push(p);
      participantsByMatch.set(key, list);
    }
    for (const a of conn.db.auction.iter()) {
      if (a.status.tag === "Open") openAuctionByMatch.set(String(a.matchId), a);
    }
  }
  for (const list of participantsByMatch.values()) {
    list.sort((a, b) => Number(b.score - a.score));
  }
  const standingsOf = (m: Match) => participantsByMatch.get(String(m.id)) ?? [];

  matches.sort((a, b) => Number(b.id - a.id));
  const running = matches.filter((m) => m.status.tag === "Running");
  const ended = matches.filter((m) => m.status.tag === "Ended");

  // Racks for the featured live match, rebuilt from its public sales and plays.
  const live = running[0];
  const liveResults: AuctionResult[] = [];
  const livePlays: WordPlay[] = [];
  if (conn && live) {
    for (const r of conn.db.auctionResult.iter()) {
      if (r.matchId === live.id) liveResults.push(r);
    }
    for (const p of conn.db.wordPlay.iter()) {
      if (p.matchId === live.id) livePlays.push(p);
    }
  }
  const liveRacks = reconstructRacks(liveResults, livePlays);

  // The single open lobby (there's only ever one).
  const openLobby = lobbies.find((l) => l.status.tag === "Open");
  const openLobbyMembers = openLobby
    ? allLobbyMembers.filter((lm) => lm.lobbyId === openLobby.id)
    : [];

  function botName(botId: bigint): string {
    const b = bots.find((x) => x.id === botId);
    return b?.name ?? `#${botId}`;
  }

  const now = Date.now();
  const lobbyMsLeft = openLobby
    ? Math.max(0, fmtTimestamp(openLobby.closesAt) - now)
    : 0;

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
          <div>
            <h1>A letter auction where bots play Scrabble</h1>
            <p className="lede">
              Each round one tile goes up for auction, and every bot has one
              second to submit a sealed bid. Winners add the tile to their rack,
              play words to earn currency, and spend it bidding on the tiles
              they need next.
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
                <b>{bots.length}</b>
                {bots.length === 1 ? "bot" : "bots"} registered
              </span>
              <span>
                <b>{running.length}</b>
                {running.length === 1 ? "match" : "matches"} running
              </span>
              <span>
                <b>{ended.length}</b>
                {ended.length === 1 ? "match" : "matches"} completed
              </span>
            </div>
          </div>

          {live ? (
            <LiveCard
              key={String(live.id)}
              match={live}
              auction={openAuctionByMatch.get(String(live.id))}
              standings={standingsOf(live)}
              racks={liveRacks}
              plays={livePlays}
              others={running.slice(1)}
              botName={botName}
              now={now}
            />
          ) : (
            <aside className="live-card idle" aria-label="Next match">
              <div className="live-head">
                <span className="live-title">No match running</span>
              </div>
              {openLobby ? (
                <p>
                  The next match starts in{" "}
                  <b>{(lobbyMsLeft / 1000).toFixed(0)}s</b>, with{" "}
                  {plural(
                    openLobby.maxSize - openLobbyMembers.length,
                    "seat",
                    "seats",
                  )}{" "}
                  still open.
                </p>
              ) : (
                <p>A new lobby opens when the next match is scheduled.</p>
              )}
            </aside>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Next match</h2>
        {openLobby ? (
          <>
            <div className="lobby-head">
              <div>
                <div className="lobby-fill">
                  {openLobbyMembers.length} of {openLobby.maxSize} seats filled
                </div>
                <div className="secondary">
                  Match #{String(openLobby.id)} ·{" "}
                  {openLobby.auctionType.tag.toLowerCase()} auction
                </div>
              </div>
              <div>
                <div className="lobby-timer">
                  {(lobbyMsLeft / 1000).toFixed(0)}s
                </div>
                <div className="secondary">until it starts anyway</div>
              </div>
            </div>
            <div className="seats">
              {openLobbyMembers.map((lm) => {
                const b = bots.find((x) => x.id === lm.botId);
                const sim = !!b?.isSimulated;
                return (
                  <span
                    key={String(lm.id)}
                    className={sim ? "seat sim" : "seat"}
                    title={sim ? "simulated" : "real bot"}
                  >
                    {botName(lm.botId)}
                  </span>
                );
              })}
              {Array.from({
                length: Math.max(
                  0,
                  openLobby.maxSize - openLobbyMembers.length,
                ),
              }).map((_, i) => (
                <span key={`empty-${i}`} className="seat empty">
                  open seat
                </span>
              ))}
            </div>
            <p className="secondary">
              The match starts when the lobby fills with real bots, or when the
              timer runs out. Empty seats are filled with simulated bots.
            </p>
          </>
        ) : (
          <div className="secondary">No open lobby right now.</div>
        )}
      </section>

      <section className="panel">
        <h2>Recent results</h2>
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
                const standings = standingsOf(m);
                const top = standings[0]?.score ?? 0n;
                const winners = standings.filter((p) => p.score === top);
                const runnerUp = standings.find((p) => p.score < top);
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
      </section>
    </>
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
  racks: ReturnType<typeof reconstructRacks>;
  plays: WordPlay[];
  others: Match[];
  botName: (botId: bigint) => string;
  now: number;
}) {
  const msLeft = auction
    ? Math.max(0, fmtTimestamp(auction.closesAt) - now)
    : 0;
  const drawn = BAG_SIZE - match.bagTotal;

  // Each bot's latest word, while it's still fresh. Freshness is timed from
  // when this browser first saw the play rather than from `playedAt`, because
  // the client's clock can drift from the server's by a second or more, which
  // is most of the fade.
  const firstSeen = useRef(new Map<string, number>());
  const recentWord = new Map<string, { play: WordPlay; age: number }>();
  for (const play of plays) {
    const id = String(play.id);
    if (!firstSeen.current.has(id)) firstSeen.current.set(id, now);
    const age = now - firstSeen.current.get(id)!;
    const stale = now - fmtTimestamp(play.playedAt) > WORD_STALE_MS;
    const key = String(play.botId);
    const prev = recentWord.get(key);
    if (age < WORD_FADE_MS && !stale && (!prev || play.id > prev.play.id)) {
      recentWord.set(key, { play, age });
    }
  }

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
            {auction ? `${(msLeft / 1000).toFixed(1)}s` : "—"}
          </span>
        </div>
        <ol className="live-standings">
          {standings.slice(0, 3).map((p) => {
            const tiles = rackTiles(racks, p.botId);
            const recent = recentWord.get(String(p.botId));
            return (
              <li key={String(p.id)}>
                <div className="live-who">
                  <span className="live-name">{botName(p.botId)}</span>
                  <Rack {...tiles} className="live-rack" />
                </div>
                <div className="live-score">
                  <span className="live-points">{String(p.score)}</span>
                  {recent && (
                    // Keyed by play, so a new word starts its own fade.
                    <span
                      key={String(recent.play.id)}
                      className="live-word"
                      style={{
                        animationDuration: `${WORD_FADE_MS}ms`,
                      }}
                    >
                      <TileWord word={recent.play.word} />
                      <span className="live-word-points">
                        +{String(recent.play.totalReward)}
                      </span>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="bag-bar">
        <div style={{ width: `${(drawn / BAG_SIZE) * 100}%` }} />
      </div>
      <div className="live-foot">
        <span className="status">
          {drawn} of {BAG_SIZE} tiles drawn
        </span>
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
