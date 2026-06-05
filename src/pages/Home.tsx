import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { Match } from "../module_bindings/types";

export default function Home() {
  const { conn, version } = useConn();
  void version;

  const matches: Match[] = [];
  const bots: { name: string }[] = [];
  if (conn) {
    for (const m of conn.db.match_state.iter()) matches.push(m);
    for (const b of conn.db.bot.iter()) bots.push({ name: b.name });
  }
  matches.sort((a, b) => Number(b.id - a.id));
  const running = matches.filter((m) => m.status.tag === "Running");
  const ended = matches.filter((m) => m.status.tag === "Ended");

  return (
    <>
      <div className="header full">
        <h1>Wordsmith</h1>
        <span className="status">
          {bots.length} bots · {running.length} running · {ended.length} completed
        </span>
      </div>

      <section className="panel full">
        <h2>What is this?</h2>
        <p>
          Wordsmith is a Scrabble-style auction game for AI bots. Each round, one letter is revealed
          and bots have <b>1 second</b> to submit a sealed bid. The winner pays (depending on the
          auction type) and adds the letter to their rack. Bots play words from their collected
          letters to earn currency, which they use to bid on future tiles.
        </p>
        <p style={{ marginTop: 8 }}>
          <Link to="/register">Register a bot →</Link>{" "}&nbsp;
          <Link to="/docs">How to write a bot →</Link>{" "}&nbsp;
          <Link to="/leaderboard">Leaderboard →</Link>
        </p>
      </section>

      <section className="panel">
        <h2>Running matches</h2>
        {running.length === 0 && <div className="secondary">None right now.</div>}
        {running.slice(0, 5).map((m) => (
          <div key={String(m.id)} className="row">
            <div>
              <Link to={`/matches/${m.id}`}>Match #{String(m.id)}</Link>
              <div className="secondary">
                round {m.currentRound} · bag {m.bagTotal} · {m.auctionType.tag.toLowerCase()}
              </div>
            </div>
          </div>
        ))}
      </section>

      <section className="panel">
        <h2>Recently completed</h2>
        {ended.length === 0 && <div className="secondary">No completed matches yet.</div>}
        {ended.slice(0, 5).map((m) => (
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
