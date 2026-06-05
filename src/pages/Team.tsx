import { useState } from "react";
import { Link } from "react-router-dom";
import { useConn } from "../connection";
import type { BotCredential, CredentialNonce } from "../module_bindings/types";

export default function Team() {
  const { conn, identity, version, dbName } = useConn();
  void version;
  const [minting, setMinting] = useState(false);
  const [latestNonce, setLatestNonce] = useState<string | null>(null);

  if (!conn || !identity) {
    return (
      <div className="header full">
        <h1>Team…</h1>
      </div>
    );
  }
  const team = conn.db.my_team.iter().next().value;
  if (!team) {
    return (
      <>
        <div className="header full">
          <h1>Team</h1>
        </div>
        <section className="panel full">
          <p className="secondary">
            You're not on a team. <Link to="/team/new">Create one →</Link>
          </p>
        </section>
      </>
    );
  }

  const credentials: BotCredential[] = [];
  for (const c of conn.db.bot_credential.iter()) {
    if (c.botId === team.botId) credentials.push(c);
  }
  credentials.sort(
    (a, b) =>
      Number(b.lastSeen.__timestamp_micros_since_unix_epoch__ - a.lastSeen.__timestamp_micros_since_unix_epoch__),
  );

  const myNonces: CredentialNonce[] = [];
  for (const n of conn.db.my_nonces.iter()) myNonces.push(n);
  myNonces.sort(
    (a, b) =>
      Number(b.expiresAt.__timestamp_micros_since_unix_epoch__ - a.expiresAt.__timestamp_micros_since_unix_epoch__),
  );
  const currentNonces = myNonces.filter((n) => n.botId === team.botId);

  function mintNonce() {
    if (!conn || !team) return;
    setMinting(true);
    const botId = team.botId;
    const before = new Set(currentNonces.map((n) => n.code));
    conn.reducers.mintCredentialNonce({});
    setTimeout(() => {
      const after: CredentialNonce[] = [];
      for (const n of conn.db.my_nonces.iter()) after.push(n);
      const fresh = after.find((n) => n.botId === botId && !before.has(n.code));
      setLatestNonce(fresh?.code ?? null);
      setMinting(false);
    }, 600);
  }

  return (
    <>
      <div className="header full">
        <h1>{team.teamName}</h1>
        <span className="status">{team.role.tag}</span>
      </div>

      <section className="panel">
        <h2>Bot</h2>
        <div className="row">
          <span className="name">{team.botName}</span>
          <span className="secondary">id #{String(team.botId)}</span>
        </div>
        <div className="row">
          <span>Credentials</span>
          <span>{team.credentialCount}</span>
        </div>
        <div className="row">
          <span>Active nonces</span>
          <span>{currentNonces.length}</span>
        </div>
      </section>

      <section className="panel">
        <h2>Add a credential</h2>
        <p>
          Mint a one-time code below. Plug it into your bot via{" "}
          <code>BOT_NONCE=&lt;code&gt;</code> on its first run; it'll redeem the code and
          persist a token.
        </p>
        <button className="button" onClick={mintNonce} disabled={minting}>
          {minting ? "Minting…" : "Mint credential nonce"}
        </button>
        {latestNonce && (
          <div style={{ marginTop: 16 }}>
            <div className="secondary" style={{ marginBottom: 4 }}>
              New nonce (valid 1h):
            </div>
            <code style={codeBlock}>{latestNonce}</code>
            <p className="secondary" style={{ marginTop: 8 }}>
              Use it: <code>BOT_NAME={team.botName} BOT_NONCE={latestNonce} npm start</code>
            </p>
          </div>
        )}
      </section>

      <section className="panel full">
        <h2>Credentials ({credentials.length})</h2>
        <table>
          <thead>
            <tr>
              <th>Identity</th>
              <th>Connected</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {credentials.map((c) => (
              <tr key={c.identity.toHexString()}>
                <td>
                  <code style={{ fontSize: 12 }}>
                    {c.identity.toHexString().slice(0, 16)}…
                  </code>
                </td>
                <td>{c.connected ? "● yes" : "○ no"}</td>
                <td className="secondary">
                  {new Date(
                    Number(c.lastSeen.__timestamp_micros_since_unix_epoch__) / 1000,
                  ).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {credentials.length === 0 && (
          <div className="secondary" style={{ padding: 12 }}>
            No credentials yet. Mint a nonce above and run your bot with{" "}
            <code>BOT_NONCE</code>.
          </div>
        )}
      </section>

      <section className="panel full">
        <h2>CLI mode</h2>
        <p>
          The whole flow works from CLI too — no need to use this page:
        </p>
        <pre style={preStyle}>
          {`# 1) Mint a nonce
spacetime call ${dbName} mint_credential_nonce

# 2) Read it back
spacetime sql ${dbName} "SELECT code FROM my_nonces WHERE bot_id = ${team.botId}"

# 3) Run the bot
BOT_NAME=${team.botName} BOT_NONCE=<code> npm start`}
        </pre>
      </section>

      {currentNonces.length > 0 && (
        <section className="panel full">
          <h2>Outstanding nonces</h2>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {currentNonces.map((n) => (
                <tr key={n.code}>
                  <td>
                    <code>{n.code}</code>
                  </td>
                  <td className="secondary">
                    {new Date(
                      Number(n.expiresAt.__timestamp_micros_since_unix_epoch__) / 1000,
                    ).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

const codeBlock: React.CSSProperties = {
  display: "block",
  wordBreak: "break-all",
  background: "var(--bg)",
  padding: 8,
  borderRadius: 6,
  border: "1px solid var(--border)",
  fontSize: 14,
};
const preStyle: React.CSSProperties = {
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: 12,
  overflow: "auto",
  fontSize: 13,
};
