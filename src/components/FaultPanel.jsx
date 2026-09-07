import { useTracker } from "../tracker/TrackerContext.jsx";

export function FaultPanel() {
  const { point, faults } = useTracker();
  return <div className="data-card glass faults-card">
    {!point ? <p className="empty-state">Waiting for flight-computer telemetry.</p> : faults.length === 0 ? <div className="nominal-state"><span>✓</span><h2>All systems nominal</h2><p>No current device faults.</p></div> : <><div className="card-title"><h2>Active faults</h2><span className="danger-text">ACTION NEEDED</span></div><ul className="fault-list">{faults.map((fault) => <li key={fault.name}><strong>{fault.name}</strong><span>{fault.status}</span></li>)}</ul></>}
    {point && <details className="technical"><summary>Raw status</summary><code>{point.flags}</code></details>}
  </div>;
}
