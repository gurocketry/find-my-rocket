import { useEffect, useRef } from "react";
import { useTracker } from "../tracker/TrackerContext.jsx";

export function LogPanel() {
  const { rawLines, rejectedCount, exportRawLog, reset } = useTracker();
  const log = useRef(null);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [rawLines]);
  const clear = () => { if (window.confirm("Clear all saved and current telemetry? This cannot be undone.")) reset(); };
  return <div className="log-panel">
    <div className="log-toolbar"><span>{rawLines.length} lines{rejectedCount ? ` · ${rejectedCount} rejected` : ""}</span><div className="button-row"><button className="danger" disabled={!rawLines.length} onClick={clear}>Clear</button><button className="primary" disabled={!rawLines.length} onClick={exportRawLog}>Save .txt</button></div></div>
    <pre ref={log} className="raw-log" tabIndex="0">{rawLines.length ? rawLines.join("\n") : "Waiting for serial data…"}</pre>
  </div>;
}
