import { useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Bangalore center
const DEFAULT_CENTER = [12.97, 77.59];
const DEFAULT_ZOOM   = 13;

// ─── Marker factories ──────────────────────────────────────────────────────

function poleClass(pole) {
  if (pole.energized === true)  return 'pole-live';
  if (pole.energized === false) return 'pole-dark';
  return 'pole-unknown';
}

function makeCircleIcon(className, size = 8) {
  return L.divIcon({
    className: `pole-marker ${className}`,
    iconSize:  [size, size],
    iconAnchor:[size / 2, size / 2],
  });
}

function makeDtIcon() {
  return L.divIcon({
    className: 'dt-marker',
    iconSize:  [10, 10],
    iconAnchor:[5, 5],
  });
}

function makeFaultIcon() {
  return L.divIcon({
    className: 'fault-pin',
    iconSize:  [14, 14],
    iconAnchor:[7, 7],
  });
}

// ─── Component ────────────────────────────────────────────────────────────

export default function NetworkMap({ topology, tickets, selectedTicket, onPoleClick, onTicketSelect }) {
  const containerRef = useRef(null);
  const mapRef       = useRef(null);
  const layersRef    = useRef({ poles: null, dts: null, faults: null, edges: null });

  // ── Init map ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: DEFAULT_CENTER,
      zoom:   DEFAULT_ZOOM,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(map);

    layersRef.current.poles = L.layerGroup().addTo(map);
    layersRef.current.dts   = L.layerGroup().addTo(map);
    layersRef.current.faults = L.layerGroup().addTo(map);
    layersRef.current.edges  = L.layerGroup().addTo(map);

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── Draw topology ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !topology) return;

    const { poles: poleLayer, dts: dtLayer, edges: edgeLayer } = layersRef.current;
    poleLayer.clearLayers();
    dtLayer.clearLayers();
    edgeLayer.clearLayers();

    const poleMap = new Map(topology.poles.map((p) => [p.pole_id, p]));

    // Draw edges first (under poles)
    for (const edge of topology.edges) {
      const child  = poleMap.get(edge.child_pole_id);
      const parent = edge.parent_pole_id ? poleMap.get(edge.parent_pole_id) : null;
      if (!child) continue;

      // Find parent coords: if no parent pole, use DT coords
      let parentLatLon;
      if (parent) {
        parentLatLon = [parseFloat(parent.lat), parseFloat(parent.lon)];
      } else {
        const dt = topology.dts.find((d) => d.dt_id === edge.dt_id);
        if (dt) parentLatLon = [parseFloat(dt.lat), parseFloat(dt.lon)];
      }

      if (!parentLatLon) continue;

      const childLatLon = [parseFloat(child.lat), parseFloat(child.lon)];
      L.polyline([parentLatLon, childLatLon], {
        color: edge.inferred ? 'rgba(99,137,255,0.18)' : 'rgba(99,137,255,0.28)',
        weight: edge.inferred ? 1 : 1.5,
        dashArray: edge.inferred ? '3,4' : null,
      }).addTo(edgeLayer);
    }

    // Draw poles
    for (const pole of topology.poles) {
      const cls = poleClass(pole);
      const size = pole.has_device ? 8 : 5;
      const marker = L.marker([parseFloat(pole.lat), parseFloat(pole.lon)], {
        icon: makeCircleIcon(cls, size),
        title: `${pole.pole_id} (${pole.energized === true ? 'LIVE' : pole.energized === false ? 'DARK' : 'UNKNOWN'})`,
      });

      marker.on('click', () => onPoleClick?.(pole));
      marker.addTo(poleLayer);
      // store ref for live updates
      marker._poleId = pole.pole_id;
      marker._currentClass = cls;
    }

    // Draw DTs
    for (const dt of topology.dts) {
      const marker = L.marker([parseFloat(dt.lat), parseFloat(dt.lon)], {
        icon: makeDtIcon(),
        title: `DT: ${dt.dt_id} (${dt.households_served} households)`,
        zIndexOffset: 100,
      });
      marker.bindTooltip(`<b>${dt.dt_id}</b><br>${dt.households_served} households`, {
        className: 'leaflet-tooltip-dark',
        direction: 'top',
      });
      marker.addTo(dtLayer);
    }
  }, [topology, onPoleClick]);

  // ── Draw fault pins ────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current) return;

    layersRef.current.faults.clearLayers();

    const openTickets = (tickets || []).filter(
      (t) => !['verified', 'closed'].includes(t.status)
    );

    for (const ticket of openTickets) {
      if (!ticket.fault_lat || !ticket.fault_lon) continue;

      const icon  = makeFaultIcon();
      const marker = L.marker([ticket.fault_lat, ticket.fault_lon], {
        icon,
        zIndexOffset: 500,
        title: `Fault: ${ticket.fault_type.toUpperCase()} | ${ticket.affected_poles} poles | ${ticket.confidence}`,
      });

      marker.on('click', () => onTicketSelect?.(ticket));
      marker.bindTooltip(
        `<b>${ticket.fault_type.toUpperCase()} FAULT</b><br>` +
        `${ticket.affected_poles} poles · ${ticket.estimated_households} households<br>` +
        `Confidence: ${ticket.confidence}`,
        { direction: 'top', className: 'leaflet-tooltip-fault' }
      );
      marker.addTo(layersRef.current.faults);
    }
  }, [tickets, onTicketSelect]);

  // ── Pan to selected ticket ─────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || !selectedTicket?.fault_lat) return;
    mapRef.current.setView(
      [selectedTicket.fault_lat, selectedTicket.fault_lon],
      16,
      { animate: true }
    );
  }, [selectedTicket]);

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
  );
}
