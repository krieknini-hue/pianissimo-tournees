// Calcul de trajets routiers OSRM + cache sessionStorage + optimiseur d'ordre
(() => {
  const CACHE_KEY = "pianissimo_osrm_legs_v1";
  let memoryCache = {};
  try {
    memoryCache = JSON.parse(sessionStorage.getItem(CACHE_KEY) || "{}") || {};
  } catch {
    memoryCache = {};
  }

  function saveCache() {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify(memoryCache));
    } catch {
      // Ignore quota errors
    }
  }

  function haversineKm(a, b) {
    const R = 6371;
    const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
    const dLon = ((b.longitude - a.longitude) * Math.PI) / 180;
    const lat1 = (a.latitude * Math.PI) / 180;
    const lat2 = (b.latitude * Math.PI) / 180;
    const h =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  function fallbackLeg(a, b) {
    const km = haversineKm(a, b) * 1.32;
    const minutes = Math.max(4, Math.round((km / 65) * 60));
    return { minutes, km: Math.round(km * 10) / 10, source: "estime" };
  }

  function pairKey(a, b) {
    return `${Number(a.latitude).toFixed(4)},${Number(a.longitude).toFixed(4)}->${Number(b.latitude).toFixed(4)},${Number(b.longitude).toFixed(4)}`;
  }

  async function getLeg(a, b) {
    if (!a?.latitude || !a?.longitude || !b?.latitude || !b?.longitude) {
      return { minutes: 0, km: 0, source: "sans_gps" };
    }
    const key = pairKey(a, b);
    if (memoryCache[key]) return memoryCache[key];

    const url = `https://router.project-osrm.org/route/v1/driving/${a.longitude},${a.latitude};${b.longitude},${b.latitude}?overview=false`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const route = data?.routes?.[0];
      if (!route) throw new Error("No route");
      const leg = {
        minutes: Math.max(2, Math.round(route.duration / 60)),
        km: Math.round((route.distance / 1000) * 10) / 10,
        source: "osrm",
      };
      memoryCache[key] = leg;
      saveCache();
      return leg;
    } catch {
      const est = fallbackLeg(a, b);
      memoryCache[key] = est;
      return est;
    }
  }

  async function computeDayLegs(stops) {
    const legs = [];
    for (let i = 0; i < stops.length - 1; i++) {
      // eslint-disable-next-line no-await-in-loop
      legs.push(await getLeg(stops[i], stops[i + 1]));
    }
    return legs;
  }

  function totalMinutes(order, matrix) {
    let sum = 0;
    for (let i = 0; i < order.length - 1; i++) {
      sum += matrix[`${order[i].id}->${order[i + 1].id}`] || 0;
    }
    return sum;
  }

  function permute(arr) {
    if (arr.length <= 1) return [arr];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permute(rest)) {
        out.push([arr[i], ...p]);
      }
    }
    return out;
  }

  // Optimise uniquement les arrêts non épinglés (<= 7 arrêts libres, sinon heuristique plus proche voisin)
  async function optimizeDayOrder(stops) {
    if (stops.length < 3) {
      return { improved: false, beforeMin: 0, afterMin: 0, order: stops };
    }
    const matrix = {};
    for (let i = 0; i < stops.length; i++) {
      for (let j = 0; j < stops.length; j++) {
        if (i === j) continue;
        // eslint-disable-next-line no-await-in-loop
        const leg = await getLeg(stops[i], stops[j]);
        matrix[`${stops[i].id}->${stops[j].id}`] = leg.minutes;
      }
    }

    const beforeMin = totalMinutes(stops, matrix);
    const fixedSlots = stops.map((s, idx) => (s.creneau_epingle ? idx : -1)).filter((i) => i >= 0);
    const freeStops = stops.filter((s) => !s.creneau_epingle);

    if (freeStops.length < 2) {
      return { improved: false, beforeMin, afterMin: beforeMin, order: stops };
    }

    let bestOrder = stops.slice();
    let bestMin = beforeMin;

    if (freeStops.length <= 6) {
      for (const perm of permute(freeStops)) {
        const candidate = stops.slice();
        let ptr = 0;
        for (let idx = 0; idx < candidate.length; idx++) {
          if (!fixedSlots.includes(idx)) {
            candidate[idx] = perm[ptr++];
          }
        }
        const mins = totalMinutes(candidate, matrix);
        if (mins < bestMin) {
          bestMin = mins;
          bestOrder = candidate;
        }
      }
    } else {
      // Heuristique gloutonne si > 6 arrêts libres
      const remaining = freeStops.slice();
      const candidate = stops.slice();
      let prev = null;
      for (let idx = 0; idx < candidate.length; idx++) {
        if (fixedSlots.includes(idx)) {
          prev = candidate[idx];
          continue;
        }
        let pickIdx = 0;
        if (prev) {
          let bestD = Infinity;
          remaining.forEach((cand, rIdx) => {
            const d = matrix[`${prev.id}->${cand.id}`] ?? Infinity;
            if (d < bestD) {
              bestD = d;
              pickIdx = rIdx;
            }
          });
        }
        const chosen = remaining.splice(pickIdx, 1)[0];
        candidate[idx] = chosen;
        prev = chosen;
      }
      const mins = totalMinutes(candidate, matrix);
      if (mins < bestMin) {
        bestMin = mins;
        bestOrder = candidate;
      }
    }

    return {
      improved: bestMin < beforeMin,
      beforeMin,
      afterMin: bestMin,
      order: bestOrder,
    };
  }

  function buildGoogleMapsUrl(stops) {
    const valid = stops.filter((s) => s.latitude && s.longitude);
    if (!valid.length) return "";
    if (valid.length === 1) {
      return `https://www.google.com/maps/search/?api=1&query=${valid[0].latitude},${valid[0].longitude}`;
    }
    const origin = `${valid[0].latitude},${valid[0].longitude}`;
    const dest = `${valid[valid.length - 1].latitude},${valid[valid.length - 1].longitude}`;
    const wp = valid.slice(1, -1).map((s) => `${s.latitude},${s.longitude}`).join("|");
    return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(dest)}${wp ? `&waypoints=${encodeURIComponent(wp)}` : ""}&travelmode=driving`;
  }

  function clearCache() {
    memoryCache = {};
    saveCache();
  }

  window.PianissimoRouting = {
    getLeg,
    computeDayLegs,
    optimizeDayOrder,
    buildGoogleMapsUrl,
    clearCache,
  };
})();
