import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { useEffect, useRef } from "react";
import { ConnectionProvider, useConn } from "./connection";
import { amAdmin, humanLinkOf } from "./data";
import { Tile } from "./Tile";
import Home from "./pages/Home";
import Matches from "./pages/Matches";
import MatchView from "./pages/MatchView";
import Account from "./pages/Account";
import Team from "./pages/Team";
import TeamNew from "./pages/TeamNew";
import Leaderboard from "./pages/Leaderboard";
import Docs from "./pages/Docs";
import Tournament from "./pages/Tournament";
import Admin from "./pages/Admin";

function Nav() {
  const { conn, identity, connected, dbName } = useConn();
  const link = humanLinkOf(conn, identity);

  // On narrow screens the links scroll sideways; keep the current page's
  // link in view so the underline isn't hidden off the edge.
  const { pathname } = useLocation();
  const linksRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    linksRef.current
      ?.querySelector(".active")
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [pathname]);

  return (
    <header className="nav-bar">
      <nav className="nav">
        <Link to="/" className="brand">
          <Tile letter="S" size="sm" />
          ScrabbleBot
        </Link>
        <div className="nav-links" ref={linksRef}>
          <NavLink to="/matches">Matches</NavLink>
          <NavLink to="/leaderboard">Leaderboard</NavLink>
          <NavLink to="/tournament">Tournament</NavLink>
          <NavLink to="/team">Team</NavLink>
          <NavLink to="/docs">Docs</NavLink>
          {amAdmin(conn) && <NavLink to="/admin">Admin</NavLink>}
        </div>
        <span className="conn-state">
          <span title={connected ? "Connected" : "Disconnected"}>
            <span className={connected ? "conn-dot on" : "conn-dot"} />
            <span className="conn-db">{dbName}</span>
          </span>
          {link ? (
            <Link to="/account" title="Linked to spacetimedb.com identity">
              linked as {link.humanIdentity.toHexString().slice(0, 8)}…
            </Link>
          ) : (
            <Link to="/account" className="link-cta">
              Link account
            </Link>
          )}
        </span>
      </nav>
    </header>
  );
}

export default function App() {
  return (
    <ConnectionProvider>
      <BrowserRouter>
        <Nav />
        <div className="page">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/matches" element={<Matches />} />
            <Route path="/matches/:id" element={<MatchView />} />
            <Route path="/account" element={<Account />} />
            <Route path="/team" element={<Team />} />
            <Route path="/team/new" element={<TeamNew />} />
            <Route
              path="/register"
              element={<Navigate to="/team/new" replace />}
            />
            <Route path="/leaderboard" element={<Leaderboard />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/tournament" element={<Tournament />} />
            <Route path="/admin" element={<Admin />} />
          </Routes>
        </div>
      </BrowserRouter>
    </ConnectionProvider>
  );
}
