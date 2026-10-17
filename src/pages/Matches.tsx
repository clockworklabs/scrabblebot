import { Link } from "react-router-dom";
import { useConn } from "../connection";
import { botNames, standingsByMatch } from "../data";
import { PageHeader, Panel } from "../ui";

export default function Matches() {
  const { conn } = useConn();
  const matches = conn ? [...conn.db.matchState.iter()] : [];
  matches.sort((a, b) => Number(b.id - a.id));
  const standings = standingsByMatch(conn);
  const botName = botNames(conn);

  return (
    <>
      <PageHeader title="Matches" status={`${matches.length} total`} />

      <Panel full className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Status</th>
              <th>Auction</th>
              <th>Round</th>
              <th>Bag left</th>
              <th>Participants</th>
              <th>Top score</th>
            </tr>
          </thead>
          <tbody>
            {matches.map((m) => {
              const participants = standings.get(m.id) ?? [];
              const top = participants[0];
              return (
                <tr key={String(m.id)}>
                  <td>
                    <Link to={`/matches/${m.id}`}>#{String(m.id)}</Link>
                  </td>
                  <td>{m.status.tag}</td>
                  <td>{m.auctionType.tag}</td>
                  <td>{m.currentRound}</td>
                  <td>{m.bagTotal}</td>
                  <td>{participants.length}</td>
                  <td>
                    {top ? `${botName(top.botId)} (${String(top.score)})` : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {matches.length === 0 && (
          <div className="empty">
            No matches yet. Go to <Link to="/admin">Admin</Link> to start one.
          </div>
        )}
      </Panel>
    </>
  );
}
