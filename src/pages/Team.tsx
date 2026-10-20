import { useState } from "react";
import { Link } from "react-router-dom";
import { DB_NAME, HOST, STARTER_ENV, useConn } from "../connection";
import { DbConnection } from "../module_bindings";
import type { BotCredential } from "../module_bindings/types";
import { myTeam } from "../data";
import { fmtDateTime, fmtTimestamp } from "../util";
import { PageHeader, Panel, ShortIdentity } from "../ui";

type GenStatus = "idle" | "minting" | "claiming" | "done" | "error";

export default function Team() {
  const { conn, identity } = useConn();
  if (!conn || !identity) return <PageHeader title="Team…" />;

  const team = myTeam(conn);
  if (!team) {
    return (
      <>
        <PageHeader title="Team" />
        <Panel full>
          <p className="secondary">
            You're not on a team.{" "}
            <Link to="/team/new">Create or join one →</Link>
          </p>
        </Panel>
      </>
    );
  }

  const credentials = [...conn.db.botCredential.iter()].filter(
    (c) => c.botId === team.botId,
  );
  credentials.sort(
    (a, b) => fmtTimestamp(b.lastSeen) - fmtTimestamp(a.lastSeen),
  );

  return (
    <>
      <PageHeader title={team.teamName} status={team.role.tag} />
      <Panel full title={`Bot: ${team.botName}`}>
        <div className="secondary">
          id #{String(team.botId)} · {credentials.length} credentials ·{" "}
          {credentials.filter((c) => c.connected).length} currently connected
        </div>
      </Panel>
      <TokenGenerator conn={conn} botId={team.botId} botName={team.botName} />
      <Credentials credentials={credentials} />
    </>
  );
}

function TokenGenerator({
  conn,
  botId,
  botName,
}: {
  conn: DbConnection;
  botId: bigint;
  botName: string;
}) {
  const [gen, setGen] = useState<GenStatus>("idle");
  const [genError, setGenError] = useState<string | null>(null);
  const [genToken, setGenToken] = useState<string | null>(null);
  const [genIdentity, setGenIdentity] = useState<string | null>(null);

  // Mint a nonce → open a fresh anon connection → redeem it →
  // hand the user the resulting token.
  async function generateToken() {
    setGen("minting");
    setGenError(null);
    setGenToken(null);
    setGenIdentity(null);

    const before = new Set<string>();
    for (const n of conn.db.myNonces.iter()) before.add(n.code);
    conn.reducers.mintCredentialNonce({});

    // Wait briefly for the nonce row to land in myNonces.
    let code: string | null = null;
    for (let i = 0; i < 30 && !code; i++) {
      await new Promise((r) => setTimeout(r, 100));
      for (const n of conn.db.myNonces.iter()) {
        if (n.botId === botId && !before.has(n.code)) {
          code = n.code;
          break;
        }
      }
    }
    if (!code) {
      setGen("error");
      setGenError("Couldn't read the freshly-minted nonce. Try again?");
      return;
    }

    // Open a fresh anonymous connection — no saved token, no shared identity.
    setGen("claiming");
    DbConnection.builder()
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
              if (c.db.botCredential.identity.find(id)) {
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
  }

  return (
    <Panel full title="Generate a token for your bot">
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
          <p className="error">{genError}</p>
          <button className="button" onClick={() => setGen("idle")}>
            Try again
          </button>
        </>
      )}
      {gen === "done" && genToken && (
        <>
          <span className="caption">
            Bot identity (this credential's identity):
          </span>
          <code className="code-block">{genIdentity}</code>
          <span className="caption">
            Token — save this. It will only be shown once.
          </span>
          <code className="code-block">{genToken}</code>
          <p className="secondary">
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
              {STARTER_ENV}BOT_NAME={botName} BOT_TOKEN=&lt;token&gt; npm start
            </code>
          </p>
          <div className="actions">
            <button
              className="button"
              onClick={() => {
                setGen("idle");
                setGenToken(null);
                setGenIdentity(null);
              }}
            >
              Generate another
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

function Credentials({ credentials }: { credentials: BotCredential[] }) {
  return (
    <Panel full title={`Credentials (${credentials.length})`}>
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
                <ShortIdentity identity={c.identity} />
              </td>
              <td>{c.connected ? "● yes" : "○ no"}</td>
              <td className="secondary">{fmtDateTime(c.lastSeen)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {credentials.length === 0 && (
        <div className="empty">
          No credentials yet. Click "Generate token" above to make one.
        </div>
      )}
    </Panel>
  );
}
