import { BrowserRouter, Link, Navigate, Route, Routes } from "react-router-dom";
import { ConnectionProvider, useConn } from "./connection";
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
  const { conn, identity, connected, version, dbName } = useConn();
  void version;
  const link =
    conn && identity ? conn.db.humanLink.web_identity.find(identity) : null;
  const linked = !!link;
  const humanShort = link ? link.humanIdentity.toHexString().slice(0, 8) : null;
  const isAdmin = !!conn?.db.myAdmin.iter().next().value;

  return (
    <nav className="nav">
      <Link to="/" className="brand">
        ScrabbleBot
      </Link>
      <Link to="/matches">Matches</Link>
      <Link to="/leaderboard">Leaderboard</Link>
      <Link to="/tournament">Tournament</Link>
      <Link to="/team">Team</Link>
      <Link to="/docs">Docs</Link>
      {isAdmin && <Link to="/admin">Admin</Link>}
      <span className="conn-state">
        {connected ? "●" : "○"} {dbName}
        {" · "}
        {linked ? (
          <Link to="/account" title="Linked to spacetimedb.com identity">
            linked as {humanShort}…
          </Link>
        ) : (
          <Link to="/account" className="link-cta">
            Link account
          </Link>
        )}
      </span>
    </nav>
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
