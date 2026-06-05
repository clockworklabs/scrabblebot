import { BrowserRouter, Link, Route, Routes } from "react-router-dom";
import { ConnectionProvider, useConn } from "./connection";
import Home from "./pages/Home";
import Matches from "./pages/Matches";
import MatchView from "./pages/MatchView";
import Register from "./pages/Register";
import Leaderboard from "./pages/Leaderboard";
import Docs from "./pages/Docs";
import Tournament from "./pages/Tournament";
import Admin from "./pages/Admin";

function Nav() {
  const { connected, dbName } = useConn();
  return (
    <nav className="nav">
      <Link to="/" className="brand">Wordsmith</Link>
      <Link to="/matches">Matches</Link>
      <Link to="/leaderboard">Leaderboard</Link>
      <Link to="/tournament">Tournament</Link>
      <Link to="/docs">Docs</Link>
      <Link to="/register">Register</Link>
      <Link to="/admin">Admin</Link>
      <span className="conn-state">
        {connected ? "● connected" : "○ connecting"} · {dbName}
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
            <Route path="/register" element={<Register />} />
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
