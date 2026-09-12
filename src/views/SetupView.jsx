import { useState } from "react";
import { ManualLocationDialog } from "../components/ManualLocationDialog.jsx";
import { useTracker } from "../tracker/TrackerContext.jsx";

export function SetupView() {
  const { status, transportAvailable, baudRate, setBaudRate, toggleConnection, locating, userLocation, useDeviceLocation } = useTracker();
  const [manualOpen, setManualOpen] = useState(false);
  const issue = !transportAvailable || /failed|lost|unavailable|error|HTTPS|Chrome|Edge/i.test(status.detail);
  return <section className="page setup-view">
    <div className="setup-stack">
      <div className="setup-card glass"><h2>Receiver</h2>{issue && <p role="status">{status.detail}</p>}<div className="setup-controls"><button className="primary" disabled={!transportAvailable} onClick={toggleConnection}>{status.connected ? "Disconnect" : "Connect board"}</button><label>BAUD<select value={baudRate} disabled={status.connected} onChange={(event) => setBaudRate(Number(event.target.value))}><option>115200</option><option>9600</option></select></label></div></div>
      <div className="setup-card glass"><h2>Recovery position</h2>{userLocation && <p>{userLocation.source === "gps" ? `GPS ±${Math.round(userLocation.accuracy)} m` : `${userLocation.lat.toFixed(5)}, ${userLocation.lon.toFixed(5)}`}</p>}<div className="button-row"><button className={!userLocation ? "primary" : ""} onClick={useDeviceLocation}>{locating ? "Locating…" : "Use device GPS"}</button><button onClick={() => setManualOpen(true)}>Enter coordinates</button></div></div>
    </div>
    <ManualLocationDialog open={manualOpen} onClose={() => setManualOpen(false)} />
  </section>;
}
