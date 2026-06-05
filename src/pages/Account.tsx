import { Link } from "react-router-dom";
import { useConn } from "../connection";

export default function Account() {
  const { conn, identity, version, dbName } = useConn();
  void version;

  if (!conn || !identity) {
    return (
      <>
        <div className="header full">
          <h1>Your account</h1>
        </div>
        <section className="panel full">
          <p className="secondary">Connecting…</p>
        </section>
      </>
    );
  }

  const webHex = identity.toHexString();
  const link = conn.db.human_link.web_identity.find(identity);
  const isLinked = !!link;
  const team = conn.db.my_team.iter().next().value;

  return (
    <>
      <div className="header full">
        <h1>Your account</h1>
        <span className="status">{isLinked ? "linked" : "anonymous"}</span>
      </div>

      <section className="panel full">
        <h2>Web identity</h2>
        <div className="secondary" style={{ marginBottom: 4 }}>
          This browser is connected as:
        </div>
        <code style={{ wordBreak: "break-all" }}>{webHex}</code>
      </section>

      {!isLinked && (
        <section className="panel full">
          <h2>Link your spacetimedb.com account</h2>
          <p>
            Connect this browser to your <code>spacetime login</code> identity so you can
            manage a team and bot from either the website or the command line.
          </p>
          <pre style={preStyle}>
            spacetime call <code>{dbName}</code> connect_id {webHex}
          </pre>
          <p className="secondary">
            Run that in any terminal where <code>spacetime login</code> is configured. Then
            refresh this page.
          </p>
        </section>
      )}

      {isLinked && (
        <>
          <section className="panel">
            <h2>Linked human identity</h2>
            <code style={{ wordBreak: "break-all" }}>{link!.humanIdentity.toHexString()}</code>
            <div className="secondary" style={{ marginTop: 8 }}>
              Linked at {new Date(Number(link!.linkedAt.__timestamp_micros_since_unix_epoch__) / 1000).toLocaleString()}
            </div>
          </section>

          <section className="panel">
            <h2>Team</h2>
            {team ? (
              <>
                <div className="row">
                  <span>
                    <Link to="/team">{team.teamName}</Link>
                  </span>
                  <span className="secondary">{team.role.tag.toLowerCase()}</span>
                </div>
                <div className="row">
                  <span>Bot</span>
                  <span>{team.botName}</span>
                </div>
                <div className="row">
                  <span>Credentials</span>
                  <span>{team.credentialCount}</span>
                </div>
              </>
            ) : (
              <p className="secondary">
                You're not on a team yet. <Link to="/team/new">Create one →</Link>
              </p>
            )}
          </section>
        </>
      )}
    </>
  );
}

const preStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 12,
  overflow: "auto",
  fontSize: 13,
  wordBreak: "break-all",
};
