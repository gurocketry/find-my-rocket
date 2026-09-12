import { useEffect, useState } from "react";
import { useTracker } from "../tracker/TrackerContext.jsx";
import { MapView } from "../views/MapView.jsx";
import { CompassView } from "../views/CompassView.jsx";
import { SystemsView } from "../views/SystemsView.jsx";
import { SetupView } from "../views/SetupView.jsx";
import { DataView } from "../views/DataView.jsx";
import { LogView } from "../views/LogView.jsx";
import { StatusToolbar } from "./StatusToolbar.jsx";

const tabs = [["telemetry", "⌖", "Telemetry"], ["data", "⌁", "Data"], ["device", "◌", "Device"], ["log", "≡", "Log"]];

export function AppShell() {
  const { status } = useTracker();
  const [active, setActive] = useState("telemetry");
  const [connectOpen, setConnectOpen] = useState(() => sessionStorage.getItem("tracker-setup-seen") !== "yes" && sessionStorage.getItem("tracker-connected-once") !== "yes");
  const [installPrompt, setInstallPrompt] = useState(null);
  useEffect(() => {
    if (status.connected) { sessionStorage.setItem("tracker-setup-seen", "yes"); setConnectOpen(false); }
  }, [status.connected]);
  useEffect(() => {
    const capture = (event) => { event.preventDefault(); setInstallPrompt(event); };
    window.addEventListener("beforeinstallprompt", capture);
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
    return () => window.removeEventListener("beforeinstallprompt", capture);
  }, []);
  const install = async () => { await installPrompt?.prompt(); await installPrompt?.userChoice; setInstallPrompt(null); };
  const closeConnection = () => { sessionStorage.setItem("tracker-setup-seen", "yes"); setConnectOpen(false); };
  return <main className="app-shell">
    <StatusToolbar onConnect={() => setConnectOpen(true)} />
    <div className="workspace">
      <div className="mobile-workspace">
        <section className="telemetry-view" hidden={active !== "telemetry"}><div className="telemetry-map"><MapView active={active === "telemetry"} /></div><CompassView /></section>
        {active === "data" && <DataView />}{active === "device" && <SystemsView />}{active === "log" && <LogView />}
      </div>
      <div className="desktop-dashboard"><section className="desktop-map"><h2>Telemetry map</h2><MapView active /></section><section className="desktop-compass"><CompassView /></section><section className="desktop-data"><DataView /></section><section className="desktop-device"><SystemsView /></section><section className="desktop-log"><LogView /></section></div>
    </div>
    <nav className="tab-bar" aria-label="Tracker views">{tabs.map(([id, icon, label]) => <button key={id} className={active === id ? "active" : ""} onClick={() => setActive(id)} aria-current={active === id ? "page" : undefined}><span>{icon}</span>{label}</button>)}</nav>
    {connectOpen && <div className="connect-wall" role="dialog" aria-modal="true" aria-label="Connection settings"><div className="connect-dialog"><button className="close-dialog" onClick={closeConnection} aria-label="Close connection settings">×</button><SetupView /></div></div>}
    {installPrompt && <aside className="install-card"><span>Ready for offline use</span><button onClick={install}>Install</button></aside>}
  </main>;
}
