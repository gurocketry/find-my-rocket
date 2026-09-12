import { useTracker } from "../tracker/TrackerContext.jsx";
import { MeshPanel } from "../components/MeshPanel.jsx";
import { FaultPanel } from "../components/FaultPanel.jsx";

export function SystemsView() {
  const { faults, point } = useTracker();
  return <section className="page systems-view"><div className="page-heading compact"><div><p className="eyebrow">DIAGNOSTICS</p><h1>Device</h1></div><span className={`health-pill ${faults.length ? "bad" : point ? "good" : ""}`}>{faults.length ? `${faults.length} FAULT${faults.length === 1 ? "" : "S"}` : point ? "NOMINAL" : "WAITING"}</span></div><div className="device-panels"><FaultPanel /><MeshPanel /></div></section>;
}
