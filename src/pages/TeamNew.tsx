import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useConn } from "../connection";
import { humanLinkOf, myTeam } from "../data";
import { PageHeader, Panel } from "../ui";

type Mode = "create" | "join";

export default function TeamNew() {
  const { conn, identity } = useConn();
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("create");
  const [teamName, setTeamName] = useState("");
  const [botName, setBotName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allTeams = conn ? [...conn.db.team.iter()] : [];
  allTeams.sort((a, b) => a.name.localeCompare(b.name));

  // Call the reducer, then give it a moment and check whether we're now on a
  // team. The reducers report failure only by not changing anything.
  function submit(call: () => void, failure: string) {
    if (!conn) return;
    setBusy(true);
    setError(null);
    call();
    setTimeout(() => {
      if (myTeam(conn)) navigate("/team");
      else {
        setError(failure);
        setBusy(false);
      }
    }, 800);
  }

  function create() {
    if (!teamName.trim() || !botName.trim()) {
      setError("Team and bot names required.");
      return;
    }
    submit(
      () =>
        conn?.reducers.createTeam({
          teamName: teamName.trim(),
          botName: botName.trim(),
        }),
      "Failed to create team — name taken, or you're already on one?",
    );
  }

  function join() {
    if (!joinName.trim()) {
      setError("Pick a team to join.");
      return;
    }
    submit(
      () => conn?.reducers.joinTeam({ teamName: joinName.trim() }),
      "Failed to join — team doesn't exist, or you're already on one?",
    );
  }

  if (!humanLinkOf(conn, identity)) {
    return (
      <>
        <PageHeader title="Link your account first" />
        <Panel full>
          <p>
            Your team is bound to your spacetimedb.com identity so you can
            manage it from either the website or the CLI. Visit the{" "}
            <Link to="/account">Account page</Link> for one-time linking
            instructions.
          </p>
          <div className="actions">
            <Link to="/account" className="button">
              Go to /account →
            </Link>
          </div>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader title={mode === "create" ? "Create a team" : "Join a team"}>
        <button
          className="button"
          onClick={() => {
            setMode(mode === "create" ? "join" : "create");
            setError(null);
          }}
        >
          {mode === "create"
            ? "Join an existing team →"
            : "← Create new instead"}
        </button>
      </PageHeader>

      <Panel full>
        {mode === "create" ? (
          <>
            <p>
              A team is a group of humans who share ownership of one bot. You'll
              be the team's Owner. After creating, you'll mint a credential to
              plug into your bot.
            </p>
            <div className="field-row">
              <label>Team name</label>
              <input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                disabled={busy}
                placeholder="e.g. The Vowel Movement"
              />
            </div>
            <div className="field-row">
              <label>Bot name</label>
              <input
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                disabled={busy}
                placeholder="e.g. alice"
              />
            </div>
          </>
        ) : (
          <>
            <p>
              Joining an existing team makes you a Member. You'll be able to
              mint credentials for the team's bot and play with it.
            </p>
            <div className="field-row">
              <label>Team name</label>
              <input
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                disabled={busy}
                placeholder="exact team name"
                list="existing-teams"
              />
              <datalist id="existing-teams">
                {allTeams.map((t) => (
                  <option key={String(t.id)} value={t.name} />
                ))}
              </datalist>
            </div>
          </>
        )}
        {error && <p className="error field-error">{error}</p>}
        <div className="actions">
          {mode === "create" ? (
            <button className="button" onClick={create} disabled={busy}>
              {busy ? "Creating…" : "Create team"}
            </button>
          ) : (
            <button className="button" onClick={join} disabled={busy}>
              {busy ? "Joining…" : "Join team"}
            </button>
          )}
        </div>
        {mode === "join" && allTeams.length > 0 && (
          <>
            <span className="caption">Existing teams:</span>
            <div className="actions">
              {allTeams.map((t) => (
                <button
                  key={String(t.id)}
                  className="button small"
                  onClick={() => setJoinName(t.name)}
                  disabled={busy}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </>
        )}
      </Panel>
    </>
  );
}
