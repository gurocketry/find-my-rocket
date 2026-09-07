import { useState } from "react";
import { useTracker } from "../tracker/TrackerContext.jsx";
import { MeshPanel } from "../components/MeshPanel.jsx";
import { FaultPanel } from "../components/FaultPanel.jsx";
import { LogPanel } from "../components/LogPanel.jsx";

export function SystemsView() {
  const { faults, point, mesh, rejectedCount } = useTracker();
  const [panel, setPanel] = useState(faults.length ? "faults" : "network");
  return <section className="page systems-view">
    <div className="page-heading compact"><div><p className="eyebrow">DIAGNOSTICS</p><h1>Systems</h1></div><span className={`health-pill ${faults.length ? "bad" : point ? "good" : ""}`}>{faults.length ? `${faults.length} FAULT${faults.length === 1 ? "" : "S"}` : point ? "NOMINAL" : "WAITING"}</span></div>
    <nav className="segmented" aria-label="System detail">
      <button className={panel === "network" ? "active" : ""} onClick={() => setPanel("network")}>Network <b>{mesh.nodes.length}</b></button>
      <button className={panel === "faults" ? "active" : ""} onClick={() => setPanel("faults")}>Faults {faults.length > 0 && <b className="alert-count">{faults.length}</b>}</button>
      <button className={panel === "log" ? "active" : ""} onClick={() => setPanel("log")}>Log {rejectedCount > 0 && <b>{rejectedCount}</b>}</button>
    </nav>
    {panel === "network" && <MeshPanel />}{panel === "faults" && <FaultPanel />}{panel === "log" && <LogPanel />}
  </section>;
}
