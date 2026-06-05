import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { DbConnection } from "./module_bindings";
import type { Identity } from "spacetimedb";

const HOST = import.meta.env.VITE_STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = import.meta.env.VITE_STDB_DB ?? "wordsmith-gf28z";

interface Ctx {
  conn: DbConnection | null;
  identity: Identity | null;
  version: number;   // bumps on any table change so subscribers re-render
  connected: boolean;
  dbName: string;
}

const ConnectionContext = createContext<Ctx>({
  conn: null,
  identity: null,
  version: 0,
  connected: false,
  dbName: DB_NAME,
});

export function useConn() {
  return useContext(ConnectionContext);
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const versionRef = useRef(0);

  useEffect(() => {
    const bump = () => {
      versionRef.current += 1;
      setVersion(versionRef.current);
    };

    const c = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(localStorage.getItem("wordsmith-token") ?? undefined)
      .onConnect((c, id, token) => {
        localStorage.setItem("wordsmith-token", token);
        setIdentity(id);
        setConnected(true);
        c.subscriptionBuilder().onApplied(bump).subscribeToAllTables();
        for (const t of [
          c.db.bot,
          c.db.bot_stats,
          c.db.match_state,
          c.db.match_participant,
          c.db.auction,
          c.db.auction_result,
          c.db.word_play,
          c.db.matchmaker_config,
          c.db.tournament,
          c.db.tournament_entry,
          c.db.tournament_match,
        ]) {
          const anyT = t as unknown as {
            onInsert: (cb: () => void) => void;
            onUpdate: (cb: () => void) => void;
            onDelete: (cb: () => void) => void;
          };
          anyT.onInsert(bump);
          anyT.onUpdate(bump);
          anyT.onDelete(bump);
        }
      })
      .onDisconnect(() => setConnected(false))
      .onConnectError((_ctx, err) => console.error("connect error:", err))
      .build();
    setConn(c);
  }, []);

  // Tick counter so countdown timers re-render between table events.
  useEffect(() => {
    const id = window.setInterval(() => {
      versionRef.current += 1;
      setVersion(versionRef.current);
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  return (
    <ConnectionContext.Provider value={{ conn, identity, version, connected, dbName: DB_NAME }}>
      {children}
    </ConnectionContext.Provider>
  );
}
