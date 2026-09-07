import { useEffect, useState } from "react";
import { useTracker } from "../tracker/TrackerContext.jsx";
import { formatPacketTime } from "../tracker/formatters.js";
import { MapView } from "../views/MapView.jsx";
import { CompassView } from "../views/CompassView.jsx";
import { SystemsView } from "../views/SystemsView.jsx";
import { SetupView } from "../views/SetupView.jsx";

const tabs = [
  ["map", "⌖", "Track"], ["compass", "➤", "Recover"], ["systems", "◌", "Systems"], ["setup", "⚙", "Setup"],
];

export function AppShell() {
  const { status, lastPacketAt } = useTracker();
  const [active, setActive] = useState("map");
  const [installPrompt, setInstallPrompt] = useState(null);
  useEffect(() => {
    const capture = (event) => { event.preventDefault(); setInstallPrompt(event); };
    window.addEventListener("beforeinstallprompt", capture);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);
  const install = async () => { await installPrompt?.prompt(); await installPrompt?.userChoice; setInstallPrompt(null); };

  return <main className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark">▲</span><div><strong>ASTRA</strong><small>GROUND TRACKER</small></div></div>
      <div className="header-status">
        {lastPacketAt && <time dateTime={lastPacketAt} title={new Date(lastPacketAt).toLocaleString()}>{formatPacketTime(lastPacketAt)}</time>}
        <span className={`connection ${status.connected ? "online" : ""}`}><i />{status.connected ? "LIVE" : "OFFLINE"}</span>
      </div>
    </header>
    <div className="workspace">
      <section hidden={active !== "map"}><MapView active={active === "map"} /></section>
      {active === "compass" && <CompassView />}
      {active === "systems" && <SystemsView />}
      {active === "setup" && <SetupView />}
    </div>
    <nav className="tab-bar" aria-label="Tracker views">
      {tabs.map(([id, icon, label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => setActive(id)} aria-current={active === id ? "page" : undefined}><span>{icon}</span>{label}</button>)}
    </nav>
    {installPrompt && <aside className="install-card"><span>Ready for offline use</span><button onClick={install}>Install</button></aside>}
  </main>;
}
