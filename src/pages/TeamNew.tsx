import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useConn } from "../connection";
import type { Team } from "../module_bindings/types";

type Mode = "create" | "join";

export default function TeamNew() {
  const { conn, identity, version } = useConn();
  void version;
  const navigate = useNavigate();
  const [mode, setMode] = useState<Mode>("create");
  const [teamName, setTeamName] = useState("");
  const [botName, setBotName] = useState("");
  const [joinName, setJoinName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const link =
    conn && identity ? conn.db.humanLink.web_identity.find(identity) : null;
  const linked = !!link;

  const allTeams: Team[] = [];
  if (conn) for (const t of conn.db.team.iter()) allTeams.push(t);
  allTeams.sort((a, b) => a.name.localeCompare(b.name));

  function create() {
    if (!conn) return;
    if (!teamName.trim() || !botName.trim()) {
      setError("Team and bot names required.");
      return;
    }
    setBusy(true);
    setError(null);
    conn.reducers.createTeam({
      teamName: teamName.trim(),
      botName: botName.trim(),
    });
    setTimeout(() => {
      const team = conn.db.myTeam.iter().next().value;
      if (team) navigate("/team");
      else {
        setError(
          "Failed to create team — name taken, or you're already on one?",
        );
        setBusy(false);
      }
    }, 800);
  }

  function join() {
    if (!conn) return;
    if (!joinName.trim()) {
      setError("Pick a team to join.");
      return;
    }
    setBusy(true);
    setError(null);
    conn.reducers.joinTeam({ teamName: joinName.trim() });
    setTimeout(() => {
      const team = conn.db.myTeam.iter().next().value;
      if (team) navigate("/team");
      else {
        setError(
          "Failed to join — team doesn't exist, or you're already on one?",
        );
        setBusy(false);
      }
    }, 800);
  }

  if (!linked) {
    return (
      <>
        <div className="header full">
          <h1>Link your account first</h1>
        </div>
        <section className="panel full">
          <p>
            Your team is bound to your spacetimedb.com identity so you can
            manage it from either the website or the CLI. Visit the{" "}
            <Link to="/account">Account page</Link> for one-time linking
            instructions.
          </p>
          <div style={{ marginTop: 12 }}>
            <Link
              to="/account"
              className="button"
              style={{ display: "inline-block", textDecoration: "none" }}
            >
              Go to /account →
            </Link>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <div className="header full">
        <h1>{mode === "create" ? "Create a team" : "Join a team"}</h1>
        <span>
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
        </span>
      </div>

      <section className="panel full">
        {mode === "create" ? (
          <>
            <p>
              A team is a group of humans who share ownership of one bot. You'll
              be the team's Owner. After creating, you'll mint a credential to
              plug into your bot.
            </p>
            <div style={rowStyle}>
              <label>Team name</label>
              <input
                value={teamName}
                onChange={(e) => setTeamName(e.target.value)}
                style={inputStyle}
                disabled={!linked || busy}
                placeholder="e.g. The Vowel Movement"
              />
            </div>
            <div style={rowStyle}>
              <label>Bot name</label>
              <input
                value={botName}
                onChange={(e) => setBotName(e.target.value)}
                style={inputStyle}
                disabled={!linked || busy}
                placeholder="e.g. alice"
              />
            </div>
            {error && (
              <div style={{ color: "var(--warn)", marginTop: 12 }}>{error}</div>
            )}
            <div style={{ marginTop: 16 }}>
              <button
                className="button"
                onClick={create}
                disabled={!linked || busy}
              >
                {busy ? "Creating…" : "Create team"}
              </button>
            </div>
          </>
        ) : (
          <>
            <p>
              Joining an existing team makes you a Member. You'll be able to
              mint credentials for the team's bot and play with it.
            </p>
            <div style={rowStyle}>
              <label>Team name</label>
              <input
                value={joinName}
                onChange={(e) => setJoinName(e.target.value)}
                style={inputStyle}
                disabled={!linked || busy}
                placeholder="exact team name"
                list="existing-teams"
              />
              <datalist id="existing-teams">
                {allTeams.map((t) => (
                  <option key={String(t.id)} value={t.name} />
                ))}
              </datalist>
            </div>
            {error && (
              <div style={{ color: "var(--warn)", marginTop: 12 }}>{error}</div>
            )}
            <div style={{ marginTop: 16 }}>
              <button
                className="button"
                onClick={join}
                disabled={!linked || busy}
              >
                {busy ? "Joining…" : "Join team"}
              </button>
            </div>
            {allTeams.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="secondary" style={{ marginBottom: 6 }}>
                  Existing teams:
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {allTeams.map((t) => (
                    <button
                      key={String(t.id)}
                      className="button"
                      style={{ fontSize: 12 }}
                      onClick={() => setJoinName(t.name)}
                      disabled={busy}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 12,
};
const inputStyle: React.CSSProperties = {
  background: "var(--panel)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "6px 10px",
  flex: 1,
  maxWidth: 360,
};
