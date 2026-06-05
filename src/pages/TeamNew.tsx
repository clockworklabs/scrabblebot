import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useConn } from "../connection";

export default function TeamNew() {
  const { conn, identity, version } = useConn();
  void version;
  const navigate = useNavigate();
  const [teamName, setTeamName] = useState("");
  const [botName, setBotName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const link = conn && identity ? conn.db.human_link.web_identity.find(identity) : null;
  const linked = !!link;

  function submit() {
    if (!conn) return;
    if (!teamName.trim() || !botName.trim()) {
      setError("Team and bot names required.");
      return;
    }
    setBusy(true);
    setError(null);
    conn.reducers.createTeam({ teamName: teamName.trim(), botName: botName.trim() });
    setTimeout(() => {
      const team = conn.db.my_team.iter().next().value;
      if (team) {
        navigate("/team");
      } else {
        setError("Failed to create team — name taken or you're already on one?");
        setBusy(false);
      }
    }, 800);
  }

  return (
    <>
      <div className="header full">
        <h1>Create a team</h1>
      </div>

      <section className="panel full">
        {!linked && (
          <p style={{ color: "var(--warn)" }}>
            Link your spacetimedb.com identity first on the{" "}
            <Link to="/account">Account page</Link>. The team will be tied to your linked
            account so you can manage it from CLI later.
          </p>
        )}
        <p>
          A team is a group of humans who share ownership of one bot. You'll be the team's
          Owner. After creating, you'll mint a credential to plug into your bot.
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
        {error && <div style={{ color: "var(--warn)", marginTop: 12 }}>{error}</div>}
        <div style={{ marginTop: 16 }}>
          <button className="button" onClick={submit} disabled={!linked || busy}>
            {busy ? "Creating…" : "Create team"}
          </button>
        </div>
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
