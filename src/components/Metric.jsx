export function Metric({ label, value = "—", unit, hero = false }) {
  return <div className={`metric ${hero ? "hero" : ""}`}><span>{label}</span><div><strong>{value}</strong>{unit && <small>{unit}</small>}</div></div>;
}
