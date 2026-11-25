// Module Planning : horaires, temps de travail par instrument, trajets OSRM & optimisation
(() => {
  const optimSuggestions = new Map();

  function listTourDays(tournee) {
    if (!tournee?.date_debut || !tournee?.date_fin) return [];
    const days = [];
    const [sy, sm, sd] = tournee.date_debut.split("-").map(Number);
    const [ey, em, ed] = tournee.date_fin.split("-").map(Number);
    let cur = new Date(Date.UTC(sy, sm - 1, sd));
    const end = new Date(Date.UTC(ey, em - 1, ed));
    let guard = 0;
    while (cur <= end && guard < 31) {
      days.push(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
      guard += 1;
    }
    return days;
  }

  function parseMinutes(hhmm) {
    if (!hhmm) return 8 * 60 + 30;
    const [h, m] = hhmm.slice(0, 5).split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  function formatMinutes(totalMin) {
    const h = Math.floor(totalMin / 60) % 24;
    const m = Math.round(totalMin % 60);
    return `${String(h).padStart(2, "0")}h${String(m).padStart(2, "0")}`;
  }

  function formatDuration(hours) {
    const mins = Math.round(hours * 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function thresholdBadge(amplitudeH) {
    if (amplitudeH > 9) return `<span class="badge badge-danger">Charge élevée (${formatDuration(amplitudeH)})</span>`;
    if (amplitudeH >= 7.5) return `<span class="badge badge-warn">Journée serrée (${formatDuration(amplitudeH)})</span>`;
    return `<span class="badge badge-ok">Confortable (${formatDuration(amplitudeH)})</span>`;
  }

  async function render({ tournee, demandes, startTime, onActions }) {
    const container = document.getElementById("planning-days-container");
    if (!container || !tournee) return;

    const days = listTourDays(tournee);
    const nbLuthiers = Number(tournee.nb_luthiers || 2);
    const activeDemandes = demandes.filter((d) => d.statut !== "annule" && d.statut !== "doublon");
    const dayStartMin = parseMinutes(startTime || "08:30");

    const dayBuckets = new Map(days.map((d) => [d, []]));
    const unplanned = [];

    for (const d of activeDemandes) {
      if (d.jour_date && dayBuckets.has(d.jour_date)) {
        dayBuckets.get(d.jour_date).push(d);
      } else {
        unplanned.push(d);
      }
    }

    for (const arr of dayBuckets.values()) {
      arr.sort((a, b) => (a.ordre_jour || 0) - (b.ordre_jour || 0) || (a.heure_debut || "99:99").localeCompare(b.heure_debut || "99:99"));
    }

    container.innerHTML = `<div class="empty-state">Calcul des trajets routiers OSRM...</div>`;

    const renderedCards = [];
    for (const dayIso of days) {
      const stops = dayBuckets.get(dayIso) || [];
      // eslint-disable-next-line no-await-in-loop
      const legs = await window.PianissimoRouting.computeDayLegs(stops);

      const workshopTotalH = stops.reduce((acc, s) => acc + Number(s.duree_estimee_h || 0), 0);
      // En mode 2 luthiers, un arrêt avec >= 2 harpes ou un parc se parallélise
      const workshopEffH =
        nbLuthiers >= 2
          ? stops.reduce((acc, s) => {
              const h = Number(s.duree_estimee_h || 0);
              const harps = Number(s.nb_concert || 0) + Number(s.nb_etude || 0) + Number(s.nb_celtique || 0) + Number(s.nb_inconnu || 0);
              return acc + (harps >= 2 || h >= 4.5 ? h / 2 : h);
            }, 0)
          : workshopTotalH;

      const travelTotalMin = legs.reduce((acc, l) => acc + (l.minutes || 0), 0);
      const amplitudeH = workshopEffH + travelTotalMin / 60;
      const totalHarps = stops.reduce(
        (acc, s) => acc + Number(s.nb_concert || 0) + Number(s.nb_etude || 0) + Number(s.nb_celtique || 0) + Number(s.nb_inconnu || 0),
        0,
      );

      let cursorMin = dayStartMin;
      const stopHtmlParts = [];

      stops.forEach((s, idx) => {
        if (idx > 0) {
          const leg = legs[idx - 1];
          cursorMin += leg.minutes;
          stopHtmlParts.push(
            `<div class="route-leg">${leg.minutes} min · ${leg.km} km (${leg.source === "osrm" ? "OSRM" : "estimé"})</div>`,
          );
        }

        if (s.creneau_epingle && s.heure_debut) {
          const pinnedMin = parseMinutes(s.heure_debut);
          if (pinnedMin > cursorMin) cursorMin = pinnedMin;
        }

        const durH = Number(s.duree_estimee_h || 0);
        const harps = Number(s.nb_concert || 0) + Number(s.nb_etude || 0) + Number(s.nb_celtique || 0) + Number(s.nb_inconnu || 0);
        const effH = nbLuthiers >= 2 && (harps >= 2 || durH >= 4.5) ? durH / 2 : durH;
        const endMin = cursorMin + Math.round(effH * 60);
        const slotLabel = `${formatMinutes(cursorMin)} → ${formatMinutes(endMin)}`;
        cursorMin = endMin;

        const dayOptions = [`<option value="">Non planifié</option>`]
          .concat(days.map((d) => `<option value="${d}" ${d === dayIso ? "selected" : ""}>${window.PianissimoTemplates.formatDayFrench(d)}</option>`))
          .join("");

        stopHtmlParts.push(`
          <article class="stop-card is-${escapeHtml(s.statut)}" data-demande-id="${s.id}">
            <div class="stop-top">
              <div>
                <div class="stop-time">${slotLabel} ${s.heure_debut ? `<span class="badge badge-neutral">souhait ${escapeHtml(s.heure_debut.slice(0, 5))}</span>` : ""}</div>
                <div class="stop-title">${escapeHtml(s.nom)}</div>
              </div>
              <button type="button" class="btn btn-ghost btn-xs js-pin-stop" data-id="${s.id}" title="Épingler / libérer cet arrêt pour l'optimisation">${s.creneau_epingle ? "🔒 Épinglé" : "🔓 Libre"}</button>
            </div>
            <div class="stop-meta">
              ${escapeHtml(s.secteur)} · ${escapeHtml(s.ville)} · <strong>${formatDuration(durH)} atelier</strong> (${escapeHtml(s.instruments_detail || "à préciser")})
            </div>
            ${s.contraintes ? `<div class="stop-meta"><em>${escapeHtml(s.contraintes.slice(0, 140))}${s.contraintes.length > 140 ? "…" : ""}</em></div>` : ""}
            <div class="stop-controls">
              <button type="button" class="btn btn-ghost btn-xs js-move-up" data-day="${dayIso}" data-id="${s.id}" ${idx === 0 ? "disabled" : ""}>↑</button>
              <button type="button" class="btn btn-ghost btn-xs js-move-down" data-day="${dayIso}" data-id="${s.id}" ${idx === stops.length - 1 ? "disabled" : ""}>↓</button>
              <select class="select-sm js-change-day" data-id="${s.id}" aria-label="Déplacer vers un autre jour">${dayOptions}</select>
              <button type="button" class="btn btn-ghost btn-xs js-edit-stop" data-id="${s.id}">Fiche</button>
              <button type="button" class="btn btn-ghost btn-xs js-msg-stop" data-id="${s.id}">Message</button>
            </div>
          </article>
        `);
      });

      const gmapsUrl = window.PianissimoRouting.buildGoogleMapsUrl(stops);
      const optim = optimSuggestions.get(dayIso);
      const optimBanner = optim
        ? `<div class="optim-banner">
             <span>Ordre optimisé OSRM : <strong>${optim.beforeMin} min → ${optim.afterMin} min</strong> (-${optim.beforeMin - optim.afterMin} min de route)</span>
             <div>
               <button type="button" class="btn btn-primary btn-xs js-apply-optim" data-day="${dayIso}">Appliquer</button>
               <button type="button" class="btn btn-ghost btn-xs js-dismiss-optim" data-day="${dayIso}">Ignorer</button>
             </div>
           </div>`
        : "";

      renderedCards.push(`
        <section class="day-column" aria-label="Planning du ${window.PianissimoTemplates.formatDayFrench(dayIso)}">
          <div class="day-header">
            <div>
              <h3>${window.PianissimoTemplates.formatDayFrench(dayIso)}</h3>
              <div class="day-metrics">
                ${thresholdBadge(amplitudeH)}
                <span class="badge badge-neutral">${totalHarps} harpe(s) · ${stops.length} arrêt(s)</span>
                <span class="badge badge-neutral">${formatDuration(workshopTotalH)} atelier (${formatDuration(workshopEffH)} à ${nbLuthiers})</span>
                <span class="badge badge-neutral">${travelTotalMin} min route</span>
              </div>
            </div>
            <div class="day-actions-row">
              <button type="button" class="btn btn-ghost btn-xs js-optimize-day" data-day="${dayIso}" ${stops.length < 3 ? "disabled" : ""}>Optimiser (OSRM)</button>
              ${gmapsUrl ? `<a class="btn btn-ghost btn-xs" href="${gmapsUrl}" target="_blank" rel="noopener">Google Maps ↗</a>` : ""}
            </div>
          </div>
          ${optimBanner}
          ${stopHtmlParts.length ? stopHtmlParts.join("") : `<p class="card-sub">Aucun rendez-vous affecté à cette journée.</p>`}
        </section>
      `);
    }

    // Bloc Non planifiés
    const dayOptionsUnplanned = [`<option value="">Affecter un jour...</option>`]
      .concat(days.map((d) => `<option value="${d}">${window.PianissimoTemplates.formatDayFrench(d)}</option>`))
      .join("");

    const unplannedHtml = unplanned
      .map(
        (u) => `
      <article class="stop-card is-${escapeHtml(u.statut)}">
        <div class="stop-top">
          <div>
            <div class="stop-title">${escapeHtml(u.nom)}</div>
            <div class="stop-meta">${escapeHtml(u.secteur)} · ${escapeHtml(u.ville)} · ${formatDuration(Number(u.duree_estimee_h || 0))}</div>
          </div>
          <span class="badge badge-neutral">${escapeHtml(u.statut)}</span>
        </div>
        <div class="stop-controls">
          <select class="select-sm js-change-day" data-id="${u.id}" aria-label="Affecter à un jour">${dayOptionsUnplanned}</select>
          <button type="button" class="btn btn-ghost btn-xs js-edit-stop" data-id="${u.id}">Fiche</button>
          <button type="button" class="btn btn-ghost btn-xs js-msg-stop" data-id="${u.id}">Message</button>
        </div>
      </article>`,
      )
      .join("");

    renderedCards.push(`
      <section class="day-column" aria-label="Demandes non planifiées">
        <div class="day-header">
          <div>
            <h3>À caler / Non planifiés</h3>
            <div class="day-metrics">
              <span class="badge badge-neutral">${unplanned.length} fiche(s)</span>
            </div>
          </div>
        </div>
        ${unplannedHtml || `<p class="card-sub">Toutes les demandes actives sont affectées à une journée.</p>`}
      </section>
    `);

    container.innerHTML = renderedCards.join("");

    // Bind events
    container.querySelectorAll(".js-pin-stop").forEach((btn) => {
      btn.addEventListener("click", () => onActions.togglePin(btn.dataset.id));
    });
    container.querySelectorAll(".js-move-up").forEach((btn) => {
      btn.addEventListener("click", () => onActions.moveStop(btn.dataset.day, btn.dataset.id, -1));
    });
    container.querySelectorAll(".js-move-down").forEach((btn) => {
      btn.addEventListener("click", () => onActions.moveStop(btn.dataset.day, btn.dataset.id, 1));
    });
    container.querySelectorAll(".js-change-day").forEach((sel) => {
      sel.addEventListener("change", () => onActions.changeDay(sel.dataset.id, sel.value || null));
    });
    container.querySelectorAll(".js-edit-stop").forEach((btn) => {
      btn.addEventListener("click", () => onActions.openDemande(btn.dataset.id));
    });
    container.querySelectorAll(".js-msg-stop").forEach((btn) => {
      btn.addEventListener("click", () => onActions.openMessages(btn.dataset.id));
    });
    container.querySelectorAll(".js-optimize-day").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const day = btn.dataset.day;
        const stops = dayBuckets.get(day) || [];
        btn.disabled = true;
        btn.textContent = "Calcul...";
        const res = await window.PianissimoRouting.optimizeDayOrder(stops);
        if (res.improved) {
          optimSuggestions.set(day, res);
          render({ tournee, demandes, startTime, onActions });
        } else {
          btn.disabled = false;
          btn.textContent = "Déjà optimal ✓";
        }
      });
    });
    container.querySelectorAll(".js-apply-optim").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const day = btn.dataset.day;
        const optim = optimSuggestions.get(day);
        if (!optim) return;
        optimSuggestions.delete(day);
        await onActions.applyOrder(day, optim.order.map((s) => s.id));
      });
    });
    container.querySelectorAll(".js-dismiss-optim").forEach((btn) => {
      btn.addEventListener("click", () => {
        optimSuggestions.delete(btn.dataset.day);
        render({ tournee, demandes, startTime, onActions });
      });
    });
  }

  window.PianissimoPlanning = {
    listTourDays,
    render,
  };
})();
