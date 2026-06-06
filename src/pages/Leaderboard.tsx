import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { Bot, BotStats } from "../module_bindings/types";

export default function Leaderboard() {
  const { conn, version } = useConn();
  void version;
  const bots: Bot[] = [];
  const stats: BotStats[] = [];
  if (conn) {
    for (const b of conn.db.bot.iter()) bots.push(b);
    for (const s of conn.db.bot_stats.iter()) stats.push(s);
  }
  stats.sort((a, b) => b.rating - a.rating);

  const seen = new Set(stats.map((s) => String(s.botId)));
  const unrated = bots.filter((b) => !seen.has(String(b.id)));

  return (
    <>
      <div className="header full">
        <h1>Leaderboard</h1>
        <span className="status">{bots.length} registered bots</span>
      </div>

      <section className="panel full">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Bot</th>
              <th className="num">Rating</th>
              <th className="num">Matches</th>
              <th className="num">Wins</th>
              <th className="num">Win rate</th>
              <th className="num">Total score</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => {
              const bot = bots.find((b) => b.id === s.botId);
              return (
                <tr key={String(s.botId)}>
                  <td>{i + 1}</td>
                  <td>{bot?.name ?? `#${s.botId}`}</td>
                  <td className="num">{s.rating}</td>
                  <td className="num">{s.matchesPlayed}</td>
                  <td className="num">{s.wins}</td>
                  <td className="num">
                    {s.matchesPlayed > 0
                      ? `${((s.wins / s.matchesPlayed) * 100).toFixed(1)}%`
                      : "N/A"}
                  </td>
                  <td className="num">{String(s.totalScore)}</td>
                </tr>
              );
            })}
            {unrated.map((b, i) => (
              <tr key={String(b.id)}>
                <td>{stats.length + i + 1}</td>
                <td>{b.name}</td>
                <td className="num secondary">1000</td>
                <td className="num secondary">0</td>
                <td className="num secondary">0</td>
                <td className="num secondary">N/A</td>
                <td className="num secondary">0</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bots.length === 0 && (
          <div className="secondary" style={{ padding: 12 }}>
            No bots registered yet. <Link to="/team/new">Create a team →</Link>
          </div>
        )}
      </section>
    </>
  );
}
