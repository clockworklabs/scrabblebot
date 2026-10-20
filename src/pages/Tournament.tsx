import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { DbConnection } from "../module_bindings";
import type {
  Tournament as TournamentRow,
  TournamentMatch,
} from "../module_bindings/types";
import {
  botConnected,
  botNames,
  latestTournament,
  standingsByMatch,
  tournamentEntries,
  type BotNames,
} from "../data";
import { PageHeader, Panel } from "../ui";

export default function Tournament() {
  const { conn } = useConn();
  const current = latestTournament(conn);

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
  if (current.status.tag === "Registration") {
    return (
      <>
        <PageHeader
          title={`Tournament #${current.id}`}
          status={<>registration open · {current.auctionType.tag}</>}
        />
        <RegistrationView conn={conn} tournament={current} botName={botName} />
      </>
    );
  }

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

// Who has signed up so far, and whether each bot is online to play.
function RegistrationView({
  conn,
  tournament,
  botName,
}: {
  conn: DbConnection;
  tournament: TournamentRow;
  botName: BotNames;
}) {
  const rows = tournamentEntries(conn, tournament.id).map((e) => ({
    entry: e,
    sim: conn.db.bot.id.find(e.botId)?.isSimulated ?? false,
    connected: botConnected(conn, e.botId),
  }));
  rows.sort((a, b) =>
    botName(a.entry.botId).localeCompare(botName(b.entry.botId)),
  );

  return (
    <>
      <Panel full title={`Registered bots (${rows.length})`}>
        {rows.length === 0 ? (
          <div className="empty">No bots have registered yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Bot</th>
                <th>Connection</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ entry, sim, connected }) => (
                <tr key={String(entry.id)}>
                  <td>
                    {botName(entry.botId)}
                    {sim && <span className="secondary"> (sim)</span>}
                  </td>
                  <td className={connected ? undefined : "secondary"}>
                    {connected ? "connected" : "offline"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="secondary">
          Matches seat {tournament.matchSize} bots:{" "}
          {tournament.swissRoundsTotal} Swiss rounds, then the top{" "}
          {tournament.topCut} play off.
        </p>
      </Panel>
      <Panel full title="How to enter">
        <p>
          A bot registers itself, from the process that plays for it. The module
          only takes a registration from one of the bot's own credentials, so it
          can't be done from this website, which is signed in as you, not your
          bot. With the bot starter:
        </p>
        <code className="code-block">
          TOURNAMENT_ID={String(tournament.id)} npm start
        </code>
        <p className="secondary">
          More in <Link to="/docs">the bot guide</Link>.
        </p>
      </Panel>
    </>
  );
}
