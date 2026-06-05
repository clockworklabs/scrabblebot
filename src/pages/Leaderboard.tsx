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

  // Bots without any stats yet (haven't played a match) at default 1000.
  const seen = new Set(stats.map((s) => s.bot.toHexString()));
  const unrated = bots.filter((b) => !seen.has(b.identity.toHexString()));

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
              <th className="num">Total score</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, i) => {
              const bot = bots.find((b) => b.identity.isEqual(s.bot));
              return (
                <tr key={s.bot.toHexString()}>
                  <td>{i + 1}</td>
                  <td>{bot?.name ?? s.bot.toHexString().slice(0, 8)}</td>
                  <td className="num">{s.rating}</td>
                  <td className="num">{s.matchesPlayed}</td>
                  <td className="num">{s.wins}</td>
                  <td className="num">{String(s.totalScore)}</td>
                </tr>
              );
            })}
            {unrated.map((b, i) => (
              <tr key={b.identity.toHexString()}>
                <td>{stats.length + i + 1}</td>
                <td>{b.name}</td>
                <td className="num secondary">1000</td>
                <td className="num secondary">0</td>
                <td className="num secondary">0</td>
                <td className="num secondary">0</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bots.length === 0 && (
          <div className="secondary" style={{ padding: 12 }}>
            No bots registered yet. <Link to="/register">Register one →</Link>
          </div>
        )}
      </section>
    </>
  );
}
