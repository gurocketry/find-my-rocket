import { useState } from "react";
import { ManualLocationDialog } from "../components/ManualLocationDialog.jsx";
import { useTracker } from "../tracker/TrackerContext.jsx";

export function SetupView() {
  const { status, transportAvailable, baudRate, setBaudRate, toggleConnection, locating, userLocation, useDeviceLocation } = useTracker();
  const [manualOpen, setManualOpen] = useState(false);
  return <section className="page setup-view">
    <div className="page-heading"><p className="eyebrow">FIELD SETUP</p><h1>Ground station</h1><p>Connect the receiver and set your recovery position.</p></div>
    <div className="setup-stack">
      <div className="setup-card glass"><div className="setup-card-heading"><span className={`step-icon ${status.connected ? "complete" : ""}`}>{status.connected ? "✓" : "1"}</span><div><h2>Receiver</h2><p>{status.detail}</p></div></div><div className="setup-controls"><button className="primary" disabled={!transportAvailable} onClick={toggleConnection}>{status.connected ? "Disconnect" : "Connect board"}</button><label>BAUD<select value={baudRate} disabled={status.connected} onChange={(event) => setBaudRate(Number(event.target.value))}><option>115200</option><option>9600</option></select></label></div></div>
      <div className="setup-card glass"><div className="setup-card-heading"><span className={`step-icon ${userLocation ? "complete" : ""}`}>{userLocation ? "✓" : "2"}</span><div><h2>Recovery position</h2><p>{userLocation ? userLocation.source === "gps" ? `Device GPS accurate to ±${Math.round(userLocation.accuracy)} m.` : `${userLocation.lat.toFixed(5)}, ${userLocation.lon.toFixed(5)}` : "Needed for range, bearing, and ground-station sharing."}</p></div></div><div className="button-row"><button className={!userLocation ? "primary" : ""} onClick={useDeviceLocation}>{locating ? "Locating…" : "Use device GPS"}</button><button onClick={() => setManualOpen(true)}>Enter coordinates</button></div></div>
    </div>
    <ManualLocationDialog open={manualOpen} onClose={() => setManualOpen(false)} />
  </section>;
}
