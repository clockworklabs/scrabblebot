import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { Lobby, LobbyMember, Match, Bot } from "../module_bindings/types";
import { fmtTimestamp } from "../util";

export default function Home() {
  const { conn, version } = useConn();
  void version;

  const matches: Match[] = [];
  const bots: Bot[] = [];
  const lobbies: Lobby[] = [];
  const allLobbyMembers: LobbyMember[] = [];
  if (conn) {
    for (const m of conn.db.matchState.iter()) matches.push(m);
    for (const b of conn.db.bot.iter()) bots.push(b);
    for (const l of conn.db.lobby.iter()) lobbies.push(l);
    for (const lm of conn.db.lobbyMember.iter()) allLobbyMembers.push(lm);
  }
  matches.sort((a, b) => Number(b.id - a.id));
  const running = matches.filter((m) => m.status.tag === "Running");
  const ended = matches.filter((m) => m.status.tag === "Ended");

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
  const closesAtMs = openLobby ? fmtTimestamp(openLobby.closesAt) : 0;
  const msLeft = Math.max(0, closesAtMs - now);

  return (
    <>
      <div className="header full">
        <h1>ScrabbleBot</h1>
        <span className="status">
          {bots.length} bots · {running.length} running · {ended.length}{" "}
          completed
        </span>
      </div>

      <section className="panel full">
        <h2>Open lobby</h2>
        {openLobby ? (
          <>
            <div className="row">
              <div>
                <div className="name">
                  {openLobbyMembers.length} / {openLobby.maxSize} spots filled
                </div>
                <div className="secondary">
                  {openLobby.auctionType.tag} auction · match #
                  {String(openLobby.id)}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 22, fontWeight: 600 }}>
                  {(msLeft / 1000).toFixed(0)}s
                </div>
                <div className="secondary">until timeout</div>
              </div>
            </div>
            <div className="rack" style={{ marginTop: 12 }}>
              {openLobbyMembers.map((lm) => {
                const b = bots.find((x) => x.id === lm.botId);
                const sim = !!b?.isSimulated;
                return (
                  <span
                    key={String(lm.id)}
                    className="tile"
                    style={{
                      width: "auto",
                      padding: "0 10px",
                      fontWeight: 500,
                      opacity: sim ? 0.6 : 1,
                      fontSize: 13,
                    }}
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
                <span
                  key={`empty-${i}`}
                  className="tile"
                  style={{
                    width: "auto",
                    padding: "0 10px",
                    background: "transparent",
                    border: "1px dashed var(--border)",
                    color: "var(--muted)",
                    fontSize: 13,
                  }}
                >
                  empty
                </span>
              ))}
            </div>
            <p className="secondary" style={{ marginTop: 12 }}>
              Match starts when the lobby fills with real bots, or when the
              timer hits zero (empty slots get padded with simulated bots).
            </p>
          </>
        ) : (
          <div className="secondary">No open lobby right now.</div>
        )}
      </section>

      <section className="panel full">
        <h2>What is this?</h2>
        <p>
          ScrabbleBot is a Scrabble-style auction game for AI bots. Each round,
          one letter is revealed and bots have <b>1 second</b> to submit a
          sealed bid. The winner pays (depending on the auction type) and adds
          the letter to their rack. Bots play words from their collected letters
          to earn currency, which they use to bid on future tiles.
        </p>
        <p style={{ marginTop: 8 }}>
          <Link to="/team/new">Register a bot →</Link> &nbsp;
          <Link to="/docs">How to write a bot →</Link> &nbsp;
          <Link to="/leaderboard">Leaderboard →</Link>
        </p>
      </section>

      <section className="panel">
        <h2>Running matches</h2>
        {running.length === 0 && (
          <div className="secondary">None right now.</div>
        )}
        {running.slice(0, 8).map((m) => (
          <div key={String(m.id)} className="row">
            <div>
              <Link to={`/matches/${m.id}`}>Match #{String(m.id)}</Link>
              <div className="secondary">
                round {m.currentRound} · bag {m.bagTotal} ·{" "}
                {m.auctionType.tag.toLowerCase()}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Recently completed</h2>
        {ended.length === 0 && (
          <div className="secondary">No completed matches yet.</div>
        )}
        {ended.slice(0, 8).map((m) => (
          <div key={String(m.id)} className="row">
            <div>
              <Link to={`/matches/${m.id}`}>Match #{String(m.id)}</Link>
              <div className="secondary">{m.auctionType.tag.toLowerCase()}</div>
            </div>
          </div>
        ))}
      </section>
    </>
  );
}
