import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "react-oidc-context";
import {
  DbConnection,
  tables,
  type SubscriptionHandle,
} from "./module_bindings";
import { toSql, type Identity } from "spacetimedb";

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
  // Why the subscription failed, if it did. The site then has no data.
  loadError: string | null;
}

const ConnectionContext = createContext<Ctx>({
  conn: null,
  identity: null,
  version: 0,
  connected: false,
  dbName: DB_NAME,
  loadError: null,
});

export function useConn() {
  return useContext(ConnectionContext);
}

// What every page needs, subscribed for as long as the site is open. These
// stay small: one row per bot, team or tournament. A match's history (its
// tiles, bids and words) piles up with every match played, so pages
// subscribe to that with `useSubscription` for the matches they show.
const GLOBAL_QUERIES = [
  tables.bot,
  tables.botStats,
  tables.botVersion,
  tables.retiredBotStats,
  tables.botCredential,
  tables.team,
  tables.teamMember,
  tables.humanLink,
  tables.admin,
  tables.matchmakerConfig,
  tables.matchState,
  tables.openLobbies,
  tables.openLobbyMembers,
  tables.tournament,
  tables.tournamentEntry,
  tables.tournamentMatch,
  tables.myTeam,
  tables.myNonces,
  tables.myTeamInvites,
  tables.myAdmin,
];

// Subscribes to `queries` while the calling component is mounted. Each query
// gets its own subscription, so when the set changes only the queries that
// came or went are subscribed or dropped, and rows still on the page stay
// in the cache instead of flashing out and back in.
export function useSubscription(queries: Parameters<typeof toSql>[0][]) {
  const { conn, connected } = useConn();
  const live = useRef(
    new Map<string, { conn: DbConnection; handle: SubscriptionHandle }>(),
  );
  const sqls = queries.map(toSql);
  const key = sqls.join("\n");

  useEffect(() => {
    const wanted = new Set(conn && connected ? sqls : []);
    for (const [sql, sub] of live.current) {
      if (sub.conn !== conn || !wanted.has(sql)) {
        unsubscribe(sub.handle);
        live.current.delete(sql);
      }
    }
    if (!conn) return;
    for (const sql of wanted) {
      if (!live.current.has(sql)) {
        live.current.set(sql, {
          conn,
          handle: conn.subscriptionBuilder().subscribe(sql),
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, connected, key]);

  useEffect(() => {
    const subs = live.current;
    return () => {
      for (const sub of subs.values()) unsubscribe(sub.handle);
      subs.clear();
    };
  }, []);
}

// Ending a subscription on a connection that has since closed throws, and
// there's nothing left to end.
function unsubscribe(handle: SubscriptionHandle) {
  try {
    handle.unsubscribe();
  } catch {
    /* */
  }
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [connected, setConnected] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
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
        // The global queries are one subscription, so a single bad query
        // fails all of them: say, a view this build expects that the
        // database hasn't been published with yet.
        c.subscriptionBuilder()
          .onApplied(() => {
            setLoadError(null);
            bump();
          })
          .onError((ctx) => {
            console.error("subscription error:", ctx.event);
            setLoadError(ctx.event?.message ?? "The subscription failed");
          })
          .subscribe(GLOBAL_QUERIES);
        for (const t of [
          c.db.bot,
          c.db.botStats,
          c.db.botVersion,
          c.db.retiredBotStats,
          c.db.ratingHistory,
          c.db.matchState,
          c.db.matchParticipant,
          c.db.auction,
          c.db.auctionResult,
          c.db.wordPlay,
          c.db.openLobbies,
          c.db.openLobbyMembers,
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
          c.db.myTeamInvites,
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
      value={{
        conn,
        identity,
        version,
        connected,
        dbName: DB_NAME,
        loadError,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}
