import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type {
  Bot,
  Tournament as TournamentRow,
  TournamentEntry,
  TournamentMatch,
} from "../module_bindings/types";

export default function Tournament() {
  const { conn, version } = useConn();
  void version;

  const tournaments: TournamentRow[] = [];
  if (conn) {
    for (const t of conn.db.tournament.iter()) tournaments.push(t);
  }
  tournaments.sort((a, b) => Number(b.id - a.id));
  const current = tournaments[0];

  if (!current) {
    return (
      <>
        <div className="header full">
          <h1>Tournament</h1>
        </div>
        <section className="panel full">
          <p className="secondary">
            No tournament has been started. Head to <Link to="/admin">Admin</Link> to launch one.
          </p>
        </section>
      </>
    );
  }

  const bots: Bot[] = [];
  const entries: TournamentEntry[] = [];
  const tmatches: TournamentMatch[] = [];
  if (conn) {
    for (const b of conn.db.bot.iter()) bots.push(b);
    for (const e of conn.db.tournament_entry.iter()) {
      if (e.tournamentId === current.id) entries.push(e);
    }
    for (const m of conn.db.tournament_match.iter()) {
      if (m.tournamentId === current.id) tmatches.push(m);
    }
  }
  entries.sort((a, b) => b.swissPoints - a.swissPoints);
  tmatches.sort((a, b) => a.round - b.round || Number(a.id - b.id));

  // Group tournament_match rows by (phase, round).
  const grouped = new Map<string, TournamentMatch[]>();
  for (const m of tmatches) {
    const key = `${m.phase.tag}:${m.round}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(m);
  }

  function nameOf(bot: { isEqual: (other: TournamentEntry["bot"]) => boolean }): string {
    for (const b of bots) {
      if (b.identity.toHexString() === (bot as TournamentEntry["bot"]).toHexString()) {
        return b.name;
      }
    }
    return "?";
  }

  return (
    <>
      <div className="header full">
        <h1>Tournament #{String(current.id)}</h1>
        <span className="status">
          {current.status.tag} · {entries.length} entries · {current.auctionType.tag}
        </span>
      </div>

      <section className="panel">
        <h2>Swiss standings</h2>
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
                <td>{nameOf(e.bot)}</td>
                <td className="num">{e.swissPoints}</td>
                <td>{e.eliminated ? "eliminated" : "in"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Bracket / rounds</h2>
        {Array.from(grouped.entries()).map(([key, group]) => {
          const [phase, round] = key.split(":");
          return (
            <div key={key} style={{ marginBottom: 12 }}>
              <div className="secondary" style={{ marginBottom: 4 }}>
                {phase} round {round}
              </div>
              {group.map((tm) => {
                const m = conn?.db.match_state.id.find(tm.matchId);
                const participants = conn
                  ? Array.from(conn.db.match_participant.iter())
                      .filter((p) => p.matchId === tm.matchId)
                      .sort((a, b) => Number(b.score - a.score))
                  : [];
                return (
                  <div key={String(tm.id)} className="row">
                    <div>
                      <Link to={`/matches/${tm.matchId}`}>Match #{String(tm.matchId)}</Link>
                      <div className="secondary">
                        {m?.status.tag ?? "?"} · {participants.length} bots
                      </div>
                    </div>
                    <div style={{ textAlign: "right", fontSize: 13 }}>
                      {participants.slice(0, 3).map((p) => (
                        <div key={String(p.id)}>
                          {nameOf(p.bot)} · {String(p.score)}
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
      </section>
    </>
  );
}
