import { useEffect, useState } from "react";
import { Identity } from "spacetimedb";
import { DbConnection } from "./module_bindings";
import type {
  Auction,
  AuctionResult,
  Bot,
  MatchState,
  WordPlay,
} from "./module_bindings/types";

const HOST = import.meta.env.VITE_STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = import.meta.env.VITE_STDB_DB ?? "wordsmith-gf28z";

interface Snapshot {
  match: MatchState | null;
  bots: Bot[];
  auction: Auction | null;
  results: AuctionResult[];
  // Reconstructed from public events: identity hex -> letter -> count
  racks: Map<string, Map<string, number>>;
  plays: WordPlay[];
  bagRemaining: number;
}

function snapshot(conn: DbConnection): Snapshot {
  const match = conn.db.match_state.id.find(0) ?? null;
  const bots: Bot[] = [];
  for (const b of conn.db.bot.iter()) bots.push(b);
  bots.sort((a, b) => Number(b.score - a.score));

  let auction: Auction | null = null;
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open") {
      auction = a;
      break;
    }
  }

  const allResults: AuctionResult[] = [];
  for (const r of conn.db.auction_result.iter()) allResults.push(r);
  allResults.sort((a, b) => Number(a.auctionId - b.auctionId));

  const plays: WordPlay[] = [];
  for (const p of conn.db.word_play.iter()) plays.push(p);
  plays.sort((a, b) => Number(a.id - b.id));

  // Reconstruct each bot's rack: tiles won minus tiles spent on words.
  const racks = new Map<string, Map<string, number>>();
  for (const r of allResults) {
    if (!r.winner) continue;
    const key = r.winner.toHexString();
    const rack = racks.get(key) ?? new Map<string, number>();
    rack.set(r.letter, (rack.get(r.letter) ?? 0) + 1);
    racks.set(key, rack);
  }
  for (const p of plays) {
    const key = p.bot.toHexString();
    const rack = racks.get(key) ?? new Map<string, number>();
    for (const c of p.word) {
      rack.set(c, (rack.get(c) ?? 0) - 1);
    }
    racks.set(key, rack);
  }

  return {
    match,
    bots,
    auction,
    results: allResults.slice(-10).reverse(),
    racks,
    plays: plays.slice(-10).reverse(),
    bagRemaining: match ? match.bagTotal : 0,
  };
}

function rackTiles(racks: Map<string, Map<string, number>>, bot: Identity): string[] {
  const rack = racks.get(bot.toHexString());
  if (!rack) return [];
  const tiles: string[] = [];
  for (const [letter, count] of rack.entries()) {
    if (count <= 0) continue;
    for (let i = 0; i < count; i++) tiles.push(letter);
  }
  tiles.sort();
  return tiles;
}

function spawnSampleBots(conn: DbConnection) {
  // Four sim bots with mixed strategies — one click and you've got a full match.
  conn.reducers.spawnSimulatedBot({ name: "Cheapo", strategy: { tag: "Cheapskate" } });
  conn.reducers.spawnSimulatedBot({ name: "Valor", strategy: { tag: "ValueBidder" } });
  conn.reducers.spawnSimulatedBot({ name: "Brutus", strategy: { tag: "Aggressive" } });
  conn.reducers.spawnSimulatedBot({ name: "Hagrid", strategy: { tag: "ValueBidder" } });
}

function fmtTimestamp(ts: { __timestamp_micros_since_unix_epoch__: bigint }): number {
  return Number(ts.__timestamp_micros_since_unix_epoch__) / 1000;
}

export default function App() {
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [state, setState] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const c = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(localStorage.getItem("wordsmith-token") ?? undefined)
      .onConnect((conn, _identity, token) => {
        localStorage.setItem("wordsmith-token", token);
        setConnected(true);
        conn
          .subscriptionBuilder()
          .onApplied(() => setState(snapshot(conn)))
          .subscribeToAllTables();

        const refresh = () => setState(snapshot(conn));
        for (const t of [
          conn.db.bot,
          conn.db.auction,
          conn.db.auction_result,
          conn.db.word_play,
          conn.db.match_state,
        ]) {
          const anyT = t as unknown as {
            onInsert: (cb: () => void) => void;
            onUpdate: (cb: () => void) => void;
            onDelete: (cb: () => void) => void;
          };
          anyT.onInsert(refresh);
          anyT.onUpdate(refresh);
          anyT.onDelete(refresh);
        }
      })
      .onDisconnect(() => setConnected(false))
      .onConnectError((_ctx, err) => console.error("connect error:", err))
      .build();
    setConn(c);
  }, []);

  // Tick once a second so the countdown updates smoothly.
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, []);

  if (!connected || !state) {
    return (
      <div className="app">
        <header>
          <h1>Wordsmith</h1>
          <span className="status">connecting to {DB_NAME}…</span>
        </header>
      </div>
    );
  }

  const now = Date.now();
  const closesAtMs = state.auction ? fmtTimestamp(state.auction.closesAt) : 0;
  const msLeft = Math.max(0, closesAtMs - now);
  const matchStatus = state.match?.status.tag ?? "Lobby";
  const auctionType = state.match?.auctionType.tag ?? "Vickrey";

  return (
    <div className="app">
      <header>
        <h1>Wordsmith</h1>
        <span className="status">
          {matchStatus.toLowerCase()} · {auctionType.toLowerCase()} · round{" "}
          {state.match?.currentRound ?? 0} · bag {state.bagRemaining} left
          {matchStatus === "Lobby" && (
            <>
              {" · "}
              <select
                className="button"
                value={auctionType}
                onChange={(e) =>
                  conn?.reducers.setAuctionType({
                    auctionType: { tag: e.target.value } as never,
                  })
                }
              >
                <option value="Vickrey">Vickrey</option>
                <option value="FirstPrice">First-price</option>
              </select>
              {" · "}
              <button
                className="button"
                disabled={!conn}
                onClick={() => spawnSampleBots(conn!)}
              >
                Add sample bots
              </button>
              {" · "}
              <button
                className="button"
                disabled={!conn || state.bots.length === 0}
                onClick={() => conn?.reducers.startMatch({})}
              >
                Start match
              </button>
            </>
          )}
          {matchStatus === "Ended" && (
            <>
              {" · "}
              <button className="button" onClick={() => conn?.reducers.resetMatch({})}>
                Reset match
              </button>
            </>
          )}
        </span>
      </header>

      <section className="panel">
        <h2>Current auction</h2>
        {state.auction ? (
          <>
            <div className="auction-letter">{state.auction.letter}</div>
            <div className="countdown">{(msLeft / 1000).toFixed(2)}s left</div>
          </>
        ) : (
          <div className="countdown">{matchStatus === "Ended" ? "Match ended" : "Waiting…"}</div>
        )}
      </section>

      <section className="panel">
        <h2>Recent auctions</h2>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Letter</th>
              <th>Winner</th>
              <th className="num">Bid</th>
              <th className="num">Paid</th>
            </tr>
          </thead>
          <tbody>
            {state.results.map((r) => {
              const winnerBot = r.winner
                ? state.bots.find((b) => b.identity.isEqual(r.winner!))
                : null;
              return (
                <tr key={String(r.auctionId)}>
                  <td>{String(r.auctionId)}</td>
                  <td>{r.letter}</td>
                  <td>{winnerBot?.name ?? (r.winner ? "—" : "no bid")}</td>
                  <td className="num">{String(r.topBid)}</td>
                  <td className="num">{String(r.paid)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel" style={{ gridColumn: "1 / -1" }}>
        <h2>Leaderboard</h2>
        {state.bots.map((b) => {
          const tiles = rackTiles(state.racks, b.identity);
          return (
            <div key={b.identity.toHexString()} className="row">
              <div>
                <div className="name">
                  {b.name} {b.connected ? "" : "(offline)"}
                </div>
                <div className="rack">
                  {tiles.map((t, i) => (
                    <span key={i} className="tile">
                      {t}
                    </span>
                  ))}
                  {tiles.length === 0 && <span className="secondary">(no letters yet)</span>}
                </div>
              </div>
              <div>
                <div style={{ textAlign: "right" }}>{String(b.score)} pts</div>
                <div className="secondary" style={{ textAlign: "right" }}>
                  {String(b.balance)} balance
                </div>
              </div>
            </div>
          );
        })}
      </section>

      <section className="panel" style={{ gridColumn: "1 / -1" }}>
        <h2>Words played</h2>
        <table>
          <thead>
            <tr>
              <th>Bot</th>
              <th>Word</th>
              <th className="num">Base</th>
              <th className="num">Bonus</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {state.plays.map((p) => {
              const bot = state.bots.find((b) => b.identity.isEqual(p.bot));
              return (
                <tr key={String(p.id)}>
                  <td>{bot?.name ?? "?"}</td>
                  <td>{p.word}</td>
                  <td className="num">{String(p.baseScore)}</td>
                  <td className="num">{String(p.bonus)}</td>
                  <td className="num">{String(p.totalReward)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
