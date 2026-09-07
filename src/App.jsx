import { TrackerProvider } from "./tracker/TrackerContext.jsx";
import { AppShell } from "./components/AppShell.jsx";

export function App() {
  return <TrackerProvider><AppShell /></TrackerProvider>;
}
