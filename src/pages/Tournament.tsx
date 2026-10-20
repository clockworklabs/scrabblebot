import { Link } from "react-router-dom";
import { STARTER_ENV, useConn } from "../connection";
import type { DbConnection } from "../module_bindings";
import type {
  Tournament as TournamentRow,
  TournamentEntry,
  TournamentMatch,
} from "../module_bindings/types";
import {
  amAdmin,
  botConnected,
  botNames,
  latestTournament,
  matchHistory,
  standingsByMatch,
  tournamentEntries,
  type BotNames,
} from "../data";
import { Standings } from "../Standings";
import { PageHeader, Panel, useAction } from "../ui";
import { reconstructRacks } from "../util";

// How many games the final lasts (FINAL_GAMES in the module).
const FINAL_GAMES = 3;

const STATUS_LABELS: Record<string, string> = {
  Registration: "registration open",
  Swiss: "Swiss rounds",
  Bracket: "finals",
  Final: "the final",
  Ended: "finished",
  ForceEnded: "stopped",
};

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
  const entries = tournamentEntries(conn, current.id);
  entries.sort(byStanding);
  const tmatches = [...conn.db.tournamentMatch.iter()].filter(
    (m) => m.tournamentId === current.id,
  );
  tmatches.sort((a, b) => Number(a.id - b.id));

  const header = (
    <PageHeader
      title={`Tournament #${current.id}`}
      status={
        <>
          {STATUS_LABELS[current.status.tag] ?? current.status.tag} ·{" "}
          {entries.length} entries · {current.auctionType.tag}
        </>
      }
    />
  );
  const standings = (
    <SwissStandings tournament={current} entries={entries} botName={botName} />
  );
  const rounds = <Rounds conn={conn} tmatches={tmatches} botName={botName} />;

  switch (current.status.tag) {
    case "Registration":
      return (
        <>
          {header}
          <RegistrationView
            conn={conn}
            tournament={current}
            botName={botName}
          />
        </>
      );
    case "Bracket":
    case "Final":
      return (
        <>
          {header}
          <FinalsView
            conn={conn}
            tournament={current}
            entries={entries}
            tmatches={tmatches}
            botName={botName}
          />
          {standings}
          {rounds}
        </>
      );
    case "Ended":
      return (
        <>
          {header}
          <CrownedView
            tournament={current}
            entries={entries}
            botName={botName}
          />
          {rounds}
        </>
      );
    case "ForceEnded":
      return (
        <>
          {header}
          <Panel full>
            <p>
              An admin stopped this tournament before it finished, so it has no
              champion.
            </p>
          </Panel>
          {standings}
          {rounds}
        </>
      );
    default:
      return (
        <>
          {header}
          {standings}
          {rounds}
        </>
      );
  }
}

// Standings order, as the module ranks the cut: Swiss points, then total
// score, then the lower bot id.
function byStanding(a: TournamentEntry, b: TournamentEntry): number {
  return (
    b.swissPoints - a.swissPoints ||
    Number(b.totalScore - a.totalScore) ||
    Number(a.botId - b.botId)
  );
}

function ordinal(n: number): string {
  const suffix =
    n % 100 >= 11 && n % 100 <= 13
      ? "th"
      : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

function entryStatus(e: TournamentEntry): string {
  if (e.finalFinishPosition === undefined) {
    return e.eliminated ? "cut" : "in";
  }
  return e.finalFinishPosition === 1
    ? "champion"
    : `out, ${ordinal(e.finalFinishPosition)}`;
}

function SwissStandings({
  tournament,
  entries,
  botName,
}: {
  tournament: TournamentRow;
  entries: TournamentEntry[];
  botName: BotNames;
}) {
  return (
    <Panel title="Swiss standings">
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Bot</th>
            <th className="num">Pts</th>
            <th className="num">Total</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={String(e.id)}>
              <td>{i + 1}</td>
              <td>{botName(e.botId)}</td>
              <td className="num">{e.swissPoints}</td>
              <td className="num">{String(e.totalScore)}</td>
              <td className={e.eliminated ? "secondary" : undefined}>
                {entryStatus(e)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="secondary">
        The top {tournament.topCut} after {tournament.swissRoundsTotal} rounds
        go through; ties go to total score, then the lower bot id.
      </p>
    </Panel>
  );
}

function Rounds({
  conn,
  tmatches,
  botName,
}: {
  conn: DbConnection;
  tmatches: TournamentMatch[];
  botName: BotNames;
}) {
  const standings = standingsByMatch(conn);
  // Group tournamentMatch rows by (phase, round), in the order played.
  const grouped = new Map<string, TournamentMatch[]>();
  for (const m of tmatches) {
    const key = `${m.phase.tag}:${m.round}`;
    grouped.set(key, [...(grouped.get(key) ?? []), m]);
  }

  return (
    <Panel title="Bracket / rounds">
      {[...grouped.entries()].map(([key, group]) => {
        const [phase, round] = key.split(":");
        return (
          <div key={key} className="round-group">
            <div className="secondary">
              {phase === "Final"
                ? `Final game ${round}`
                : `${phase} round ${round}`}
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
  );
}

// The finals, one match at a time: who's still in, who went out where, and
// the match being played or the one the admin starts next.
function FinalsView({
  conn,
  tournament,
  entries,
  tmatches,
  botName,
}: {
  conn: DbConnection;
  tournament: TournamentRow;
  entries: TournamentEntry[];
  tmatches: TournamentMatch[];
  botName: BotNames;
}) {
  const [error, run] = useAction();
  const alive = entries.filter((e) => !e.eliminated);
  // Places count down as bots go out, so the latest out has the best place.
  const out = entries
    .filter((e) => e.finalFinishPosition !== undefined)
    .sort((a, b) => a.finalFinishPosition! - b.finalFinishPosition!);
  const finalsMatches = tmatches.filter(
    (m) => m.phase.tag === "Bracket" || m.phase.tag === "Final",
  );
  const latest = finalsMatches[finalsMatches.length - 1];
  const latestMatch = latest && conn.db.matchState.id.find(latest.matchId);
  const playing = latestMatch?.status.tag === "Running";
  const inFinal = tournament.status.tag === "Final";
  const games = finalsMatches.filter((m) => m.phase.tag === "Final");
  const next = inFinal
    ? `game ${games.length + 1} of the final`
    : "the next elimination match";

  return (
    <>
      <Panel full title={inFinal ? "The final" : "Finals"}>
        {playing && latest ? (
          <>
            <p>
              {latest.phase.tag === "Final"
                ? `Game ${latest.round} of ${FINAL_GAMES}: the best score over all three wins.`
                : `Elimination match ${latest.round}: last place goes out.`}{" "}
              <Link to={`/matches/${latest.matchId}`}>Watch it</Link>.
            </p>
            <LiveStandings
              conn={conn}
              matchId={latest.matchId}
              botName={botName}
            />
          </>
        ) : (
          <>
            {out[0] && (
              <p className="lede">
                {botName(out[0].botId)} is out, in{" "}
                {ordinal(out[0].finalFinishPosition!)} place.
              </p>
            )}
            {amAdmin(conn) ? (
              <div className="actions">
                <button
                  className="button"
                  onClick={() =>
                    run(
                      conn.reducers.startNextFinalsMatch({
                        tournamentId: tournament.id,
                      }),
                    )
                  }
                >
                  Start {next}
                </button>
              </div>
            ) : (
              <p className="secondary">
                Waiting for the admin to start {next}.
              </p>
            )}
            {error && <p className="error">{error}</p>}
          </>
        )}
        {inFinal && (
          <FinalScores
            conn={conn}
            games={games}
            finalists={alive}
            botName={botName}
          />
        )}
      </Panel>
      <Panel title="Finalists">
        <table>
          <tbody>
            {alive.map((e) => (
              <tr key={String(e.id)}>
                <td>{botName(e.botId)}</td>
                <td className="secondary">still in</td>
              </tr>
            ))}
            {out.map((e) => (
              <tr key={String(e.id)} className="secondary">
                <td>
                  <s>{botName(e.botId)}</s>
                </td>
                <td>out, {ordinal(e.finalFinishPosition!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}

function LiveStandings({
  conn,
  matchId,
  botName,
}: {
  conn: DbConnection;
  matchId: bigint;
  botName: BotNames;
}) {
  const participants = standingsByMatch(conn).get(matchId) ?? [];
  const { results, plays } = matchHistory(conn, matchId);
  const rackSize = conn.db.matchState.id.find(matchId)?.startingRackSize ?? 0;
  return (
    <Standings
      participants={participants}
      racks={reconstructRacks(results, plays, rackSize)}
      startingRackSize={rackSize}
      plays={plays}
      botName={botName}
      now={Date.now()}
    />
  );
}

// Each finalist's score in each game of the final, and over all of them.
function FinalScores({
  conn,
  games,
  finalists,
  botName,
}: {
  conn: DbConnection;
  games: TournamentMatch[];
  finalists: TournamentEntry[];
  botName: BotNames;
}) {
  const scoreIn = (matchId: bigint, botId: bigint) =>
    (standingsByMatch(conn).get(matchId) ?? []).find((p) => p.botId === botId)
      ?.score;
  return (
    <table>
      <thead>
        <tr>
          <th>Bot</th>
          {Array.from({ length: FINAL_GAMES }, (_, i) => (
            <th key={i} className="num">
              Game {i + 1}
            </th>
          ))}
          <th className="num">Total</th>
        </tr>
      </thead>
      <tbody>
        {finalists.map((e) => {
          const scores = games.map((g) => scoreIn(g.matchId, e.botId) ?? 0n);
          return (
            <tr key={String(e.id)}>
              <td>{botName(e.botId)}</td>
              {Array.from({ length: FINAL_GAMES }, (_, i) => (
                <td key={i} className="num">
                  {i < scores.length ? String(scores[i]) : ""}
                </td>
              ))}
              <td className="num">
                {String(scores.reduce((sum, s) => sum + s, 0n))}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const MEDALS = ["gold", "silver", "bronze"];

// The champion and the podium, then everyone's final place: finalists by
// where they finished, the rest in Swiss order.
function CrownedView({
  tournament,
  entries,
  botName,
}: {
  tournament: TournamentRow;
  entries: TournamentEntry[];
  botName: BotNames;
}) {
  const placed = entries
    .filter((e) => e.finalFinishPosition !== undefined)
    .sort((a, b) => a.finalFinishPosition! - b.finalFinishPosition!);
  const rest = entries.filter((e) => e.finalFinishPosition === undefined);

  return (
    <>
      <Panel full>
        <p className="secondary">Champion</p>
        <h1>{botName(tournament.winnerBotId)}</h1>
      </Panel>
      <section className="podium full" aria-label="Top three">
        {placed.slice(0, 3).map((e, i) => (
          <div key={String(e.id)} className={`step ${MEDALS[i]}`}>
            <div className="step-who">
              <div className="step-name">{botName(e.botId)}</div>
              <div className="step-meta">{e.swissPoints} Swiss pts</div>
            </div>
            <div className="step-block">
              <div className="step-rank">{i + 1}</div>
              <div className="step-rating">
                {String(e.totalScore)}
                <span>points</span>
              </div>
            </div>
          </div>
        ))}
        <div className="podium-floor" />
      </section>
      <Panel full title="Final standings">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Bot</th>
              <th className="num">Swiss pts</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {[...placed, ...rest].map((e, i) => (
              <tr
                key={String(e.id)}
                className={i < placed.length ? undefined : "secondary"}
              >
                <td>{i + 1}</td>
                <td>{botName(e.botId)}</td>
                <td className="num">{e.swissPoints}</td>
                <td className="num">{String(e.totalScore)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
          {STARTER_ENV}BOT_NAME=&lt;name&gt; TOURNAMENT_ID=
          {String(tournament.id)} npm start
        </code>
        <p className="secondary">
          More in <Link to="/docs">the bot guide</Link>.
        </p>
      </Panel>
    </>
  );
}
