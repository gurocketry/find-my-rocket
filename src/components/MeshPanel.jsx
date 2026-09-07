import { useTracker } from "../tracker/TrackerContext.jsx";
import { Metric } from "./Metric.jsx";

export function MeshPanel() {
  const { mesh } = useTracker();
  const total = mesh.nodes.reduce((sum, node) => sum + node.packets, 0);
  const duplicates = mesh.nodes.reduce((sum, node) => sum + node.duplicates, 0);
  const health = mesh.health || {};
  return <div className="system-panel">
    <div className="summary-grid"><Metric label="Nodes" value={mesh.nodes.length} /><Metric label="Packets received" value={health.rx ?? total} /><Metric label="Average RSSI" value={health.avg_rssi} unit="dBm" /><Metric label="Duplicates" value={health.duplicates ?? duplicates} /></div>
    <div className="data-card glass">
      <div className="card-title"><h2>Nodes</h2><span>{String(health.mesh ?? (mesh.nodes.length ? "active" : "never")).toUpperCase()}</span></div>
      {mesh.nodes.length === 0 ? <p className="empty-state">No mesh traffic received yet.</p> : <div className="table-scroll"><table><thead><tr><th>Node</th><th>Type</th><th>Seen</th><th>Unique</th><th>Gaps</th><th>Last seq</th></tr></thead><tbody>{mesh.nodes.map((node) => <tr key={node.id}><td>{node.id}</td><td>{node.kind}</td><td>{node.packets}</td><td>{node.uniquePackets}</td><td>{node.missedPackets}</td><td>{node.lastSequence}</td></tr>)}</tbody></table></div>}
      {mesh.health && <details className="technical"><summary>Radio and relay detail</summary><dl><div><dt>Average SNR</dt><dd>{health.avg_snr ?? "—"} dB</dd></div><div><dt>Accepted</dt><dd>{health.accepted ?? "—"}</dd></div><div><dt>Relayed</dt><dd>{health.relayed ?? "—"}</dd></div><div><dt>Queue / drops</dt><dd>{health.queue ?? "—"} / {health.queue_drops ?? "—"}</dd></div></dl></details>}
    </div>
  </div>;
}
