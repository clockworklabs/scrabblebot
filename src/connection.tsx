import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "react-oidc-context";
import { DbConnection } from "./module_bindings";
import type { Identity } from "spacetimedb";

export const HOST =
  import.meta.env.VITE_STDB_HOST ?? "https://maincloud.spacetimedb.com";
export const DB_NAME = import.meta.env.VITE_STDB_DB ?? "scrabblebot";

// The bot starter connects to `scrabblebot` unless STDB_DB names another
// database, so the commands this site shows have to name any other one
// (staging, say), or a bot would connect somewhere its token doesn't work.
export const STARTER_ENV =
  DB_NAME === "scrabblebot" ? "" : `STDB_DB=${DB_NAME} `;

interface Ctx {
  conn: DbConnection | null;
  identity: Identity | null;
  version: number; // bumps on any table change so subscribers re-render
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
  const auth = useAuth();
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [connected, setConnected] = useState(false);
  const [version, setVersion] = useState(0);
  const versionRef = useRef(0);

  // We re-connect whenever the auth state stabilises. Key:
  //   - signed in:  use the OIDC id_token so ctx.sender == OIDC subject
  //   - signed out: use an anonymous SpacetimeDB-minted token (cached in
  //                 localStorage so identity persists across reloads).
  const idToken = auth.isAuthenticated ? auth.user?.id_token : undefined;
  const authKey = auth.isLoading ? "loading" : (idToken ?? "anon");

  useEffect(() => {
    if (auth.isLoading) return;
    let cancelled = false;
    let active: DbConnection | null = null;

    const bump = () => {
      versionRef.current += 1;
      setVersion(versionRef.current);
    };

    const token =
      idToken ?? localStorage.getItem("scrabblebot-token") ?? undefined;
    const c = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(token)
      .onConnect((c, id, freshToken) => {
        if (cancelled) {
          try {
            c.disconnect();
          } catch {
            /* */
          }
          return;
        }
        // Only cache anonymous tokens — never the OIDC one (it's short-lived
        // and managed by oidc-client-ts).
        if (!idToken) localStorage.setItem("scrabblebot-token", freshToken);
        setIdentity(id);
        setConnected(true);
        c.subscriptionBuilder().onApplied(bump).subscribeToAllTables();
        for (const t of [
          c.db.bot,
          c.db.botStats,
          c.db.matchState,
          c.db.matchParticipant,
          c.db.auction,
          c.db.auctionResult,
          c.db.wordPlay,
          c.db.lobby,
          c.db.lobbyMember,
          c.db.tournament,
          c.db.tournamentEntry,
          c.db.tournamentMatch,
          c.db.matchmakerConfig,
          c.db.team,
          c.db.teamMember,
          c.db.botCredential,
          c.db.humanLink,
          c.db.myTeam,
          c.db.myNonces,
          c.db.admin,
          c.db.myAdmin,
          c.db.visibleAuctionTopBids,
          c.db.auctionTopBidArchive,
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
    active = c;
    setConn(c);

    return () => {
      cancelled = true;
      setConnected(false);
      try {
        active?.disconnect();
      } catch {
        /* */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authKey]);

  // Tick counter so countdown timers re-render between table events.
  useEffect(() => {
    const id = window.setInterval(() => {
      versionRef.current += 1;
      setVersion(versionRef.current);
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  return (
    <ConnectionContext.Provider
      value={{ conn, identity, version, connected, dbName: DB_NAME }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}
