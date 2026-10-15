import { useState } from "react";
import { Link } from "react-router-dom";
import { useConn } from "../connection";
import { DbConnection } from "../module_bindings";
import type { BotCredential } from "../module_bindings/types";

const HOST =
  import.meta.env.VITE_STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = import.meta.env.VITE_STDB_DB ?? "scrabblebot";

type GenStatus = "idle" | "minting" | "claiming" | "done" | "error";

export default function Team() {
  const { conn, identity, version } = useConn();
  void version;
  const [gen, setGen] = useState<GenStatus>("idle");
  const [genError, setGenError] = useState<string | null>(null);
  const [genToken, setGenToken] = useState<string | null>(null);
  const [genIdentity, setGenIdentity] = useState<string | null>(null);

  if (!conn || !identity) {
    return (
      <div className="header full">
        <h1>Team…</h1>
      </div>
    );
  }
  const team = conn.db.myTeam.iter().next().value;
  if (!team) {
    return (
      <>
        <div className="header full">
          <h1>Team</h1>
        </div>
        <section className="panel full">
          <p className="secondary">
            You're not on a team.{" "}
            <Link to="/team/new">Create or join one →</Link>
          </p>
        </section>
      </>
    );
  }

  const credentials: BotCredential[] = [];
  for (const c of conn.db.botCredential.iter()) {
    if (c.botId === team.botId) credentials.push(c);
  }
  credentials.sort((a, b) =>
    Number(
      b.lastSeen.__timestamp_micros_since_unix_epoch__ -
        a.lastSeen.__timestamp_micros_since_unix_epoch__,
    ),
  );

  // Mint a nonce → open a fresh anon connection → redeem it →
  // hand the user the resulting token.
  async function generateToken() {
    if (!conn) return;
    setGen("minting");
    setGenError(null);
    setGenToken(null);
    setGenIdentity(null);

    const before = new Set<string>();
    for (const n of conn.db.myNonces.iter()) before.add(n.code);
    conn.reducers.mintCredentialNonce({});

    // Wait briefly for the nonce row to land in my_nonces.
    let code: string | null = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      for (const n of conn.db.myNonces.iter()) {
        if (n.botId === team!.botId && !before.has(n.code)) {
          code = n.code;
          break;
        }
      }
      if (code) break;
    }
    if (!code) {
      setGen("error");
      setGenError("Couldn't read the freshly-minted nonce. Try again?");
      return;
    }

    // Open a fresh anonymous connection — no saved token, no shared identity.
    setGen("claiming");
    const freshConn = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .onConnect((c, id, token) => {
        setGenIdentity(id.toHexString());
        setGenToken(token); // capture before disconnecting
        c.subscriptionBuilder()
          .onApplied(() => {
            c.reducers.claimCredential({ code: code! });
            // Give the credential a moment to land, then verify.
            setTimeout(() => {
              const ok = !!c.db.botCredential.identity.find(id);
              if (ok) {
                setGen("done");
              } else {
                setGen("error");
                setGenError("Claim didn't take. Refresh and try again?");
              }
              try {
                c.disconnect();
              } catch {
                /* */
              }
            }, 1200);
          })
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => {
        setGen("error");
        setGenError(`Couldn't open fresh connection: ${err.message}`);
      })
      .build();
    void freshConn;
  }

  return (
    <>
      <div className="header full">
        <h1>{team.teamName}</h1>
        <span className="status">{team.role.tag}</span>
      </div>

      <section className="panel full">
        <h2>Bot: {team.botName}</h2>
        <div className="secondary">
          id #{String(team.botId)} · {credentials.length} credentials ·{" "}
          {credentials.filter((c) => c.connected).length} currently connected
        </div>
      </section>

      <section className="panel full">
        <h2>Generate a token for your bot</h2>
        <p>
          One click and you'll get a SpacetimeDB token bound to a new credential
          for your bot. Plug it into your bot's <code>withToken(...)</code> call
          and you're done.
        </p>

        {gen === "idle" && (
          <button className="button" onClick={generateToken}>
            Generate token
          </button>
        )}
        {gen === "minting" && <div className="secondary">Minting nonce…</div>}
        {gen === "claiming" && (
          <div className="secondary">Claiming credential…</div>
        )}
        {gen === "error" && (
          <>
            <div style={{ color: "var(--warn)", marginBottom: 8 }}>
              {genError}
            </div>
            <button className="button" onClick={() => setGen("idle")}>
              Try again
            </button>
          </>
        )}
        {gen === "done" && genToken && (
          <div style={{ marginTop: 12 }}>
            <div className="secondary" style={{ marginBottom: 4 }}>
              Bot identity (this credential's identity):
            </div>
            <code style={codeBlock}>{genIdentity}</code>
            <div className="secondary" style={{ margin: "12px 0 4px" }}>
              Token — save this. It will only be shown once.
            </div>
            <code style={codeBlock}>{genToken}</code>
            <p className="secondary" style={{ marginTop: 12 }}>
              Use in your bot:
              <br />
              <code>
                DbConnection.builder().withToken("&lt;the token above&gt;")...
              </code>
            </p>
            <p className="secondary">
              Or with the starter kit:
              <br />
              <code>
                BOT_NAME={team.botName} BOT_TOKEN=&lt;token&gt; npm start
              </code>
            </p>
            <button
              className="button"
              style={{ marginTop: 12 }}
              onClick={() => {
                setGen("idle");
                setGenToken(null);
                setGenIdentity(null);
              }}
            >
              Generate another
            </button>
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
                    Number(c.lastSeen.__timestamp_micros_since_unix_epoch__) /
                      1000,
                  ).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {credentials.length === 0 && (
          <div className="secondary" style={{ padding: 12 }}>
            No credentials yet. Click "Generate token" above to make one.
          </div>
        )}
      </section>
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
  fontSize: 13,
};
