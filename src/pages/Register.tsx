import { useState } from "react";
import { useConn } from "../connection";
import { DbConnection } from "../module_bindings";

// We register via a *temporary* second connection so the token gets bound to
// a fresh identity that the user can use in their bot — not the spectator UI's
// own identity.
export default function Register() {
  const { dbName } = useConn();
  const [name, setName] = useState("");
  const [status, setStatus] = useState<"idle" | "registering" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);

  function register() {
    if (!name.trim()) {
      setError("Pick a name.");
      return;
    }
    setStatus("registering");
    setError(null);
    setToken(null);

    const host = import.meta.env.VITE_STDB_HOST ?? "https://maincloud.spacetimedb.com";
    // Build a NEW connection without any saved token so we get a fresh identity.
    const conn = DbConnection.builder()
      .withUri(host)
      .withDatabaseName(dbName)
      .onConnect((c, id, tok) => {
        setIdentity(id.toHexString());
        setToken(tok);
        c.subscriptionBuilder()
          .onApplied(() => {
            c.reducers.registerBot({ name: name.trim() });
            // We don't have a typed callback for the result — give it a beat,
            // then verify the row landed by checking the bot table.
            setTimeout(() => {
              const found = Array.from(c.db.bot.iter()).some(
                (b) => b.identity.isEqual(id) && b.name === name.trim(),
              );
              if (found) {
                setStatus("done");
              } else {
                setError(
                  "Registration didn't take. The name may already be taken or the connection dropped.",
                );
                setStatus("error");
              }
              try { c.disconnect(); } catch { /* ignore */ }
            }, 800);
          })
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, e) => {
        setError(`connection failed: ${e.message}`);
        setStatus("error");
      })
      .build();
    void conn;
  }

  return (
    <>
      <div className="header full">
        <h1>Register a bot</h1>
      </div>

      <section className="panel full">
        <p>
          Pick a name for your bot. You'll get back a <b>token</b> — paste it into your bot's{" "}
          <code>BOT_TOKEN</code> environment variable when you run the starter kit.
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <input
            value={name}
            placeholder="bot name (e.g. alice)"
            onChange={(e) => setName(e.target.value)}
            disabled={status === "registering" || status === "done"}
            style={{
              flex: "0 0 280px",
              background: "var(--panel)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "6px 10px",
            }}
          />
          <button
            className="button"
            onClick={register}
            disabled={status === "registering" || status === "done"}
          >
            {status === "registering" ? "Registering…" : "Register"}
          </button>
        </div>
        {error && (
          <div style={{ color: "var(--warn)", marginTop: 12 }}>{error}</div>
        )}
        {status === "done" && token && (
          <div style={{ marginTop: 16 }}>
            <div className="secondary" style={{ marginBottom: 4 }}>Identity</div>
            <code style={{ display: "block", wordBreak: "break-all", marginBottom: 12 }}>
              {identity}
            </code>
            <div className="secondary" style={{ marginBottom: 4 }}>
              Token — save this! It will only be shown once.
            </div>
            <code
              style={{
                display: "block",
                wordBreak: "break-all",
                background: "var(--bg)",
                padding: 8,
                borderRadius: 6,
                border: "1px solid var(--border)",
              }}
            >
              {token}
            </code>
            <p className="secondary" style={{ marginTop: 12 }}>
              Use it like this:{" "}
              <code>BOT_NAME={name.trim()} BOT_TOKEN=&lt;your token&gt; npm start</code>
            </p>
          </div>
        )}
      </section>
    </>
  );
}
