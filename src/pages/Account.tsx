import { Link } from "react-router-dom";
import { useConn } from "../connection";
import { humanLinkOf, myTeam } from "../data";
import { fmtDateTime } from "../util";
import { PageHeader, Panel } from "../ui";

export default function Account() {
  const { conn, identity, dbName } = useConn();

  if (!conn || !identity) {
    return (
      <>
        <PageHeader title="Your account" />
        <Panel full>
          <p className="secondary">Connecting…</p>
        </Panel>
      </>
    );
  }

  const webHex = identity.toHexString();
  const link = humanLinkOf(conn, identity);
  const team = myTeam(conn);

  return (
    <>
      <PageHeader title="Your account" status={link ? "linked" : "anonymous"} />

      <Panel full title="Web identity">
        <span className="caption">This browser is connected as:</span>
        <code className="code-block">{webHex}</code>
      </Panel>

      {link ? (
        <>
          <Panel title="Linked human identity">
            <code className="code-block">
              {link.humanIdentity.toHexString()}
            </code>
            <div className="secondary">
              Linked at {fmtDateTime(link.linkedAt)}
            </div>
          </Panel>

          <Panel title="Team">
            {team ? (
              <>
                <div className="row">
                  <span>
                    <Link to="/team">{team.teamName}</Link>
                  </span>
                  <span className="secondary">
                    {team.role.tag.toLowerCase()}
                  </span>
                </div>
                <div className="row">
                  <span>Bot</span>
                  <span>{team.botName}</span>
                </div>
                <div className="row">
                  <span>Credentials</span>
                  <span>{team.credentialCount}</span>
                </div>
              </>
            ) : (
              <p className="secondary">
                You're not on a team yet.{" "}
                <Link to="/team/new">Create one →</Link>
              </p>
            )}
          </Panel>
        </>
      ) : (
        <Panel full title="Link your spacetimedb.com account">
          <p>
            Connect this browser to your <code>spacetime login</code> identity
            so you can manage a team and bot from either the website or the
            command line.
          </p>
          <pre className="code-block">
            spacetime call {dbName} connect_id '["0x{webHex}"]'
          </pre>
          <p className="secondary">
            Run that in any terminal where <code>spacetime login</code> is
            configured. Then refresh this page.
          </p>
        </Panel>
      )}
    </>
  );
}
