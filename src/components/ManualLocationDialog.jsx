import { useEffect, useRef, useState } from "react";
import { useTracker } from "../tracker/TrackerContext.jsx";

export function ManualLocationDialog({ open, onClose }) {
  const dialog = useRef(null);
  const { userLocation, useManualLocation } = useTracker();
  const [error, setError] = useState("");
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const submit = (event) => {
    event.preventDefault();
    try { useManualLocation(Number(event.currentTarget.latitude.value), Number(event.currentTarget.longitude.value)); setError(""); onClose(); }
    catch (nextError) { setError(nextError.message); }
  };
  return <dialog ref={dialog} className="dialog" onClose={onClose}>
    <form onSubmit={submit}>
      <p className="eyebrow">RECOVERY POSITION</p><h2>Enter coordinates</h2>
      <p className="supporting">Used for range and bearing, and shared with the board every 10 seconds.</p>
      <div className="field-grid">
        <label>Latitude<input name="latitude" type="number" min="-90" max="90" step="any" defaultValue={userLocation?.lat} placeholder="55.870758" required /></label>
        <label>Longitude<input name="longitude" type="number" min="-180" max="180" step="any" defaultValue={userLocation?.lon} placeholder="-4.286921" required /></label>
      </div>
      <p className="form-error" role="alert">{error}</p>
      <div className="button-row end"><button type="button" onClick={onClose}>Cancel</button><button className="primary">Use coordinates</button></div>
    </form>
  </dialog>;
}
