import { useState } from "react";
import { Identity } from "spacetimedb";
import { useConn } from "../connection";
import type { Admin as AdminRow } from "../module_bindings/types";

type AuctionTypeTag = "Vickrey" | "FirstPrice";

export default function Admin() {
  const { conn, identity } = useConn();
  const [auctionType, setAuctionType] = useState<AuctionTypeTag>("Vickrey");
  const [swissRounds, setSwissRounds] = useState(4);
  const [topCut, setTopCut] = useState(8);
  const [tournMatchSize, setTournMatchSize] = useState(4);
  const [newAdminHex, setNewAdminHex] = useState("");
  const [adminError, setAdminError] = useState<string | null>(null);

  if (!conn || !identity) {
    return (
      <div className="header full">
        <h1>Admin</h1>
      </div>
    );
  }

  const admins: AdminRow[] = [];
  for (const a of conn.db.admin.iter()) admins.push(a);
  const myAdmin = conn.db.myAdmin.iter().next().value;
  const link = conn.db.humanLink.web_identity.find(identity);
  const myHuman = link?.humanIdentity;
  const noAdmins = admins.length === 0;

  if (!myAdmin && noAdmins) {
    return (
      <>
        <div className="header full">
          <h1>Admin</h1>
          <span className="status">no admins yet</span>
        </div>
        <section className="panel full">
          <h2>Claim first admin</h2>
          <p>
            No admins are configured. Whoever clicks the button below becomes
            the first admin and can then add others.
          </p>
          {!myHuman && (
            <p style={{ color: "var(--warn)" }}>
              You need to{" "}
              <a href="/account">link your spacetimedb.com identity</a> first so
              the admin role is bound to it.
            </p>
          )}
          <button
            className="button"
            disabled={!myHuman}
            onClick={() => conn.reducers.bootstrapAdmin({})}
          >
            Bootstrap first admin
          </button>
        </section>
      </>
    );
  }

  if (!myAdmin) {
    return (
      <>
        <div className="header full">
          <h1>Admin</h1>
          <span className="status">not authorized</span>
        </div>
        <section className="panel full">
          <p>
            You're not an admin. Ask one of the existing admins to add your
            spacetimedb.com identity:
          </p>
          {myHuman ? (
            <code style={codeBlock}>{myHuman.toHexString()}</code>
          ) : (
            <p style={{ color: "var(--warn)" }}>
              Also: link your spacetimedb.com identity on{" "}
              <a href="/account">the Account page</a> first.
            </p>
          )}
        </section>
      </>
    );
  }

  function startTournament() {
    if (!conn) return;
    conn.reducers.startTournament({
      swissRoundsTotal: swissRounds,
      topCut,
      matchSize: tournMatchSize,
      auctionType: { tag: auctionType },
    });
  }

  function addAdmin() {
    if (!conn) return;
    setAdminError(null);
    const hex = newAdminHex.trim().replace(/^0x/, "");
    if (hex.length !== 64) {
      setAdminError(
        "Identity should be a 64-char hex string (optional 0x prefix).",
      );
      return;
    }
    try {
      const id = Identity.fromString(hex);
      conn.reducers.addAdmin({ humanIdentity: id });
      setNewAdminHex("");
    } catch (e) {
      setAdminError(
        `Bad identity: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  function removeAdmin(target: Identity) {
    if (!conn) return;
    conn.reducers.removeAdmin({ humanIdentity: target });
  }

  return (
    <>
      <div className="header full">
        <h1>Admin</h1>
        <span className="status">{admins.length} admins</span>
      </div>

      <section className="panel full">
        <h2>Admins ({admins.length})</h2>
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
                    <code style={{ fontSize: 12 }}>
                      {a.humanIdentity.toHexString().slice(0, 16)}…
                    </code>
                    {isMe && <span className="secondary"> (you)</span>}
                  </td>
                  <td className="secondary">
                    {new Date(
                      Number(a.addedAt.__timestamp_micros_since_unix_epoch__) /
                        1000,
                    ).toLocaleString()}
                  </td>
                  <td>
                    {!isMe && (
                      <button
                        className="button"
                        style={{ fontSize: 12 }}
                        onClick={() => removeAdmin(a.humanIdentity)}
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
        <div style={{ marginTop: 16 }}>
          <div className="secondary" style={{ marginBottom: 6 }}>
            Add an admin by spacetime.com identity (have them check{" "}
            <a href="/account">/account</a> for their hex):
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={newAdminHex}
              placeholder="0xc200..."
              onChange={(e) => setNewAdminHex(e.target.value)}
              style={{
                background: "var(--panel)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: "6px 10px",
                flex: 1,
                fontFamily: "ui-monospace, monospace",
              }}
            />
            <button className="button" onClick={addAdmin}>
              Add admin
            </button>
          </div>
          {adminError && (
            <div style={{ color: "var(--warn)", marginTop: 8 }}>
              {adminError}
            </div>
          )}
        </div>
      </section>

      <section className="panel full">
        <h2>Run a tournament</h2>
        <p className="secondary">
          Swiss rounds, then a single-elimination bracket cut to the top-N. Uses
          every currently-registered bot.
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
        <div className="row">
          <span>Swiss rounds</span>
          <input
            type="number"
            value={swissRounds}
            min={1}
            max={10}
            onChange={(e) => setSwissRounds(Number(e.target.value))}
            style={inputStyle}
          />
        </div>
        <div className="row">
          <span>Top cut</span>
          <input
            type="number"
            value={topCut}
            min={2}
            max={32}
            onChange={(e) => setTopCut(Number(e.target.value))}
            style={inputStyle}
          />
        </div>
        <div className="row">
          <span>Match size</span>
          <input
            type="number"
            value={tournMatchSize}
            min={2}
            max={8}
            onChange={(e) => setTournMatchSize(Number(e.target.value))}
            style={inputStyle}
          />
        </div>
        <div style={{ marginTop: 12 }}>
          <button className="button" onClick={startTournament}>
            Start tournament
          </button>
        </div>
      </section>
    </>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  padding: "4px 8px",
  width: 80,
};
const codeBlock: React.CSSProperties = {
  display: "block",
  wordBreak: "break-all",
  background: "var(--bg)",
  padding: 8,
  borderRadius: 6,
  border: "1px solid var(--border)",
  fontSize: 13,
};
