import { useState } from "react";
import { Link } from "react-router-dom";
import { Identity } from "spacetimedb";
import { useConn } from "../connection";
import type { DbConnection } from "../module_bindings";
import type { Tournament } from "../module_bindings/types";
import {
  amAdmin,
  botConnected,
  humanLinkOf,
  latestTournament,
  tournamentEntries,
  tournamentMatchRunning,
} from "../data";
import { fmtDateTime } from "../util";
import { PageHeader, Panel, ShortIdentity, useAction } from "../ui";

type AuctionTypeTag = "Vickrey" | "FirstPrice";

export default function Admin() {
  const { conn, identity } = useConn();
  if (!conn || !identity) return <PageHeader title="Admin" />;

  const admins = [...conn.db.admin.iter()];
  const myHuman = humanLinkOf(conn, identity)?.humanIdentity;

  if (amAdmin(conn)) {
    return (
      <>
        <PageHeader title="Admin" status={`${admins.length} admins`} />
        <AdminList conn={conn} myHuman={myHuman} />
        <MatchDefaults
          // Start over from the saved values when they arrive.
          key={conn.db.matchmakerConfig.id.find(0) ? "saved" : "built-in"}
          conn={conn}
        />
        <RunTournament conn={conn} />
      </>
    );
  }

  if (admins.length === 0) {
    return (
      <>
        <PageHeader title="Admin" status="no admins yet" />
        <Panel full title="Claim first admin">
          <p>
            No admins are configured. Whoever clicks the button below becomes
            the first admin and can then add others.
          </p>
          {!myHuman && (
            <p className="error">
              You need to{" "}
              <Link to="/account">link your spacetimedb.com identity</Link>{" "}
              first so the admin role is bound to it.
            </p>
          )}
          <button
            className="button"
            disabled={!myHuman}
            onClick={() => conn.reducers.bootstrapAdmin({})}
          >
            Bootstrap first admin
          </button>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Admin" status="not authorized" />
      <Panel full>
        <p>
          You're not an admin. Ask one of the existing admins to add your
          spacetimedb.com identity:
        </p>
        {myHuman ? (
          <code className="code-block">{myHuman.toHexString()}</code>
        ) : (
          <p className="error">
            Also: link your spacetimedb.com identity on{" "}
            <Link to="/account">the Account page</Link> first.
          </p>
        )}
      </Panel>
    </>
  );
}

function AdminList({
  conn,
  myHuman,
}: {
  conn: DbConnection;
  myHuman: Identity | undefined;
}) {
  const [newAdminHex, setNewAdminHex] = useState("");
  const [error, setError] = useState<string | null>(null);
  const admins = [...conn.db.admin.iter()];

  function addAdmin() {
    setError(null);
    const hex = newAdminHex.trim().replace(/^0x/, "");
    if (hex.length !== 64) {
      setError("Identity should be a 64-char hex string (optional 0x prefix).");
      return;
    }
    try {
      conn.reducers.addAdmin({ humanIdentity: Identity.fromString(hex) });
      setNewAdminHex("");
    } catch (e) {
      setError(`Bad identity: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return (
    <Panel full title={`Admins (${admins.length})`}>
      <table>
        <thead>
          <tr>
            <th>Identity</th>
            <th>Added</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {admins.map((a) => {
            const isMe = myHuman ? a.humanIdentity.isEqual(myHuman) : false;
            return (
              <tr key={a.humanIdentity.toHexString()}>
                <td>
                  <ShortIdentity identity={a.humanIdentity} />
                  {isMe && <span className="secondary"> (you)</span>}
                </td>
                <td className="secondary">{fmtDateTime(a.addedAt)}</td>
                <td>
                  {!isMe && (
                    <button
                      className="button small"
                      onClick={() =>
                        conn.reducers.removeAdmin({
                          humanIdentity: a.humanIdentity,
                        })
                      }
                    >
                      Remove
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <span className="caption">
        Add an admin by spacetime.com identity (have them check{" "}
        <Link to="/account">/account</Link> for their hex):
      </span>
      <div className="field-row">
        <input
          className="input-mono"
          value={newAdminHex}
          placeholder="0xc200..."
          onChange={(e) => setNewAdminHex(e.target.value)}
        />
        <button className="button" onClick={addAdmin}>
          Add admin
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </Panel>
  );
}

// The module's built-in defaults, used until an admin saves others.
const BUILT_IN_DEFAULTS = {
  startingRackSize: 5,
  lobbyMaxSize: 6,
  auctionDurationMs: 1000n,
};

function MatchDefaults({ conn }: { conn: DbConnection }) {
  const saved = conn.db.matchmakerConfig.id.find(0) ?? BUILT_IN_DEFAULTS;
  const [auctionMs, setAuctionMs] = useState(Number(saved.auctionDurationMs));
  const [rackSize, setRackSize] = useState(saved.startingRackSize);
  const [lobbySize, setLobbySize] = useState(saved.lobbyMaxSize);
  const [error, run] = useAction();

  const numberField = (
    label: string,
    value: number,
    set: (n: number) => void,
    min: number,
    max: number,
    step = 1,
  ) => (
    <div className="row">
      <span>{label}</span>
      <input
        type="number"
        className="input-num"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => set(Number(e.target.value))}
      />
    </div>
  );

  return (
    <Panel full title="Match defaults">
      <p className="secondary">
        For matches and lobbies from now on, tournament matches included.
        Matches being played and the open lobby keep the values they started
        with.
      </p>
      {numberField(
        "Auction length (ms)",
        auctionMs,
        setAuctionMs,
        250,
        10000,
        50,
      )}
      {numberField("Starting rack size", rackSize, setRackSize, 0, 20)}
      {numberField("Lobby size", lobbySize, setLobbySize, 2, 12)}
      <div className="actions">
        <button
          className="button"
          onClick={() =>
            run(
              conn.reducers.setMatchmakerConfig({
                auctionDurationMs: BigInt(auctionMs),
                startingRackSize: rackSize,
                lobbyMaxSize: lobbySize,
              }),
            )
          }
        >
          Save
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </Panel>
  );
}

function RunTournament({ conn }: { conn: DbConnection }) {
  const current = latestTournament(conn);
  switch (current?.status.tag) {
    case "Registration":
      return <Registration conn={conn} tournament={current!} />;
    case "Swiss":
    case "Bracket":
    case "Final":
      return <Underway conn={conn} tournament={current!} />;
    default:
      return <CreateTournament conn={conn} />;
  }
}

function Underway({
  conn,
  tournament,
}: {
  conn: DbConnection;
  tournament: Tournament;
}) {
  const [error, run] = useAction();
  const [stopping, setStopping] = useState(false);
  const inFinals =
    tournament.status.tag === "Bracket" || tournament.status.tag === "Final";
  const playing = tournamentMatchRunning(conn, tournament.id);
  const tournamentId = tournament.id;

  return (
    <Panel
      full
      title={`Tournament #${tournament.id}: ${tournament.status.tag}`}
    >
      <p>
        {!inFinals
          ? tournament.currentRound === 0
            ? "Round 1 starts when the entrants still in casual matches finish them."
            : `Swiss round ${tournament.currentRound} of ${tournament.swissRoundsTotal} is being played. The finals start when you start them.`
          : playing
            ? "A finals match is being played."
            : "Waiting for you to start the next finals match."}{" "}
        <Link to="/tournament">Follow it</Link>.
      </p>
      <div className="actions">
        {inFinals && (
          <button
            className="button"
            disabled={playing}
            onClick={() =>
              run(conn.reducers.startNextFinalsMatch({ tournamentId }))
            }
          >
            Start next finals match
          </button>
        )}
        {stopping ? (
          <>
            <button
              className="button"
              onClick={() =>
                run(conn.reducers.forceEndTournament({ tournamentId }))
              }
            >
              Stop it for good
            </button>
            <button className="button quiet" onClick={() => setStopping(false)}>
              Keep it going
            </button>
          </>
        ) : (
          <button className="button quiet" onClick={() => setStopping(true)}>
            Stop the tournament
          </button>
        )}
      </div>
      {stopping && (
        <p className="secondary">
          Stopping ends the tournament with no champion. Matches being played
          finish, but don't count.
        </p>
      )}
      {error && <p className="error">{error}</p>}
    </Panel>
  );
}

function CreateTournament({ conn }: { conn: DbConnection }) {
  const [auctionType, setAuctionType] = useState<AuctionTypeTag>("Vickrey");
  const [swissRounds, setSwissRounds] = useState(4);
  const [topCut, setTopCut] = useState(8);
  const [matchSize, setMatchSize] = useState(4);
  const [error, run] = useAction();

  const numberField = (
    label: string,
    value: number,
    set: (n: number) => void,
    min: number,
    max: number,
  ) => (
    <div className="row">
      <span>{label}</span>
      <input
        type="number"
        className="input-num"
        value={value}
        min={min}
        max={max}
        onChange={(e) => set(Number(e.target.value))}
      />
    </div>
  );

  return (
    <Panel full title="Run a tournament">
      <p className="secondary">
        Swiss rounds, then a single-elimination bracket cut to the top-N.
        Creating a tournament opens it for registration; bots sign up from their
        own processes, and you start it once enough have.
      </p>
      <div className="row">
        <span>Auction type</span>
        <select
          value={auctionType}
          onChange={(e) => setAuctionType(e.target.value as AuctionTypeTag)}
          className="button"
        >
          <option value="Vickrey">Vickrey</option>
          <option value="FirstPrice">First-price</option>
        </select>
      </div>
      {numberField("Swiss rounds", swissRounds, setSwissRounds, 1, 10)}
      {numberField("Top cut", topCut, setTopCut, 2, 32)}
      {numberField("Match size", matchSize, setMatchSize, 2, 8)}
      <div className="actions">
        <button
          className="button"
          onClick={() =>
            run(
              conn.reducers.createTournament({
                swissRoundsTotal: swissRounds,
                topCut,
                matchSize,
                auctionType: { tag: auctionType },
              }),
            )
          }
        >
          Open registration
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </Panel>
  );
}

function Registration({
  conn,
  tournament,
}: {
  conn: DbConnection;
  tournament: Tournament;
}) {
  const [error, run] = useAction();
  const entries = tournamentEntries(conn, tournament.id);
  const connected = entries.filter((e) => botConnected(conn, e.botId)).length;
  const tournamentId = tournament.id;

  return (
    <Panel full title={`Tournament #${tournament.id}: registration`}>
      <p>
        {entries.length} bots registered, {connected} connected. Matches seat{" "}
        {tournament.matchSize} bots, so it needs at least that many to start.{" "}
        <Link to="/tournament">See who's in</Link>.
      </p>
      <div className="actions">
        <button
          className="button"
          onClick={() => run(conn.reducers.startTournament({ tournamentId }))}
        >
          Start tournament
        </button>
        <button
          className="button quiet"
          onClick={() => run(conn.reducers.registerSimBots({ tournamentId }))}
        >
          Enter the sim bots
        </button>
        <button
          className="button quiet"
          onClick={() => run(conn.reducers.cancelTournament({ tournamentId }))}
        >
          Cancel tournament
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </Panel>
  );
}
