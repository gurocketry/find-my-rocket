import { useMemo, useState } from "react";
import { ManualLocationDialog } from "../components/ManualLocationDialog.jsx";
import { useTracker } from "../tracker/TrackerContext.jsx";
import { bearingDegrees, distanceMetres } from "../telemetry.js";
import { cardinal, formatDistance } from "../tracker/formatters.js";

export function CompassView() {
  const { point, userLocation, heading, locating, compassEnabled, useDeviceLocation, enableCompass } = useTracker();
  const [manualOpen, setManualOpen] = useState(false);
  const values = useMemo(() => {
    if (!point || !userLocation) return { distance: null, bearing: null, relative: 0 };
    const bearing = bearingDegrees(userLocation, point);
    return { distance: distanceMetres(userLocation, point), bearing, relative: heading === null ? bearing : (bearing - heading + 360) % 360 };
  }, [point, userLocation, heading]);
  const message = !point ? "Waiting for the rocket’s first GPS fix." : !userLocation ? "Add your position to point the recovery arrow." : heading === null ? "Target found. Enable compass for a phone-relative arrow." : "Follow the arrow to the latest rocket fix.";
  return <section className="page compass-view">
    <div className="page-heading"><p className="eyebrow">RECOVERY</p><h1>Direction to rocket</h1><p>{message}</p></div>
    <div className="compass-dial" aria-label="Direction to rocket">
      <span className="north">N</span><span className="east">E</span><span className="south">S</span><span className="west">W</span>
      <div className={`compass-arrow ${values.bearing !== null ? "ready" : ""}`} style={{ transform: `rotate(${values.relative}deg)` }}><span /></div><div className="compass-centre" />
    </div>
    <div className="recovery-readout glass">
      <div><span>DISTANCE</span><strong>{formatDistance(values.distance)}</strong></div>
      <div><span>BEARING</span><strong>{values.bearing === null ? "—" : `${Math.round(values.bearing)}° ${cardinal(values.bearing)}`}</strong></div>
      {heading !== null && <div><span>HEADING</span><strong>{Math.round(heading)}° {cardinal(heading)}</strong></div>}
    </div>
    <div className="button-row compass-actions">
      <button className="primary" onClick={useDeviceLocation}>{locating ? "Locating…" : userLocation?.source === "gps" ? `GPS ±${Math.round(userLocation.accuracy)} m` : "Use my location"}</button>
      <button onClick={() => setManualOpen(true)}>Enter coordinates</button>
      {!compassEnabled && <button onClick={enableCompass}>Enable compass</button>}
    </div>
    <ManualLocationDialog open={manualOpen} onClose={() => setManualOpen(false)} />
  </section>;
}
