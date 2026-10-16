import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { Bot, BotStats } from "../module_bindings/types";

const MEDALS = ["gold", "silver", "bronze"];
const MEDAL_COLOURS = ["#fbdc8e", "#ced3e0", "#e0a272"];

export default function Leaderboard() {
  const { conn, version } = useConn();
  void version;
  const bots: Bot[] = [];
  const stats: BotStats[] = [];
  if (conn) {
    for (const b of conn.db.bot.iter()) bots.push(b);
    for (const s of conn.db.botStats.iter()) stats.push(s);
  }
  stats.sort((a, b) => b.rating - a.rating);

  const nameOf = (botId: bigint) =>
    bots.find((b) => b.id === botId)?.name ?? `#${botId}`;

  // Standard competition ranking: bots on the same rating share a rank, and
  // the next rank skips past them (1, 2, 3, 3, 3, 6).
  const rankOf = (s: BotStats) =>
    stats.findIndex((x) => x.rating === s.rating) + 1;
  const tiedAt = (rank: number) => stats.filter((s) => rankOf(s) === rank);

  // One podium step per medal rank that someone actually holds. A tie for
  // first leaves no silver, so that step is simply absent.
  const podium = [1, 2, 3]
    .map((rank) => ({ rank, holders: tiedAt(rank) }))
    .filter((step) => step.holders.length > 0);

  const seen = new Set(stats.map((s) => String(s.botId)));
  const unrated = bots.filter((b) => !seen.has(String(b.id)));

  return (
    <>
      <div className="header full">
        <h1>Leaderboard</h1>
        <span className="status">{bots.length} registered bots</span>
      </div>

      {podium.length > 0 && (
        <section className="podium full" aria-label="Top three">
          {podium.map(({ rank, holders }) => {
            const solo = holders.length === 1 ? holders[0] : null;
            return (
              <div key={rank} className={`step ${MEDALS[rank - 1]}`}>
                <div className="step-who">
                  <div
                    className="step-name"
                    title={holders.map((h) => nameOf(h.botId)).join(", ")}
                  >
                    {holders.length <= 2
                      ? holders.map((h) => nameOf(h.botId)).join(" & ")
                      : `${holders.length} bots tied`}
                  </div>
                  <div className="step-meta">
                    {solo
                      ? `${solo.wins} wins · ${solo.matchesPlayed} played`
                      : "tied on rating"}
                  </div>
                </div>
                <div className="step-block">
                  <div className="step-rank">{rank}</div>
                  <div className="step-rating">
                    {holders[0].rating}
                    <span>rating</span>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="podium-floor" />
        </section>
      )}

      <section className="panel full table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Bot</th>
              <th className="num">Rating</th>
              <th className="num lb-opt">Played</th>
              <th className="num lb-opt">Wins</th>
              <th className="num">Win rate</th>
              <th className="num">Avg score</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s) => {
              const rank = rankOf(s);
              const tied = tiedAt(rank).length > 1;
              const mu = s.openskillMu;
              const sigma = s.openskillSigma;
              return (
                <tr key={String(s.botId)}>
                  <td className="lb-rank">
                    {tied ? "=" : ""}
                    {rank}
                    {rank <= 3 && (
                      <span
                        className="rank-dot"
                        style={{ background: MEDAL_COLOURS[rank - 1] }}
                        title={MEDALS[rank - 1]}
                      />
                    )}
                  </td>
                  <td className="lb-name">{nameOf(s.botId)}</td>
                  <td
                    className="num lb-rating"
                    title={`OpenSkill μ ${mu.toFixed(2)}, σ ${sigma.toFixed(2)} (conservative ${(mu - 3 * sigma).toFixed(2)})`}
                  >
                    {s.rating}
                  </td>
                  <td className="num lb-opt">{s.matchesPlayed}</td>
                  <td className="num lb-opt">{s.wins}</td>
                  <td className="num">
                    {s.matchesPlayed > 0
                      ? `${((s.wins / s.matchesPlayed) * 100).toFixed(0)}%`
                      : "—"}
                  </td>
                  <td className="num">
                    {s.matchesPlayed > 0
                      ? (Number(s.totalScore) / s.matchesPlayed).toFixed(1)
                      : "—"}
                  </td>
                </tr>
              );
            })}
            {unrated.map((b) => (
              <tr key={String(b.id)} className="secondary">
                <td className="lb-rank">—</td>
                <td className="lb-name">{b.name}</td>
                <td className="num">unrated</td>
                <td className="num lb-opt">0</td>
                <td className="num lb-opt">—</td>
                <td className="num">—</td>
                <td className="num">—</td>
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
