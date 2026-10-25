import { Link, useParams, useSearchParams } from "react-router-dom";
import { useConn, useSubscribe } from "../connection";
import { tables } from "../module_bindings";
import { botVersions, liveBotStats } from "../data";
import {
  isProvisional,
  PROVISIONAL_ABOVE,
  skill,
  spread,
  standings,
} from "../rating";
import { RatingChart, type RatingPoint } from "../RatingChart";
import { PageHeader, Panel } from "../ui";
import { fmtTimestamp, plural, signed } from "../util";

export default function BotView() {
  const { conn } = useConn();
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const botId = id && /^\d+$/.test(id) ? BigInt(id) : null;
  // Only this bot's rating history: the whole table is a row per match, for
  // every bot that ever played.
  useSubscribe(`rating:${botId ?? ""}`, () =>
    botId === null
      ? []
      : [tables.ratingHistory.where((h) => h.botId.eq(botId))],
  );
  if (!conn) return <PageHeader title="Bot…" />;
  const bot = botId === null ? undefined : conn.db.bot.id.find(botId);
  if (!bot) return <PageHeader title="Bot not found" />;

  // The version in `?v=`, if the bot has had it, or else the current one.
  const versions = botVersions(conn);
  const current = versions.current(bot.id);
  const asked = Number(params.get("v"));
  const version =
    Number.isInteger(asked) && asked >= 1 && asked <= current ? asked : current;
  const playedBy = (matchId: bigint) => {
    const m = conn.db.matchState.id.find(matchId);
    return m ? versions.at(bot.id, fmtTimestamp(m.createdAt)) : 1;
  };

  const currentStats = conn.db.botStats.botId.find(bot.id);
  const stats =
    version === current
      ? currentStats
      : [...conn.db.retiredBotStats.iter()].find(
          (r) => r.botId === bot.id && r.version === version,
        );
  const { ranked, rankOf } = standings(liveBotStats(conn));
  const history = [...conn.db.ratingHistory.iter()]
    .filter((h) => h.botId === bot.id && playedBy(h.matchId) === version)
    .sort((a, b) => fmtTimestamp(a.at) - fmtTimestamp(b.at));
  const points: RatingPoint[] = history.map((h) => ({
    at: fmtTimestamp(h.at),
    rating: skill(h),
    spread: spread(h),
    matchId: h.matchId,
  }));

  const standing =
    version < current
      ? "Retired"
      : !currentStats
        ? "Unrated"
        : isProvisional(currentStats)
          ? `Provisional until the ± is within ${PROVISIONAL_ABOVE}`
          : `#${rankOf(currentStats)} of ${ranked.length}`;
  const summary = stats
    ? `${skill(stats)} ±${spread(stats)} · ${standing} · ${stats.wins} ${plural(stats.wins, "win", "wins")} in ${stats.matchesPlayed} ${plural(stats.matchesPlayed, "match", "matches")}`
    : standing;

  return (
    <>
      <PageHeader
        title={bot.name}
        subtitle={current > 1 ? `v${version} · ${summary}` : summary}
        status={<Link to="/leaderboard">← Leaderboard</Link>}
      />
      <Panel full title="Rating over time">
        {current > 1 && (
          <nav className="version-tabs" aria-label="Versions">
            {Array.from({ length: current }, (_, i) => i + 1).map((v) => (
              <Link
                key={v}
                to={`?v=${v}`}
                replace
                className={v === version ? "active" : undefined}
                aria-current={v === version ? "page" : undefined}
              >
                v{v}
                {v === current && " (current)"}
              </Link>
            ))}
          </nav>
        )}
        {points.length > 0 ? (
          <>
            <p className="secondary chart-caption">
              The rating after each match, with its ± as a band.
            </p>
            <RatingChart points={points} />
            <MatchTable points={points} />
          </>
        ) : (
          <div className="empty">
            {current > 1
              ? `Version ${version} hasn't finished a rated match yet.`
              : "No rated matches recorded yet."}
          </div>
        )}
      </Panel>
    </>
  );
}

// The chart's numbers as a table, newest first, folded away by default.
function MatchTable({ points }: { points: RatingPoint[] }) {
  const rows = points.map((p, i) => ({
    ...p,
    change: i > 0 ? p.rating - points[i - 1].rating : null,
  }));
  rows.reverse();
  return (
    <details className="chart-table">
      <summary>Every rated match ({points.length})</summary>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Match</th>
              <th className="num">Rating</th>
              <th className="num">Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.matchId)}>
                <td>{new Date(r.at).toLocaleString()}</td>
                <td>
                  <Link to={`/matches/${r.matchId}`}>#{String(r.matchId)}</Link>
                </td>
                <td className="num">
                  {r.rating}
                  <span className="lb-pm">±{r.spread}</span>
                </td>
                <td className="num">
                  {r.change === null ? "—" : signed(r.change)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
