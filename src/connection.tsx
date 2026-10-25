import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAuth } from "react-oidc-context";
import { DbConnection, tables } from "./module_bindings";
import type { Identity, RowTypedQuery } from "spacetimedb";

export const HOST =
  import.meta.env.VITE_STDB_HOST ?? "https://maincloud.spacetimedb.com";
export const DB_NAME = import.meta.env.VITE_STDB_DB ?? "scrabblebot";

// The bot starter connects to `scrabblebot` unless STDB_DB names another
// database, so the commands this site shows have to name any other one
// (staging, say), or a bot would connect somewhere its token doesn't work.
export const STARTER_ENV =
  DB_NAME === "scrabblebot" ? "" : `STDB_DB=${DB_NAME} `;

// What the SDK's typed query builder hands to `subscribe`.
export type SubscriptionQuery = RowTypedQuery<unknown, unknown>;

interface Ctx {
  conn: DbConnection | null;
  identity: Identity | null;
  version: number; // bumps on any table change so subscribers re-render
  connected: boolean;
  // The core tables are in the client cache, so a page can render for real
  // instead of showing its empty state.
  ready: boolean;
  dbName: string;
  // Why the subscription failed, if it did. The site then has no data.
  loadError: string | null;
}

const ConnectionContext = createContext<Ctx>({
  conn: null,
  identity: null,
  version: 0,
  connected: false,
  ready: false,
  dbName: DB_NAME,
  loadError: null,
});

export function useConn() {
  return useContext(ConnectionContext);
}

// Everything except the tables that grow with every auction and every word
// played. Those dwarf the rest, so subscribing to them up front is what made
// the site take seconds to show anything: `useSubscribe`/`matchQueries` load
// one match's history when a page actually shows it.
//
// shortcut: `matchState` and `matchParticipant` still grow with every match
// ever played (a handful of rows each). Bound them with a "recent matches"
// view once that is the slow part.
const CORE_QUERIES: SubscriptionQuery[] = [
  tables.bot,
  tables.botCredential,
  tables.botStats,
  tables.retiredBotStats,
  tables.botVersion,
  tables.team,
  tables.teamMember,
  tables.humanLink,
  tables.admin,
  tables.lobby,
  tables.lobbyMember,
  tables.matchState,
  tables.matchParticipant,
  tables.matchmakerConfig,
  tables.tournament,
  tables.tournamentEntry,
  tables.tournamentMatch,
  tables.myTeam,
  tables.myAdmin,
  tables.myNonces,
  tables.visibleAuctionTopBids,
];

// A match's own rows: its auctions, the letters sold at them and the words
// played, plus the winning bids once it has ended.
export function matchQueries(matchId: bigint): SubscriptionQuery[] {
  return [
    tables.wordPlay.where((r) => r.matchId.eq(matchId)),
    tables.auctionResult.where((r) => r.matchId.eq(matchId)),
    tables.auction.where((r) => r.matchId.eq(matchId)),
    tables.auctionTopBidArchive.where((r) => r.matchId.eq(matchId)),
  ];
}

export function ConnectionProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const [conn, setConn] = useState<DbConnection | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [connected, setConnected] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const versionRef = useRef(0);

  // We re-connect when the identity changes, and only then:
  //   - signed in:  use the OIDC id_token so ctx.sender == OIDC subject
  //   - signed out: use an anonymous SpacetimeDB-minted token (cached in
  //                 localStorage so identity persists across reloads).
  // Keying on the token itself reconnected on every silent renew, which threw
  // the whole client cache away and downloaded it again.
  const idToken = auth.isAuthenticated ? auth.user?.id_token : undefined;
  const subject = auth.isAuthenticated ? auth.user?.profile.sub : undefined;
  const authKey = auth.isLoading ? "loading" : (subject ?? "anon");

  useEffect(() => {
    if (auth.isLoading) return;
    let cancelled = false;
    let raf = 0;
    let active: DbConnection | null = null;

    // At most one bump per frame. The initial subscription lands thousands of
    // rows, and a render per row is what kept the page busy for seconds.
    const bump = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (cancelled) return;
        versionRef.current += 1;
        setVersion(versionRef.current);
      });
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
        // Every query is in one subscription, so a single bad query fails all
        // of them: say, a table this build expects that the database hasn't
        // been published with yet.
        c.subscriptionBuilder()
          .onApplied(() => {
            setLoadError(null);
            setReady(true);
            bump();
          })
          .onError((ctx) => {
            console.error("subscription error:", ctx.event);
            setLoadError(ctx.event?.message ?? "The subscription failed");
          })
          .subscribe(CORE_QUERIES);
        for (const t of [
          c.db.bot,
          c.db.botStats,
          c.db.retiredBotStats,
          c.db.botVersion,
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
      cancelAnimationFrame(raf);
      setConnected(false);
      setReady(false);
      try {
        active?.disconnect();
      } catch {
        /* */
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authKey]);

  return (
    <ConnectionContext.Provider
      value={{
        conn,
        identity,
        version,
        connected,
        ready,
        dbName: DB_NAME,
        loadError,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}

// Subscribe to the rows `build` names while the calling component is mounted,
// and drop them again after. `key` says which queries those are, so they're
// only rebuilt when they actually change. The core subscription does not
// cover the per-match tables `matchQueries` names.
export function useSubscribe(key: string, build: () => SubscriptionQuery[]) {
  const { conn } = useConn();
  useEffect(() => {
    if (!conn || !key) return;
    const queries = build();
    if (queries.length === 0) return;
    const handle = conn
      .subscriptionBuilder()
      .onError((ctx) => console.error("subscription error:", ctx.event))
      .subscribe(queries);
    return () => {
      void handle.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, key]);
}

// A clock for countdowns and "3m ago" labels. Only the components that show
// one tick; the data version above no longer does.
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
