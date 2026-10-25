import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { Bot, BotStats, RetiredBotStats } from "../module_bindings/types";
import {
  botNames,
  botVersions,
  liveBotStats,
  type BotNames,
  type BotVersions,
} from "../data";
import {
  isProvisional,
  PROVISIONAL_ABOVE,
  skill,
  spread,
  standings,
} from "../rating";
import { PageHeader, Panel } from "../ui";

const MEDALS = ["gold", "silver", "bronze"];
const MEDAL_COLOURS = ["#fbdc8e", "#ced3e0", "#e0a272"];

export default function Leaderboard() {
  const { conn } = useConn();
  const bots = conn ? [...conn.db.bot.iter()] : [];
  const stats = liveBotStats(conn);
  const live = new Set(bots.map((b) => b.id));
  const retired = conn
    ? [...conn.db.retiredBotStats.iter()]
        .filter((r) => live.has(r.botId))
        .sort((a, b) => skill(b) - skill(a))
    : [];
  const { ranked, provisional, rankOf } = standings(stats);
  const botName = botNames(conn);
  const versions = botVersions(conn);

  const tiedAt = (rank: number) => ranked.filter((s) => rankOf(s) === rank);

  const rated = new Set(stats.map((s) => s.botId));
  const unrated = bots.filter((b) => !rated.has(b.id));

  return (
    <>
      <PageHeader
        title="Leaderboard"
        status={`${bots.length} registered bots`}
      />
      <Podium tiedAt={tiedAt} botName={botName} />
      <RatingsTable
        ranked={ranked}
        provisional={provisional}
        retired={retired}
        unrated={unrated}
        rankOf={rankOf}
        tiedAt={tiedAt}
        botName={botName}
        versions={versions}
      />
    </>
  );
}

function Podium({
  tiedAt,
  botName,
}: {
  tiedAt: (rank: number) => BotStats[];
  botName: BotNames;
}) {
  // One step per medal rank that someone actually holds. A tie for first
  // leaves no silver, so that step is simply absent.
  const steps = [1, 2, 3]
    .map((rank) => ({ rank, holders: tiedAt(rank) }))
    .filter((step) => step.holders.length > 0);
  if (steps.length === 0) return null;

  return (
    <section className="podium full" aria-label="Top three">
      {steps.map(({ rank, holders }) => {
        const solo = holders.length === 1 ? holders[0] : null;
        const names = holders.map((h) => botName(h.botId));
        return (
          <div key={rank} className={`step ${MEDALS[rank - 1]}`}>
            <div className="step-who">
              <div className="step-name" title={names.join(", ")}>
                {holders.length <= 2
                  ? names.join(" & ")
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
                {skill(holders[0])}
                <span>rating</span>
              </div>
            </div>
          </div>
        );
      })}
      <div className="podium-floor" />
    </section>
  );
}

function RatingsTable({
  ranked,
  provisional,
  retired,
  unrated,
  rankOf,
  tiedAt,
  botName,
  versions,
}: {
  ranked: BotStats[];
  provisional: BotStats[];
  retired: RetiredBotStats[];
  unrated: Bot[];
  rankOf: (s: BotStats) => number;
  tiedAt: (rank: number) => BotStats[];
  botName: BotNames;
  versions: BotVersions;
}) {
  return (
    <Panel full className="table-scroll">
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
          {[...ranked, ...provisional].map((s) => {
            const rank = isProvisional(s) ? null : rankOf(s);
            const tied = rank !== null && tiedAt(rank).length > 1;
            return (
              <tr
                key={String(s.botId)}
                className={rank === null ? "secondary" : undefined}
              >
                <td className="lb-rank">
                  {rank === null ? "—" : `${tied ? "=" : ""}${rank}`}
                  {rank !== null && rank <= 3 && (
                    <span
                      className="rank-dot"
                      style={{ background: MEDAL_COLOURS[rank - 1] }}
                      title={MEDALS[rank - 1]}
                    />
                  )}
                </td>
                <td className="lb-name">
                  <Link to={`/bots/${s.botId}`}>{botName(s.botId)}</Link>
                  <Version n={versions.current(s.botId)} />
                </td>
                <RatingCell
                  s={s}
                  note={
                    rank === null
                      ? `Provisional until the ± is within ${PROVISIONAL_ABOVE}`
                      : null
                  }
                />
                <Counts s={s} />
              </tr>
            );
          })}
          {retired.map((r) => (
            <tr key={`retired-${r.id}`} className="secondary">
              <td className="lb-rank">—</td>
              <td className="lb-name">
                <Link to={`/bots/${r.botId}?v=${r.version}`}>
                  {botName(r.botId)}
                </Link>
                <Version n={r.version} retired />
              </td>
              <RatingCell s={r} note="A retired version" />
              <Counts s={r} />
            </tr>
          ))}
          {unrated.map((b) => (
            <tr key={String(b.id)} className="secondary">
              <td className="lb-rank">—</td>
              <td className="lb-name">
                {b.name}
                <Version n={versions.current(b.id)} />
              </td>
              <td className="num">unrated</td>
              <td className="num lb-opt">0</td>
              <td className="num lb-opt">—</td>
              <td className="num">—</td>
              <td className="num">—</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ranked.length + provisional.length + retired.length + unrated.length ===
        0 && (
        <div className="empty">
          No bots registered yet. <Link to="/team/new">Create a team →</Link>
        </div>
      )}
    </Panel>
  );
}

type Stats = Pick<
  BotStats,
  | "rating"
  | "openskillMu"
  | "openskillSigma"
  | "matchesPlayed"
  | "wins"
  | "totalScore"
>;

// "v2" after a bot's name. Version 1 goes unmarked unless it's retired.
function Version({ n, retired }: { n: number; retired?: boolean }) {
  if (n === 1 && !retired) return null;
  return (
    <span className="lb-version">
      v{n}
      {retired && " · retired"}
    </span>
  );
}

function RatingCell({ s, note }: { s: Stats; note: string | null }) {
  return (
    <td
      className="num lb-rating"
      title={`${note ? `${note} · ` : ""}OpenSkill μ ${s.openskillMu.toFixed(2)}, σ ${s.openskillSigma.toFixed(2)} · Elo ${s.rating}`}
    >
      {skill(s)}
      <span className="lb-pm">±{spread(s)}</span>
    </td>
  );
}

function Counts({ s }: { s: Stats }) {
  return (
    <>
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
    </>
  );
}
