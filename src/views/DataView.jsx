import { useMemo } from "react";
import { useTracker } from "../tracker/TrackerContext.jsx";
import { Metric } from "../components/Metric.jsx";

function Chart({ title, unit, values, apogeeIndex }) {
  const valid = values.filter(Number.isFinite);
  const min = Math.min(0, ...valid);
  const max = Math.max(1, ...valid);
  const width = 600, height = 150, pad = 14;
  const x = (i) => pad + i * (width - pad * 2) / Math.max(1, values.length - 1);
  const y = (v) => height - pad - (v - min) / (max - min) * (height - pad * 2);
  const points = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  return <article className="chart-card glass"><div className="card-title"><h2>{title}</h2><span>{unit}</span></div><div className="chart-wrap"><svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${title} over received flight packets`}><path d={`M${pad} ${y(0)}H${width - pad}`} className="chart-zero" />{values.length > 1 && <polyline points={points} className="chart-line" />}{apogeeIndex != null && <><path d={`M${x(apogeeIndex)} ${pad}V${height - pad}`} className="chart-marker" /><circle cx={x(apogeeIndex)} cy={y(values[apogeeIndex])} r="4" className="chart-dot" /></>}</svg></div><div className="chart-axis"><span>{min.toFixed(0)}</span><span>{max.toFixed(0)}</span></div>{!values.length && <p className="chart-empty">Waiting for flight telemetry…</p>}</article>;
}

export function DataView() {
  const { point, trackPoints, velocity } = useTracker();
  const data = useMemo(() => {
    const heights = trackPoints.map((p) => p.alt);
    const speeds = trackPoints.map((p, i) => {
      if (!i) return 0;
      let dt = p.elapsed - trackPoints[i - 1].elapsed;
      if (dt < 0) dt += 86400;
      return dt > 0 ? (p.alt - trackPoints[i - 1].alt) / dt : 0;
    });
    const maxHeight = heights.length ? Math.max(...heights) : null;
    const peakIndex = heights.indexOf(maxHeight);
    const apogeeIndex = trackPoints.findIndex((p, i) => i > 0 && p.stage === 3 && trackPoints[i - 1].stage !== 3);
    return { heights, speeds, maxHeight, apogeeIndex: apogeeIndex >= 0 ? peakIndex : null, maxSpeed: speeds.length ? Math.max(...speeds.map(Math.abs)) : null };
  }, [trackPoints]);
  return <section className="page data-view"><div className="page-heading compact"><div><p className="eyebrow">FLIGHT DATA</p><h1>Data</h1></div></div>
    <div className="data-summary summary-grid"><Metric label="Height" value={point?.alt?.toFixed(1)} unit="m" /><Metric label="Max height" value={data.maxHeight?.toFixed(1)} unit="m" /><Metric label="Vertical speed" value={point ? velocity.vertical.toFixed(1) : null} unit="m/s" /><Metric label="Peak speed" value={data.maxSpeed?.toFixed(1)} unit="m/s" /></div>
    <div className="apogee-note">{data.apogeeIndex !== null ? `Apogee detected at ${data.heights[data.apogeeIndex]?.toFixed(1)} m` : data.maxHeight !== null ? `Highest recorded point: ${data.maxHeight.toFixed(1)} m · Apogee not yet detected` : "Apogee will appear after descent begins."}</div>
    <div className="charts"><Chart title="Height" unit="m" values={data.heights} apogeeIndex={data.apogeeIndex} /><Chart title="Vertical velocity" unit="m/s" values={data.speeds} apogeeIndex={data.apogeeIndex} /></div>
  </section>;
}
