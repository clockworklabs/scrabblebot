import { useState } from "react";
import { useConn } from "../connection";

type AuctionTypeTag = "Vickrey" | "FirstPrice";

export default function Admin() {
  const { conn } = useConn();
  const [auctionType, setAuctionType] = useState<AuctionTypeTag>("Vickrey");
  const [interval, setInterval] = useState(15000);
  const [minSize, setMinSize] = useState(2);
  const [maxSize, setMaxSize] = useState(6);
  const [enabled, setEnabled] = useState(false);
  const [swissRounds, setSwissRounds] = useState(4);
  const [topCut, setTopCut] = useState(8);
  const [tournMatchSize, setTournMatchSize] = useState(4);

  function setMatchmaker(on: boolean) {
    if (!conn) return;
    setEnabled(on);
    conn.reducers.setMatchmakerEnabled({
      enabled: on,
      matchSizeMin: minSize,
      matchSizeMax: maxSize,
      intervalMs: BigInt(interval),
      auctionType: { tag: auctionType },
    });
  }

  function spawnSampleBots() {
    if (!conn) return;
    conn.reducers.spawnSimulatedBot({ name: "Cheapo", strategy: { tag: "Cheapskate" } });
    conn.reducers.spawnSimulatedBot({ name: "Valor", strategy: { tag: "ValueBidder" } });
    conn.reducers.spawnSimulatedBot({ name: "Brutus", strategy: { tag: "Aggressive" } });
    conn.reducers.spawnSimulatedBot({ name: "Hagrid", strategy: { tag: "ValueBidder" } });
  }

  function startMatch() {
    if (!conn) return;
    conn.reducers.startMatch({ auctionType: { tag: auctionType } });
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

  return (
    <>
      <div className="header full">
        <h1>Admin</h1>
      </div>

      <section className="panel">
        <h2>Quick start</h2>
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
        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button className="button" onClick={spawnSampleBots}>
            Add sample bots
          </button>
          <button className="button" onClick={startMatch}>
            Start one-off match
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Matchmaker</h2>
        <p className="secondary">
          Continuously spawns matches of random bots that aren't currently in one.
        </p>
        <div className="row">
          <span>Status</span>
          <span>{enabled ? "running" : "idle"}</span>
        </div>
        <div className="row">
          <span>Interval (ms)</span>
          <input
            type="number"
            value={interval}
            min={1000}
            step={1000}
            onChange={(e) => setInterval(Number(e.target.value))}
            style={inputStyle}
          />
        </div>
        <div className="row">
          <span>Match size</span>
          <span>
            <input
              type="number"
              value={minSize}
              min={2}
              onChange={(e) => setMinSize(Number(e.target.value))}
              style={{ ...inputStyle, width: 60 }}
            />
            {" – "}
            <input
              type="number"
              value={maxSize}
              min={minSize}
              onChange={(e) => setMaxSize(Number(e.target.value))}
              style={{ ...inputStyle, width: 60 }}
            />
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="button" onClick={() => setMatchmaker(true)} disabled={enabled}>
            Enable
          </button>
          <button className="button" onClick={() => setMatchmaker(false)} disabled={!enabled}>
            Disable
          </button>
        </div>
      </section>

      <section className="panel full">
        <h2>Run a tournament</h2>
        <p className="secondary">
          Swiss rounds, then a single-elimination bracket cut to the top-N. Uses every
          currently-registered bot.
        </p>
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
