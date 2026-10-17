import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { TournamentMatch } from "../module_bindings/types";
import { botNames, standingsByMatch } from "../data";
import { PageHeader, Panel } from "../ui";

export default function Tournament() {
  const { conn } = useConn();
  const tournaments = conn ? [...conn.db.tournament.iter()] : [];
  tournaments.sort((a, b) => Number(b.id - a.id));
  const current = tournaments[0];

  if (!conn || !current) {
    return (
      <>
        <PageHeader title="Tournament" />
        <Panel full>
          <p className="secondary">
            No tournament has been started. Head to{" "}
            <Link to="/admin">Admin</Link> to launch one.
          </p>
        </Panel>
      </>
    );
  }

  const botName = botNames(conn);
  const standings = standingsByMatch(conn);
  const entries = [...conn.db.tournamentEntry.iter()].filter(
    (e) => e.tournamentId === current.id,
  );
  entries.sort((a, b) => b.swissPoints - a.swissPoints);
  const tmatches = [...conn.db.tournamentMatch.iter()].filter(
    (m) => m.tournamentId === current.id,
  );
  tmatches.sort((a, b) => a.round - b.round || Number(a.id - b.id));

  // Group tournament_match rows by (phase, round).
  const grouped = new Map<string, TournamentMatch[]>();
  for (const m of tmatches) {
    const key = `${m.phase.tag}:${m.round}`;
    grouped.set(key, [...(grouped.get(key) ?? []), m]);
  }

  return (
    <>
      <PageHeader
        title={`Tournament #${current.id}`}
        status={
          <>
            {current.status.tag} · {entries.length} entries ·{" "}
            {current.auctionType.tag}
          </>
        }
      />

      <Panel title="Swiss standings">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Bot</th>
              <th className="num">Pts</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={String(e.id)}>
                <td>{i + 1}</td>
                <td>{botName(e.botId)}</td>
                <td className="num">{e.swissPoints}</td>
                <td>{e.eliminated ? "eliminated" : "in"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Bracket / rounds">
        {[...grouped.entries()].map(([key, group]) => {
          const [phase, round] = key.split(":");
          return (
            <div key={key} className="round-group">
              <div className="secondary">
                {phase} round {round}
              </div>
              {group.map((tm) => {
                const m = conn.db.matchState.id.find(tm.matchId);
                const participants = standings.get(tm.matchId) ?? [];
                return (
                  <div key={String(tm.id)} className="row">
                    <div>
                      <Link to={`/matches/${tm.matchId}`}>
                        Match #{String(tm.matchId)}
                      </Link>
                      <div className="secondary">
                        {m?.status.tag ?? "?"} · {participants.length} bots
                      </div>
                    </div>
                    <div className="round-top">
                      {participants.slice(0, 3).map((p) => (
                        <div key={String(p.id)}>
                          {botName(p.botId)} · {String(p.score)}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {tmatches.length === 0 && (
          <div className="secondary">No tournament matches yet.</div>
        )}
      </Panel>
    </>
  );
}
