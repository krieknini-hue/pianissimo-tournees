// Carte interactive Leaflet plein écran : Pôles géographiques (anneaux SVG chiffrés) & Clients (clusters)
(() => {
  let mapInstance = null;
  let polesLayer = null;
  let clientsCluster = null;
  let routeLayer = null;
  let currentMode = "poles";
  let lastDemandes = [];
  let onSelectPoleCb = null;
  let onOpenDemandeCb = null;
  let onOpenMessageCb = null;

  const COLORS = {
    concert: "#B87D14",
    etude: "#2B5B84",
    celtique: "#2B7A50",
    inconnu: "#6B655D",
  };

  function ensureMap() {
    if (mapInstance) return mapInstance;
    const container = document.getElementById("harp-map");
    if (!container) return null;

    mapInstance = L.map(container, { scrollWheelZoom: true }).setView([49.8, 3.8], 7);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap",
      maxZoom: 18,
    }).addTo(mapInstance);

    polesLayer = L.layerGroup().addTo(mapInstance);
    clientsCluster = L.markerClusterGroup({
      maxClusterRadius: 42,
      iconCreateFunction: (cluster) => {
        const markers = cluster.getAllChildMarkers();
        const totalHarps = markers.reduce((acc, m) => acc + (m.options.harpCount || 1), 0);
        const c = markers.reduce((acc, m) => acc + (m.options.counts?.concert || 0), 0);
        const e = markers.reduce((acc, m) => acc + (m.options.counts?.etude || 0), 0);
        const cel = markers.reduce((acc, m) => acc + (m.options.counts?.celtique || 0), 0);
        const inc = markers.reduce((acc, m) => acc + (m.options.counts?.inconnu || 0), 0);
        const svg = buildRingSvg(totalHarps, { concert: c, etude: e, celtique: cel, inconnu: inc }, 42);
        return L.divIcon({
          html: `<div class="pole-bubble">${svg}</div>`,
          className: "pole-pin",
          iconSize: [42, 42],
        });
      },
    });
    routeLayer = L.layerGroup().addTo(mapInstance);
    return mapInstance;
  }

  function harpCounts(d) {
    const concert = Number(d.nb_concert || 0);
    const etude = Number(d.nb_etude || 0);
    const celtique = Number(d.nb_celtique || 0);
    const inconnu = Number(d.nb_inconnu || 0);
    const total = concert + etude + celtique + inconnu;
    return {
      concert,
      etude,
      celtique,
      inconnu,
      total: total > 0 ? total : 1,
      realTotal: total,
    };
  }

  function buildRingSvg(labelNumber, counts, size = 48) {
    const cx = size / 2;
    const r = size / 2 - 4;
    const circ = 2 * Math.PI * r;
    const sum = counts.concert + counts.etude + counts.celtique + counts.inconnu;
    const segments = [];

    if (sum <= 0) {
      segments.push({ color: COLORS.inconnu, len: circ });
    } else {
      for (const key of ["concert", "etude", "celtique", "inconnu"]) {
        if (counts[key] > 0) {
          segments.push({ color: COLORS[key], len: (counts[key] / sum) * circ });
        }
      }
    }

    let offset = 0;
    const circles = segments
      .map((seg) => {
        const s = `<circle cx="${cx}" cy="${cx}" r="${r}" fill="none" stroke="${seg.color}" stroke-width="5.5" stroke-dasharray="${seg.len.toFixed(2)} ${circ.toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}" transform="rotate(-90 ${cx} ${cx})" />`;
        offset += seg.len;
        return s;
      })
      .join("");

    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
        <circle cx="${cx}" cy="${cx}" r="${r - 2}" fill="#FFFFFF" />
        ${circles}
        <text x="${cx}" y="${cx + 4}" text-anchor="middle" font-family="Plus Jakarta Sans, sans-serif" font-size="13" font-weight="700" fill="#231F1B">${labelNumber}</text>
      </svg>
    `;
  }

  function dominantColor(counts) {
    const entries = [
      ["concert", counts.concert],
      ["etude", counts.etude],
      ["celtique", counts.celtique],
      ["inconnu", counts.inconnu],
    ].sort((a, b) => b[1] - a[1]);
    return COLORS[entries[0][0]] || COLORS.inconnu;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderPoles(demandes) {
    polesLayer.clearLayers();
    const groups = new Map();

    for (const d of demandes) {
      if (!d.latitude || !d.longitude || d.statut === "annule" || d.statut === "doublon") continue;
      const key = d.secteur || d.ville || "Autre";
      if (!groups.has(key)) {
        groups.set(key, {
          name: key,
          items: [],
          latSum: 0,
          lonSum: 0,
          concert: 0,
          etude: 0,
          celtique: 0,
          inconnu: 0,
          conflicts: 0,
        });
      }
      const g = groups.get(key);
      g.items.push(d);
      g.latSum += Number(d.latitude);
      g.lonSum += Number(d.longitude);
      g.concert += Number(d.nb_concert || 0);
      g.etude += Number(d.nb_etude || 0);
      g.celtique += Number(d.nb_celtique || 0);
      g.inconnu += Number(d.nb_inconnu || 0);
      if (d.statut === "conflit") g.conflicts += 1;
    }

    for (const g of groups.values()) {
      const lat = g.latSum / g.items.length;
      const lon = g.lonSum / g.items.length;
      const totalHarps = g.concert + g.etude + g.celtique + g.inconnu;
      const ring = buildRingSvg(totalHarps, g, 50);
      const conflictTag = g.conflicts ? ` · ⚠ ${g.conflicts}` : "";
      const icon = L.divIcon({
        html: `<div class="pole-bubble">${ring}<span class="pole-label">${escapeHtml(g.name)} (${g.items.length})${conflictTag}</span></div>`,
        className: "pole-pin",
        iconSize: [1, 1],
      });

      const marker = L.marker([lat, lon], { icon });
      marker.on("click", () => {
        if (onSelectPoleCb) onSelectPoleCb(g.name);
        const pts = g.items.map((it) => [it.latitude, it.longitude]);
        if (pts.length === 1) {
          mapInstance.setView(pts[0], 13);
        } else if (pts.length > 1) {
          mapInstance.fitBounds(L.latLngBounds(pts), { padding: [50, 50], maxZoom: 13 });
        }
      });
      marker.bindTooltip(
        `<strong>${escapeHtml(g.name)}</strong><br/>${totalHarps} harpe(s) · ${g.items.length} fiche(s)<br/>Concert: ${g.concert} · Étude: ${g.etude} · Celtique: ${g.celtique}`,
        { direction: "top", offset: [0, -24] },
      );
      marker.addTo(polesLayer);
    }
  }

  function renderClients(demandes) {
    clientsCluster.clearLayers();
    for (const d of demandes) {
      if (!d.latitude || !d.longitude) continue;
      const counts = harpCounts(d);
      const bg = dominantColor(counts);
      const conflictClass = d.statut === "conflit" ? "has-conflict" : "";
      const icon = L.divIcon({
        html: `<div class="client-badge ${conflictClass}" style="background:${bg}">${counts.realTotal || "?"}</div>`,
        className: "client-pin",
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });

      const marker = L.marker([d.latitude, d.longitude], {
        icon,
        harpCount: counts.realTotal || 1,
        counts,
      });

      const popupEl = document.createElement("div");
      popupEl.innerHTML = `
        <strong>${escapeHtml(d.nom)}</strong><br/>
        <span style="color:#6B6257;font-size:12px;">${escapeHtml(d.secteur)} · ${escapeHtml(d.ville)}</span><br/>
        <div style="margin:4px 0;font-size:12px;">${escapeHtml(d.instruments_detail || "Modèle à préciser")}</div>
        <div style="font-size:12px;">Statut : <strong>${escapeHtml(d.statut)}</strong> · ${Number(d.duree_estimee_h || 0)}h</div>
        <div style="display:flex;gap:6px;margin-top:8px;">
          <button type="button" class="btn btn-ghost btn-xs js-pop-fiche">Fiche</button>
          <button type="button" class="btn btn-primary btn-xs js-pop-msg">Message</button>
        </div>
      `;
      popupEl.querySelector(".js-pop-fiche").addEventListener("click", () => onOpenDemandeCb && onOpenDemandeCb(d.id));
      popupEl.querySelector(".js-pop-msg").addEventListener("click", () => onOpenMessageCb && onOpenMessageCb(d.id));
      marker.bindPopup(popupEl);
      clientsCluster.addLayer(marker);
    }
  }

  function update(demandes, options = {}) {
    const map = ensureMap();
    if (!map) return;
    lastDemandes = demandes || [];
    if (options.mode) currentMode = options.mode;

    renderPoles(lastDemandes);
    renderClients(lastDemandes);

    if (currentMode === "poles") {
      if (map.hasLayer(clientsCluster)) map.removeLayer(clientsCluster);
      if (!map.hasLayer(polesLayer)) polesLayer.addTo(map);
    } else {
      if (map.hasLayer(polesLayer)) map.removeLayer(polesLayer);
      if (!map.hasLayer(clientsCluster)) clientsCluster.addTo(map);
    }

    if (options.fit) fitAll();
  }

  function showDayRoute(stops) {
    const map = ensureMap();
    if (!map) return;
    routeLayer.clearLayers();
    const pts = (stops || []).filter((s) => s.latitude && s.longitude).map((s) => [s.latitude, s.longitude]);
    if (pts.length < 2) return;
    L.polyline(pts, {
      color: "#9A6612",
      weight: 3.5,
      dashArray: "7 6",
      opacity: 0.9,
    }).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(pts), { padding: [45, 45], maxZoom: 13 });
  }

  function fitAll() {
    if (!mapInstance) return;
    const pts = lastDemandes.filter((d) => d.latitude && d.longitude).map((d) => [d.latitude, d.longitude]);
    if (!pts.length) return;
    mapInstance.fitBounds(L.latLngBounds(pts), { padding: [45, 45], maxZoom: 12 });
  }

  function invalidateSize() {
    if (mapInstance) {
      setTimeout(() => {
        mapInstance.invalidateSize();
      }, 60);
    }
  }

  function initCallbacks({ onSelectPole, onOpenDemande, onOpenMessage }) {
    onSelectPoleCb = onSelectPole;
    onOpenDemandeCb = onOpenDemande;
    onOpenMessageCb = onOpenMessage;
  }

  window.PianissimoMap = {
    update,
    showDayRoute,
    fitAll,
    invalidateSize,
    initCallbacks,
  };
})();
