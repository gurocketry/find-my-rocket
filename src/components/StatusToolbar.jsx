import { useEffect, useState } from "react";
import { useTracker } from "../tracker/TrackerContext.jsx";
import { STAGES, decodeFaults } from "../telemetry.js";

function RocketStage({ stage }) {
  const grounded = stage === 0 || stage === 4 || stage == null;
  return <svg className={`rocket-stage rocket-stage-${stage ?? "none"}`} viewBox="0 0 66 50" role="img" aria-label={`Rocket ${STAGES.get(stage) || "waiting"}`}>
    {grounded && <g className="rocket-rail"><path d="M11 3v43M8 46h12M11 13h12M11 35h12" /></g>}
    <g className="rocket-body"><path d="M34 4Q43 12 43 22v17H25V22Q25 12 34 4Z" /><circle cx="34" cy="21" r="4" /><path d="m25 30-7 11h7m18-11 7 11h-7M30 39v5h8v-5" /></g>
    {stage === 1 && <path className="rocket-flame" d="M30 44q0 5 4 6 4-1 4-6l-4 3Z" />}
    {stage === 3 && <path className="rocket-chute" d="M20 9q14-14 28 0M20 9l8 15m20-15-8 15" />}
  </svg>;
}

export function StatusToolbar({ onConnect }) {
  const { point, status, lastPacketAt } = useTracker();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const age = lastPacketAt ? Math.max(0, Math.floor((now - new Date(lastPacketAt).getTime()) / 1000)) : null;
  const gpsFault = point ? decodeFaults(point.flags, { legacy: point.faultEncoding === "uint32" }).find((item) => item.name === "GPS") : null;
  const fix = !!point && (point.sats != null ? point.sats >= 4 : gpsFault?.code === 1);
  const fresh = status.connected && age !== null && age < 15;
  return <div className="status-toolbar" aria-label="Flight status">
    <div className="toolbar-item"><span>LAST PACKET</span><strong className={fresh ? "good-text" : ""}>{age === null ? "—" : `${age}s ago`}</strong></div>
    <div className="toolbar-item"><span>ROCKET GPS</span><strong className="fix-value"><i className={`fix-light ${fix && fresh ? "on" : ""}`} />{!point ? "WAITING" : fix && fresh ? "FIX" : "NO FIX"}</strong></div>
    <div className="toolbar-stage"><RocketStage stage={point?.stage} /><span>{STAGES.get(point?.stage) || "WAITING"}</span></div>
    {!status.connected && <button className="toolbar-connect" onClick={onConnect}>Connect device</button>}
  </div>;
}
