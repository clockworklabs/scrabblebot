import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { Match, Bot } from "../module_bindings/types";
import { botName } from "../util";

export default function Matches() {
  const { conn, version } = useConn();
  void version;
  const matches: Match[] = [];
  const bots: Bot[] = [];
  if (conn) {
    for (const m of conn.db.match_state.iter()) matches.push(m);
    for (const b of conn.db.bot.iter()) bots.push(b);
  }
  matches.sort((a, b) => Number(b.id - a.id));

  return (
    <>
      <div className="header full">
        <h1>Matches</h1>
        <span className="status">{matches.length} total</span>
      </div>

      <section className="panel full">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Auction</th>
              <th>Round</th>
              <th>Bag left</th>
              <th>Participants</th>
              <th>Top score</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => {
              const participants = conn
                ? Array.from(conn.db.match_participant.iter()).filter((p) => p.matchId === m.id)
                : [];
              const top = participants.sort((a, b) => Number(b.score - a.score))[0];
              return (
                <tr key={String(m.id)}>
                  <td>
                    <Link to={`/matches/${m.id}`}>#{String(m.id)}</Link>
                  </td>
                  <td>{m.status.tag}</td>
                  <td>{m.auctionType.tag}</td>
                  <td>{m.currentRound}</td>
                  <td>{m.bagTotal}</td>
                  <td>{participants.length}</td>
                  <td>
                    {top ? `${botName(bots, top.bot)} (${String(top.score)})` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {matches.length === 0 && (
          <div className="secondary" style={{ padding: 12 }}>
            No matches yet. Go to <Link to="/admin">Admin</Link> to start one.
          </div>
        )}
      </section>
    </>
  );
}
