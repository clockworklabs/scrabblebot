import { useState } from "react";
import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type {
  Match,
  MatchParticipant,
  WordPlay,
} from "../module_bindings/types";
import { bestWords, botNames, standingsByMatch, type BotNames } from "../data";
import { fmtAgo, fmtTimestamp, matchOutcome } from "../util";
import { TileWord } from "../Tile";
import { PageHeader, Panel } from "../ui";

const PAGE_SIZE = 50;

export default function Matches() {
  const { conn } = useConn();
  const [shown, setShown] = useState(PAGE_SIZE);
  const matches = conn ? [...conn.db.matchState.iter()] : [];
  matches.sort((a, b) => Number(b.id - a.id));
  const standings = standingsByMatch(conn);
  const best = bestWords(conn);
  const botName = botNames(conn);
  const now = Date.now();
  const live = matches.filter((m) => m.status.tag === "Running").length;

  return (
    <>
      <PageHeader
        title="Matches"
        status={`${matches.length} played${live > 0 ? `, ${live} live` : ""}`}
      />

      <Panel full className="table-scroll">
        <table className="match-list">
          <thead>
            <tr>
              <th>Match</th>
              <th>Winner</th>
              <th className="num ml-opt">Points</th>
              <th>Best word</th>
            </tr>
          </thead>
          <tbody>
            {matches.slice(0, shown).map((m) => (
              <MatchRow
                key={String(m.id)}
                match={m}
                standings={standings.get(m.id) ?? []}
                best={best.get(m.id)}
                botName={botName}
                now={now}
              />
            ))}
          </tbody>
        </table>
        {matches.length === 0 && (
          <div className="empty">
            No matches yet. Go to <Link to="/admin">Admin</Link> to start one.
          </div>
        )}
        {matches.length > shown && (
          <button
            className="button quiet ml-more"
            onClick={() => setShown(shown + PAGE_SIZE)}
          >
            Show {Math.min(PAGE_SIZE, matches.length - shown)} older matches
          </button>
        )}
      </Panel>
    </>
  );
}

function MatchRow({
  match,
  standings,
  best,
  botName,
  now,
}: {
  match: Match;
  standings: MatchParticipant[];
  best: WordPlay | undefined;
  botName: BotNames;
  now: number;
}) {
  const status = match.status.tag;
  const running = status === "Running";
  const { top, winners, runnerUp } = matchOutcome(standings);
  const scored = top > 0n;

  return (
    <tr className={running ? "live" : undefined}>
      <td>
        <Link to={`/matches/${match.id}`} className="ml-id">
          #{String(match.id)}
        </Link>
        <span className="ml-sub">
          {running ? (
            <span className="ml-live">
              <span className="live-dot" />
              Live
              <span className="ml-round"> · round {match.currentRound}</span>
            </span>
          ) : status === "Ended" && match.endedAt ? (
            fmtAgo(now - fmtTimestamp(match.endedAt))
          ) : (
            status.toLowerCase()
          )}
        </span>
      </td>
      <td>
        {scored ? (
          <>
            <span className="ml-winner">
              {winners.map((w) => botName(w.botId)).join(" & ")}
            </span>
            <span className="ml-sub">
              {running ? "leading" : winners.length > 1 ? "tied" : "won"}
              {winners.length === 1 && runnerUp && (
                <> by {String(top - runnerUp.score)}</>
              )}
            </span>
          </>
        ) : (
          <span className="secondary">
            {running ? "No points yet" : "Nobody scored"}
          </span>
        )}
      </td>
      <td className="num ml-opt ml-points">{scored ? String(top) : "—"}</td>
      <td>
        {best ? (
          <>
            <TileWord word={best.word} />
            <span className="ml-sub">
              <span className="ml-word-points">
                +{String(best.totalReward)}
              </span>{" "}
              {botName(best.botId)}
            </span>
          </>
        ) : (
          <span className="secondary">—</span>
        )}
      </td>
    </tr>
  );
}
