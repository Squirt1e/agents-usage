import type { ConnectionIssue } from './connection-issues';
import { issueHeading } from './connection-issues';

/** Read-only details float over the body, leaving every card's layout intact. */
export function ConnectionDetails(props: { issues: ConnectionIssue[]; open: boolean }) {
  const open = props.open && props.issues.length > 0;
  return (
    <div
      className={`connection-details${open ? ' is-open' : ''}`}
      role="dialog"
      aria-label="连接状态"
      aria-hidden={!open}
      id="connection-details"
    >
      <div className="connection-details-title">连接状态</div>
      <div className="connection-details-list">
        {props.issues.map((issue) => (
          <div className="connection-detail" key={issue.key}>
            <div className="connection-detail-head">
              <strong>{issueHeading(issue)}</strong>
              <span>{issue.status}</span>
            </div>
            <p>{issue.message}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
