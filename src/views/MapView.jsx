import { useEffect, useRef } from "react";
import L from "leaflet";
import { useTracker } from "../tracker/TrackerContext.jsx";

const centre = [55.8708, -4.2898];
const icon = (className, html, size) => L.divIcon({ className, html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] });

export function MapView({ active }) {
  const target = useRef(null);
  const mapState = useRef(null);
  const { point, trackPoints, prediction, groundStations, userLocation } = useTracker();
  useEffect(() => {
    const map = L.map(target.current, { zoomControl: false }).setView(centre, 14);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" }).addTo(map);
    mapState.current = { map, rocket: L.marker(centre, { icon: icon("rocket-marker", "<span>▲</span>", 36), zIndexOffset: 1000 }), user: L.marker(centre, { icon: icon("user-marker", "<span></span>", 22) }), accuracy: L.circle(centre, { radius: 1, color: "#276c43", fillOpacity: .12, weight: 1 }), flown: L.polyline([], { color: "#1e1e1c", weight: 4 }).addTo(map), predicted: L.polyline([], { color: "#d8a900", weight: 3, dashArray: "8 10" }).addTo(map), grounds: new Map(), centered: false };
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(target.current);
    return () => { observer.disconnect(); map.remove(); };
  }, []);
  useEffect(() => { if (active) requestAnimationFrame(() => mapState.current?.map.invalidateSize()); }, [active]);
  useEffect(() => {
    const state = mapState.current; if (!state) return;
    state.flown.setLatLngs(trackPoints.map((item) => [item.lat, item.lon]));
    state.predicted.setLatLngs(prediction.map((item) => [item.lat, item.lon]));
    if (point) { state.rocket.setLatLng([point.lat, point.lon]).addTo(state.map); if (!state.centered) { state.map.setView([point.lat, point.lon], 16); state.centered = true; } }
    if (userLocation) { state.user.setLatLng([userLocation.lat, userLocation.lon]).addTo(state.map); if (userLocation.accuracy) state.accuracy.setLatLng([userLocation.lat, userLocation.lon]).setRadius(userLocation.accuracy).addTo(state.map); else state.accuracy.remove(); }
    groundStations.forEach((station) => { let marker = state.grounds.get(station.sender); if (!marker) { marker = L.marker([station.lat, station.lon], { icon: icon("ground-marker", "<span></span>", 25) }).addTo(state.map).bindTooltip(`GROUND ${station.sender}`); state.grounds.set(station.sender, marker); } else marker.setLatLng([station.lat, station.lon]); });
  }, [point, trackPoints, prediction, groundStations, userLocation]);
  return <div className="map-view">
    <div ref={target} className="map" aria-label="Rocket tracking map" />
  </div>;
}
