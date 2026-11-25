// Orchestrateur principal : Hub tournées, atelier plein écran 5 pages, stepper ▲/▼, API VPS
(() => {
  const TAB_ORDER = ["tab-demandes", "tab-carte", "tab-planning", "tab-messages", "tab-finance"];

  const state = {
    tournees: [],
    currentTourneeId: null,
    currentTabIndex: 0,
    demandes: [],
    messages: [],
    brouillons: [],
    anomalies: [],
    mapMode: "poles",
    startTime: "08:30",
    unsubscribeRealtime: null,
    realtimeTimer: null,
  };

  function toast(msg, isError = false) {
    const box = document.getElementById("toast-container");
    if (!box) return;
    const el = document.createElement("div");
    el.className = `toast ${isError ? "is-error" : ""}`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function currentTournee() {
    return state.tournees.find((t) => t.id === state.currentTourneeId) || null;
  }

  function statusMeta(statut) {
    const map = {
      confirme: ["badge-ok", "Confirmé"],
      conflit: ["badge-danger", "Conflit"],
      propose: ["badge-warn", "Proposé"],
      a_qualifier: ["badge-neutral", "À qualifier"],
      contacte: ["badge-etude", "Contacté"],
      a_contacter: ["badge-neutral", "À contacter"],
      doublon: ["badge-neutral", "Doublon"],
      annule: ["badge-neutral", "Annulé"],
    };
    return map[statut] || ["badge-neutral", statut];
  }

  function tourStatusBadge(statut) {
    const stLabels = {
      a_venir: ["badge-neutral", "À venir"],
      en_preparation: ["badge-warn", "En préparation"],
      en_cours: ["badge-ok", "En cours"],
      terminee: ["badge-neutral", "Terminée"],
    };
    return stLabels[statut] || ["badge-neutral", statut];
  }

  function updateStepperUi(index, label) {
    state.currentTabIndex = index;
    const num = `${index + 1}/${TAB_ORDER.length}`;
    document.getElementById("page-stepper-label").textContent = num;
    document.getElementById("ws-page-indicator").textContent = `${num} · ${label}`;
    document.getElementById("btn-page-prev").disabled = index <= 0;
    document.getElementById("btn-page-next").disabled = index >= TAB_ORDER.length - 1;
  }

  function setupAccessibleTabs() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

    function activateTab(tab) {
      if (!tab) return;
      const idx = TAB_ORDER.indexOf(tab.id);

      tabs.forEach((t) => {
        const selected = t === tab;
        t.setAttribute("aria-selected", selected ? "true" : "false");
        t.toggleAttribute("focusgroupstart", selected);
      });

      const targetId = tab.dataset.panel;
      panels.forEach((p) => {
        if (p.id === targetId) {
          p.removeAttribute("hidden");
          p.setAttribute("tabindex", "0");
          p.scrollTop = 0;
        } else {
          p.setAttribute("hidden", "until-found");
          p.removeAttribute("tabindex");
        }
      });

      if (targetId !== "panel-messages") {
        window.PianissimoMessages.setMobileThreadOpen(false);
      }

      updateStepperUi(idx >= 0 ? idx : 0, tab.dataset.label || tab.textContent.trim());
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });

      if (targetId === "panel-carte") {
        window.PianissimoMap.invalidateSize();
        setTimeout(() => {
          if (!document.getElementById("filter-secteur").value) {
            window.PianissimoMap.fitAll();
          }
        }, 90);
      }
    }

    tabs.forEach((tab, idx) => {
      tab.addEventListener("click", () => activateTab(tab));
      tab.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight") {
          e.preventDefault();
          const next = tabs[(idx + 1) % tabs.length];
          next.focus();
          activateTab(next);
        } else if (e.key === "ArrowLeft") {
          e.preventDefault();
          const prev = tabs[(idx - 1 + tabs.length) % tabs.length];
          prev.focus();
          activateTab(prev);
        }
      });
    });

    panels.forEach((panel) => {
      panel.addEventListener("beforematch", () => {
        const tab = tabs.find((t) => t.dataset.panel === panel.id);
        if (tab) activateTab(tab);
      });
    });

    return activateTab;
  }

  function setupNativeDialogs() {
    const dialogs = document.querySelectorAll("dialog");
    dialogs.forEach((dialog) => {
      dialog.addEventListener("close", () => {
        dialog.returnValue = "";
      });
      if (!("closedBy" in HTMLDialogElement.prototype)) {
        const outside = (e) => {
          const r = dialog.getBoundingClientRect();
          return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
        };
        let pressedOutside = false;
        dialog.addEventListener("pointerdown", (e) => {
          pressedOutside = outside(e);
        });
        dialog.addEventListener("pointerup", (e) => {
          if (pressedOutside && outside(e)) dialog.close();
        });
      }
    });

    document.querySelectorAll("[data-close-dialog]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const d = document.getElementById(btn.dataset.closeDialog);
        if (d) d.close();
      });
    });
  }

  function renderTourHub() {
    const select = document.getElementById("hub-tour-select");
    const preferred =
      state.currentTourneeId ||
      (state.tournees.find((t) => t.statut === "en_preparation" || t.statut === "en_cours") || state.tournees[0])?.id ||
      "";

    select.innerHTML = state.tournees
      .map((t) => `<option value="${t.id}" ${t.id === preferred ? "selected" : ""}>${escapeHtml(t.nom)} (${t.date_debut} → ${t.date_fin})</option>`)
      .join("");

    const cards = document.getElementById("hub-tour-cards");
    cards.innerHTML = state.tournees
      .map((t) => {
        const [cls, lbl] = tourStatusBadge(t.statut);
        const isPriority = t.statut === "en_preparation" || t.statut === "en_cours";
        const b = getTourBareme(t);
        return `
          <div class="hub-tour-card ${isPriority ? "is-priority" : ""}">
            <div class="hub-tour-card-top">
              <strong>${escapeHtml(t.nom)}</strong>
              <span class="badge ${cls}">${lbl}</span>
            </div>
            <div style="font-size:0.84rem;color:#6B6257;">${escapeHtml(t.date_debut)} → ${escapeHtml(t.date_fin)} · ${t.nb_luthiers || 2} luthier(s)</div>
            <div style="font-size:0.78rem;color:#6B6257;">Concert ${b.concert_eur}€ (${window.formatDurationH(b.concert_h)}) · Étude ${b.etude_eur}€ (${window.formatDurationH(b.etude_h)}) · Reprise ${b.reprise_eur}€ (${window.formatDurationH(b.reprise_h)}) · Celt. ${b.celtique_eur}€ (${window.formatDurationH(b.celtique_h)})</div>
            ${t.notes ? `<div style="font-size:0.78rem;color:#6B6257;">${escapeHtml(t.notes)}</div>` : ""}
            <div class="hub-tour-card-actions">
              <button type="button" class="btn btn-primary btn-xs js-open-tour" data-tour-id="${t.id}">Ouvrir</button>
              <button type="button" class="btn btn-ghost btn-xs js-edit-tour" data-tour-id="${t.id}">⚙ Tarifs / Modifier</button>
            </div>
          </div>
        `;
      })
      .join("");

    cards.querySelectorAll(".js-open-tour").forEach((btn) => {
      btn.addEventListener("click", () => openTourneeWorkspace(btn.dataset.tourId));
    });
    cards.querySelectorAll(".js-edit-tour").forEach((btn) => {
      btn.addEventListener("click", () => openTourneeDialog(btn.dataset.tourId));
    });
  }

  function getTourBareme(t) {
    return {
      concert_eur: 320,
      concert_h: 2.5,
      etude_eur: 280,
      etude_h: 2.0,
      reprise_eur: 160,
      reprise_h: 1.0,
      celtique_eur: 150,
      celtique_h: 0.75,
      ...(t?.bareme || {}),
    };
  }

  function showHub() {
    document.getElementById("tour-workspace").hidden = true;
    document.getElementById("tour-hub").hidden = false;
    window.PianissimoMessages.setMobileThreadOpen(false);
    renderTourHub();
  }

  function renderTourHeader() {
    const t = currentTournee();
    if (!t) return;
    document.getElementById("ws-tour-name").textContent = t.nom;
    document.getElementById("ws-tour-dates").textContent = `${t.date_debut} → ${t.date_fin}`;

    const b = getTourBareme(t);
    const baremeEl = document.getElementById("ws-bareme-pill");
    if (baremeEl) {
      baremeEl.innerHTML = `
        <span>Concert <strong>${b.concert_eur}€ · ${window.formatDurationH(b.concert_h)}</strong></span>
        <span>Étude <strong>${b.etude_eur}€ · ${window.formatDurationH(b.etude_h)}</strong></span>
        <span>Reprise <strong>${b.reprise_eur}€ · ${window.formatDurationH(b.reprise_h)}</strong></span>
        <span>Celtique <strong>${b.celtique_eur}€ · ${window.formatDurationH(b.celtique_h)}</strong></span>
      `;
    }
    const legEl = document.getElementById("map-legend");
    if (legEl) {
      legEl.innerHTML = `
        <span class="legend-item"><i class="dot dot-concert"></i> Concert (${window.formatDurationH(b.concert_h)})</span>
        <span class="legend-item"><i class="dot dot-etude"></i> Étude (${window.formatDurationH(b.etude_h)})</span>
        <span class="legend-item"><i class="dot dot-reprise"></i> Reprise (${window.formatDurationH(b.reprise_h)})</span>
        <span class="legend-item"><i class="dot dot-celtique"></i> Celtique (${window.formatDurationH(b.celtique_h)})</span>
        <span class="legend-item"><i class="dot dot-inconnu"></i> À préciser</span>
        <span class="legend-item"><i class="dot dot-conflit"></i> Conflit</span>
      `;
    }

    const luthiersSel = document.getElementById("planning-luthiers");
    if (luthiersSel) luthiersSel.value = String(t.nb_luthiers || 2);

    const days = window.PianissimoPlanning.listTourDays(t);
    const mapDaySel = document.getElementById("map-day-route");
    mapDaySel.innerHTML = `<option value="">Trajet jour : aucun</option>` +
      days.map((d) => `<option value="${d}">${window.PianissimoTemplates.formatDayFrench(d)}</option>`).join("");

    const demJourSel = document.getElementById("dem-jour");
    demJourSel.innerHTML = `<option value="">Non planifié</option>` +
      days.map((d) => `<option value="${d}">${window.PianissimoTemplates.formatDayFrench(d)}</option>`).join("");
  }

  function renderKpisAndAnomalies() {
    const actives = state.demandes.filter((d) => d.statut !== "annule" && d.statut !== "doublon");
    const c = actives.reduce((a, d) => a + Number(d.nb_concert || 0), 0);
    const e = actives.reduce((a, d) => a + Number(d.nb_etude || 0), 0);
    const rep = actives.reduce((a, d) => a + Number(d.nb_reprise || 0), 0);
    const cel = actives.reduce((a, d) => a + Number(d.nb_celtique || 0), 0);
    const inc = actives.reduce((a, d) => a + Number(d.nb_inconnu || 0), 0);
    const confirmes = actives.filter((d) => d.statut === "confirme").length;
    const conflits = actives.filter((d) => d.statut === "conflit").length;
    const totalHours = actives.reduce((a, d) => a + Number(d.duree_estimee_h || 0), 0);
    const openAnom = state.anomalies.filter((a) => !a.resolue).length;

    document.getElementById("badge-tab-demandes").textContent = String(state.demandes.length);
    document.getElementById("badge-tab-planning").textContent = String(actives.length);
    document.getElementById("badge-tab-messages").textContent = String(conflits || actives.length);

    document.getElementById("kpi-strip").innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Harpes actives</div>
        <div class="kpi-value">${c + e + rep + cel + inc}</div>
        <div class="kpi-detail">${c} conc. · ${e} ét. · ${rep} rep. · ${cel} celt. · ${inc} ?</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Demandes / RDV</div>
        <div class="kpi-value">${actives.length}</div>
        <div class="kpi-detail">${confirmes} confirmé(s) · ${conflits} conflit(s)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Charge atelier</div>
        <div class="kpi-value">${window.formatDurationH(totalHours)}</div>
        <div class="kpi-detail">Par instrument</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Vigilance</div>
        <div class="kpi-value" style="color:${openAnom ? "var(--danger)" : "var(--ok)"}">${openAnom}</div>
        <div class="kpi-detail">Sur ${state.anomalies.length} audit(s)</div>
      </div>
    `;

    document.getElementById("anomalies-count-badge").textContent = `${openAnom} ouvert(s)`;
    const anomList = document.getElementById("anomalies-list");
    anomList.innerHTML = state.anomalies.length
      ? state.anomalies
          .map(
            (a) => `
          <div class="anomaly-item ${a.resolue ? "is-resolved" : ""}">
            <div style="flex:1 1 240px;">
              <span class="badge ${a.severite === "critique" ? "badge-danger" : a.severite === "haute" ? "badge-warn" : "badge-neutral"}">${escapeHtml(a.severite.toUpperCase())}</span>
              <strong>${escapeHtml(a.titre)}</strong>
              <p>${escapeHtml(a.description)}</p>
              ${a.action_proposee ? `<p><strong>Action :</strong> ${escapeHtml(a.action_proposee)}</p>` : ""}
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              ${a.demande_id ? `<button type="button" class="btn btn-ghost btn-xs js-anom-msg" data-id="${a.demande_id}">Messages</button>` : ""}
              <button type="button" class="btn btn-ghost btn-xs js-anom-toggle" data-id="${a.id}" data-resolue="${a.resolue}">${a.resolue ? "Rouvrir" : "Résolu"}</button>
            </div>
          </div>
        `,
          )
          .join("")
      : `<p class="card-sub">Aucune anomalie enregistrée pour cette tournée.</p>`;

    anomList.querySelectorAll(".js-anom-toggle").forEach((btn) => {
      btn.addEventListener("click", async () => {
        try {
          await window.PianissimoDB.toggleAnomalie(btn.dataset.id, btn.dataset.resolue !== "true");
          await reloadCurrentTournee();
        } catch (err) {
          toast(err.message, true);
        }
      });
    });

    anomList.querySelectorAll(".js-anom-msg").forEach((btn) => {
      btn.addEventListener("click", () => openClientMessages(btn.dataset.id));
    });
  }

  function getFilteredDemandes() {
    const q = (document.getElementById("filter-search")?.value || "").trim().toLowerCase();
    const st = document.getElementById("filter-statut")?.value || "";
    const sec = document.getElementById("filter-secteur")?.value || "";
    const typ = document.getElementById("filter-type")?.value || "";

    return state.demandes.filter((d) => {
      if (st && d.statut !== st) return false;
      if (sec && d.secteur !== sec) return false;
      if (typ === "concert" && !d.nb_concert) return false;
      if (typ === "etude" && !d.nb_etude) return false;
      if (typ === "reprise" && !d.nb_reprise) return false;
      if (typ === "celtique" && !d.nb_celtique) return false;
      if (typ === "inconnu" && !d.nb_inconnu) return false;
      if (q && !`${d.nom} ${d.ville} ${d.secteur} ${d.instruments_detail} ${d.adresse}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function populateSectorFilter() {
    const sel = document.getElementById("filter-secteur");
    const prev = sel.value;
    const sectors = Array.from(new Set(state.demandes.map((d) => d.secteur).filter(Boolean))).sort();
    sel.innerHTML = `<option value="">Tous secteurs</option>` +
      sectors.map((s) => `<option value="${escapeHtml(s)}" ${s === prev ? "selected" : ""}>${escapeHtml(s)}</option>`).join("");
  }

  function renderDemandesTableAndMap(fitMap = false) {
    const filtered = getFilteredDemandes();
    document.getElementById("demandes-filter-summary").textContent = `${filtered.length} fiche(s) affichée(s) sur ${state.demandes.length}`;

    const tbody = document.getElementById("demandes-tbody");
    tbody.innerHTML = filtered.length
      ? filtered
          .map((d) => {
            const [stCls, stLbl] = statusMeta(d.statut);
            const chips = [];
            if (d.nb_concert) chips.push(`<span class="harp-chip hc-concert">${d.nb_concert}C</span>`);
            if (d.nb_etude) chips.push(`<span class="harp-chip hc-etude">${d.nb_etude}E</span>`);
            if (d.nb_reprise) chips.push(`<span class="harp-chip hc-reprise">${d.nb_reprise}R</span>`);
            if (d.nb_celtique) chips.push(`<span class="harp-chip hc-celtique">${d.nb_celtique}Cel</span>`);
            if (d.nb_inconnu) chips.push(`<span class="harp-chip hc-inconnu">${d.nb_inconnu}?</span>`);
            if (!chips.length) chips.push(`<span class="harp-chip hc-inconnu">0</span>`);

            const creneau = d.jour_date
              ? `${d.jour_date.slice(5)} ${d.heure_debut ? d.heure_debut.slice(0, 5) : ""}`
              : "À caler";

            return `
            <tr>
              <th scope="row">
                <div>${escapeHtml(d.nom)}</div>
                <div style="font-size:0.75rem;color:#6B6257;font-weight:400;">${escapeHtml(d.canal_prefere)} ${d.adresse_verifiee ? "" : "· ⚠ adresse"}</div>
              </th>
              <td>
                <div>${escapeHtml(d.secteur)}</div>
                <div style="font-size:0.75rem;color:#6B6257;">${escapeHtml(d.ville)}</div>
              </td>
              <td>
                <div class="harp-chips">${chips.join("")}</div>
                <div style="font-size:0.74rem;color:#6B6257;margin-top:2px;">${escapeHtml((d.instruments_detail || "").slice(0, 48))}${(d.instruments_detail || "").length > 48 ? "…" : ""}</div>
              </td>
              <td>
                <strong>${window.formatDurationH(d.duree_estimee_h)}</strong>
                <div style="font-size:0.74rem;color:#6B6257;">${d.montant_estime_eur != null ? `${d.montant_estime_eur} €` : "Tarif à définir"}</div>
              </td>
              <td><span class="badge ${stCls}">${stLbl}</span></td>
              <td>${escapeHtml(creneau)}</td>
              <td>
                <div class="row-actions">
                  <button type="button" class="btn btn-ghost btn-xs js-row-edit" data-id="${d.id}">Fiche</button>
                  <button type="button" class="btn btn-ghost btn-xs js-row-msg" data-id="${d.id}">Msg</button>
                </div>
              </td>
            </tr>
          `;
          })
          .join("")
      : `<tr><td colspan="7">Aucune demande ne correspond aux filtres.</td></tr>`;

    tbody.querySelectorAll(".js-row-edit").forEach((btn) => {
      btn.addEventListener("click", () => openDemandeDialog(btn.dataset.id));
    });
    tbody.querySelectorAll(".js-row-msg").forEach((btn) => {
      btn.addEventListener("click", () => openClientMessages(btn.dataset.id));
    });

    window.PianissimoMap.update(filtered, { mode: state.mapMode, fit: fitMap });
  }

  function renderPlanning() {
    window.PianissimoPlanning.render({
      tournee: currentTournee(),
      demandes: state.demandes,
      startTime: state.startTime,
      onActions: {
        openDemande: openDemandeDialog,
        openMessages: openClientMessages,
        togglePin: async (id) => {
          const d = state.demandes.find((x) => x.id === id);
          if (!d) return;
          try {
            await window.PianissimoDB.updateDemande(id, { creneau_epingle: !d.creneau_epingle });
            await reloadCurrentTournee();
          } catch (err) {
            toast(err.message, true);
          }
        },
        changeDay: async (id, jourDate) => {
          try {
            await window.PianissimoDB.updateDemande(id, { jour_date: jourDate, ordre_jour: jourDate ? 50 : 99 });
            toast("Journée mise à jour.");
            await reloadCurrentTournee();
          } catch (err) {
            toast(err.message, true);
          }
        },
        moveStop: async (dayIso, id, delta) => {
          const arr = state.demandes
            .filter((d) => d.jour_date === dayIso && d.statut !== "annule" && d.statut !== "doublon")
            .sort((a, b) => (a.ordre_jour || 0) - (b.ordre_jour || 0));
          const idx = arr.findIndex((x) => x.id === id);
          const targetIdx = idx + delta;
          if (idx < 0 || targetIdx < 0 || targetIdx >= arr.length) return;
          const copy = arr.slice();
          const [item] = copy.splice(idx, 1);
          copy.splice(targetIdx, 0, item);
          await Promise.all(
            copy.map((s, order) => window.PianissimoDB.updateDemande(s.id, { ordre_jour: order + 1 })),
          );
          await reloadCurrentTournee();
        },
        applyOrder: async (_dayIso, orderedIds) => {
          await Promise.all(
            orderedIds.map((id, order) => window.PianissimoDB.updateDemande(id, { ordre_jour: order + 1 })),
          );
          toast("Ordre optimisé appliqué.");
          await reloadCurrentTournee();
        },
      },
    });
  }

  let abbyDraftLines = [];
  const abbyModalState = {
    demandeId: null,
    checking: false,
    checkData: null,
    knownCustomers: new Map(),
  };

  function formatAbbyAddressObj(b) {
    if (!b) return "Non renseignée";
    const parts = [b.line1 || b.address, b.line2 || b.complement, [b.zipCode, b.city].filter(Boolean).join(" "), b.country].filter(Boolean);
    return parts.length ? parts.join(", ") : "Non renseignée";
  }

  function appendAbbySelectOption(selectEl, value, label) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    selectEl.appendChild(opt);
  }

  function populateAbbySelect(selectEl, checkData) {
    selectEl.innerHTML = "";
    const seen = new Set();
    const candidates = [];
    if (checkData?.matched) candidates.push(checkData.matched);
    (checkData?.candidates || []).forEach((c) => {
      if (c && c.id && !seen.has(c.id)) {
        candidates.push(c);
      }
    });
    candidates.forEach((c) => {
      if (!c?.id || seen.has(c.id)) return;
      seen.add(c.id);
      abbyModalState.knownCustomers.set(c.id, c);
      const tag = c.isOrganization ? "Étab." : "Particulier";
      const city = c.billingAddress?.city ? ` — ${c.billingAddress.zipCode || ""} ${c.billingAddress.city}`.trim() : "";
      const why = c.reason ? ` (${c.reason})` : "";
      appendAbbySelectOption(selectEl, c.id, `${c.displayName} [${tag}]${city}${why}`);
    });
    appendAbbySelectOption(selectEl, "__CREATE__", "➕ Créer une nouvelle fiche client dans Abby");
  }

  function syncAbbyCustomerUiState() {
    const selectEl = document.getElementById("abby-customer-select");
    const val = selectEl.value || "__CREATE__";
    const isCreate = val === "__CREATE__";
    const existingBox = document.getElementById("abby-existing-box");
    const fieldsBox = document.getElementById("abby-customer-fields");
    const identityBox = document.getElementById("abby-identity-fields");
    const updateChk = document.getElementById("abby-update-existing-addr");
    const submitBtn = document.getElementById("btn-abby-create-draft");

    if (isCreate) {
      existingBox.hidden = true;
      updateChk.checked = false;
      identityBox.hidden = false;
      fieldsBox.hidden = false;
      if (!abbyModalState.checking) {
        submitBtn.textContent = "Créer la fiche client + le brouillon Abby";
      }
    } else {
      const cust = abbyModalState.knownCustomers.get(val);
      existingBox.hidden = false;
      document.getElementById("abby-existing-address").textContent = formatAbbyAddressObj(cust?.billingAddress);
      const propAddr = abbyModalState.checkData?.proposed_customer?.billingAddress;
      const hintEl = document.getElementById("abby-existing-client-hint");
      if (propAddr && (propAddr.address || propAddr.raw_source)) {
        const clientAddrStr = propAddr.address
          ? `${propAddr.address}, ${propAddr.zipCode} ${propAddr.city} (${propAddr.country})`
          : propAddr.raw_source;
        hintEl.textContent = `Adresse sur la demande client : ${clientAddrStr}`;
        hintEl.hidden = false;
      } else {
        hintEl.hidden = true;
      }
      identityBox.hidden = true;
      fieldsBox.hidden = !updateChk.checked;
      if (!abbyModalState.checking) {
        submitBtn.textContent = "Créer le brouillon Abby";
      }
    }

    const kind = document.getElementById("abby-cust-kind").value;
    document.getElementById("abby-contact-name-fields").hidden = kind === "organization";
    document.getElementById("abby-org-name-field").hidden = kind !== "organization";
  }

  function fillAbbyCustomerForm(checkData) {
    const prop = checkData?.proposed_customer || {};
    const addr = prop.billingAddress || {};
    document.getElementById("abby-cust-kind").value = prop.kind === "organization" ? "organization" : "contact";
    document.getElementById("abby-cust-firstname").value = (prop.firstname || "").toLocaleLowerCase("fr-FR");
    document.getElementById("abby-cust-lastname").value = (prop.lastname || "").toLocaleUpperCase("fr-FR");
    document.getElementById("abby-cust-orgname").value = prop.name || "";
    document.getElementById("abby-cust-email").value = prop.email || "";
    document.getElementById("abby-cust-phone").value = prop.phone || "";
    document.getElementById("abby-addr-line1").value = addr.address || "";
    document.getElementById("abby-addr-complement").value = addr.complement || "";
    document.getElementById("abby-addr-zip").value = addr.zipCode || "";
    document.getElementById("abby-addr-city").value = addr.city || "";
    document.getElementById("abby-addr-country").value = addr.country || "FR";
    document.getElementById("abby-addr-review-warn").hidden = !addr.needs_review;

    const hintsBox = document.getElementById("abby-client-hints-box");
    const hints = checkData?.client_address_hints || [];
    const linesHtml = [];
    if (addr.raw_source) {
      linesHtml.push(`<p><strong>Adresse sur la fiche demande :</strong> ${escapeHtml(addr.raw_source)}</p>`);
    }
    hints.forEach((h) => {
      linesHtml.push(`<p><strong>Message ${escapeHtml(h.canal)} (${escapeHtml(h.date)}) :</strong> « ${escapeHtml(h.extrait)} »</p>`);
    });
    if (linesHtml.length) {
      hintsBox.innerHTML = linesHtml.join("");
      hintsBox.hidden = false;
    } else {
      hintsBox.innerHTML = "";
      hintsBox.hidden = true;
    }
  }

  function renderAbbyLines() {
    const box = document.getElementById("abby-lines-container");
    if (!box) return;
    box.innerHTML = abbyDraftLines
      .map(
        (ln, i) => `
      <div class="abby-line-row">
        <input type="text" class="js-abby-des" data-idx="${i}" value="${escapeHtml(ln.designation)}" placeholder="Prestation" required />
        <input type="number" min="1" step="1" class="js-abby-qty" data-idx="${i}" value="${Number(ln.quantity || 1)}" title="Quantité" required />
        <input type="number" min="0" step="1" class="js-abby-eur" data-idx="${i}" value="${Number(ln.unitPrice_eur || 0)}" title="Prix unitaire (€)" required />
        <button type="button" class="btn btn-danger-ghost btn-xs js-abby-del" data-idx="${i}" aria-label="Supprimer">✕</button>
      </div>
    `,
      )
      .join("");

    const updateTotal = () => {
      const tot = abbyDraftLines.reduce((acc, l) => acc + Number(l.quantity || 0) * Number(l.unitPrice_eur || 0), 0);
      document.getElementById("abby-total-eur").textContent = `${Math.round(tot).toLocaleString("fr-FR")} €`;
    };
    updateTotal();

    box.querySelectorAll(".js-abby-des").forEach((el) => {
      el.addEventListener("input", () => {
        abbyDraftLines[Number(el.dataset.idx)].designation = el.value;
      });
    });
    box.querySelectorAll(".js-abby-qty").forEach((el) => {
      el.addEventListener("input", () => {
        abbyDraftLines[Number(el.dataset.idx)].quantity = Math.max(1, Number(el.value || 1));
        updateTotal();
      });
    });
    box.querySelectorAll(".js-abby-eur").forEach((el) => {
      el.addEventListener("input", () => {
        abbyDraftLines[Number(el.dataset.idx)].unitPrice_eur = Math.max(0, Number(el.value || 0));
        updateTotal();
      });
    });
    box.querySelectorAll(".js-abby-del").forEach((btn) => {
      btn.addEventListener("click", () => {
        abbyDraftLines.splice(Number(btn.dataset.idx), 1);
        renderAbbyLines();
      });
    });
  }

  async function openAbbyDraftDialog(demandeId) {
    const d = state.demandes.find((x) => x.id === demandeId);
    if (!d) return;
    const b = getTourBareme(currentTournee());
    document.getElementById("abby-demande-id").value = d.id;
    document.getElementById("abby-devis-title").value = `Réglage harpe(s) — ${currentTournee()?.nom || "Tournée"}`;
    document.getElementById("abby-client-summary").textContent = `${d.nom} (${d.ville || d.secteur}) · ${d.email || d.telephone || "contact à vérifier"}`;

    abbyDraftLines = [];
    if (Number(d.nb_concert || 0) > 0) {
      abbyDraftLines.push({ designation: "Entretien et réglage complet harpe de concert", quantity: Number(d.nb_concert), unitPrice_eur: b.concert_eur });
    }
    if (Number(d.nb_etude || 0) > 0) {
      abbyDraftLines.push({ designation: "Entretien et réglage complet harpe d'étude", quantity: Number(d.nb_etude), unitPrice_eur: b.etude_eur });
    }
    if (Number(d.nb_reprise || 0) > 0) {
      abbyDraftLines.push({ designation: "Reprise de réglage harpe à pédales", quantity: Number(d.nb_reprise), unitPrice_eur: b.reprise_eur });
    }
    if (Number(d.nb_celtique || 0) > 0) {
      abbyDraftLines.push({ designation: "Entretien et réglage harpe celtique", quantity: Number(d.nb_celtique), unitPrice_eur: b.celtique_eur });
    }
    if (!abbyDraftLines.length) {
      abbyDraftLines.push({
        designation: `Entretien et réglage de harpe (${d.instruments_detail || "à préciser"})`,
        quantity: 1,
        unitPrice_eur: Number(d.montant_estime_eur || b.concert_eur),
      });
    }
    renderAbbyLines();

    abbyModalState.demandeId = d.id;
    abbyModalState.checking = true;
    abbyModalState.checkData = null;
    abbyModalState.knownCustomers.clear();

    const statusBanner = document.getElementById("abby-customer-status");
    const selectEl = document.getElementById("abby-customer-select");
    const submitBtn = document.getElementById("btn-abby-create-draft");
    document.getElementById("abby-customer-search-q").value = "";
    document.getElementById("abby-update-existing-addr").checked = false;
    document.getElementById("abby-existing-box").hidden = true;
    document.getElementById("abby-customer-fields").hidden = true;
    document.getElementById("abby-client-hints-box").hidden = true;
    statusBanner.className = "abby-status-banner is-loading";
    statusBanner.textContent = "Vérification de la fiche client dans Abby en cours…";
    selectEl.innerHTML = "";
    appendAbbySelectOption(selectEl, "__CREATE__", "Vérification en cours…");
    submitBtn.disabled = true;
    submitBtn.textContent = "Vérification Abby…";

    document.getElementById("dialog-abby-devis").showModal();

    try {
      const check = await window.PianissimoDB.checkAbbyCustomer(d.id);
      if (abbyModalState.demandeId !== d.id) return;
      abbyModalState.checkData = check;
      abbyModalState.checking = false;
      populateAbbySelect(selectEl, check);
      fillAbbyCustomerForm(check);

      if (check.status === "found" && check.matched) {
        selectEl.value = check.matched.id;
        statusBanner.className = "abby-status-banner is-found";
        statusBanner.textContent = `✅ Fiche existante trouvée dans Abby : ${check.matched.displayName} (${check.matched.reason || "correspondance"})`;
      } else if (check.status === "candidates" && check.candidates?.length) {
        selectEl.value = "__CREATE__";
        statusBanner.className = "abby-status-banner is-new";
        statusBanner.textContent = `⚠️ ${check.candidates.length} fiche(s) proche(s) dans Abby : vérifiez dans la liste ou créez la nouvelle fiche ci-dessous.`;
      } else {
        selectEl.value = "__CREATE__";
        statusBanner.className = "abby-status-banner is-new";
        statusBanner.textContent = "🆕 Client inexistant dans Abby : vérifiez le prénom (minuscules), NOM (MAJUSCULES) et l'adresse de facturation ci-dessous.";
      }
      submitBtn.disabled = false;
      syncAbbyCustomerUiState();
    } catch (err) {
      if (abbyModalState.demandeId !== d.id) return;
      abbyModalState.checking = false;
      statusBanner.className = "abby-status-banner is-warn";
      statusBanner.textContent = `Impossible de vérifier Abby automatiquement : ${err.message}`;
      submitBtn.disabled = false;
      submitBtn.textContent = "Créer le brouillon Abby";
    }
  }

  function openAbbySendDialog(demandeId, billingId) {
    const d = state.demandes.find((x) => x.id === demandeId);
    if (!d) return;
    document.getElementById("abby-send-billing-id").value = billingId;
    document.getElementById("abby-send-demande-id").value = d.id;
    const defaultCanal = d.email ? "Email" : "WhatsApp";
    document.getElementById("abby-send-canal").value = defaultCanal;
    document.getElementById("abby-send-objet").value = `Devis Pianissimo ${d.devis_ref || ""} — ${d.nom}`.trim();
    document.getElementById("abby-send-target").textContent = `${d.nom} · ${d.email || "pas d'email"} · ${d.telephone || "pas de téléphone"}`;
    document.getElementById("abby-send-pdf-link").href = `/api/abby/devis/${encodeURIComponent(billingId)}/pdf`;
    document.getElementById("abby-send-texte").value = `Bonjour,\n\nVeuillez trouver ci-joint notre devis ${d.devis_ref || ""} pour l'entretien de votre/vos harpe(s).\n\nBien cordialement,\nMarie — PIANISSIMO\nContact Anthony : ${window.PianissimoTemplates.ANTHONY_PHONE_DISPLAY}`;
    document.getElementById("abby-send-subject-wrap").hidden = defaultCanal !== "Email";
    document.getElementById("dialog-abby-send").showModal();
  }

  function renderFinance() {
    window.PianissimoFinance.render({
      tournee: currentTournee(),
      demandes: state.demandes,
      onSaveFrais: async (frais_estimes) => {
        try {
          await window.PianissimoDB.updateTournee(state.currentTourneeId, { frais_estimes });
          const t = currentTournee();
          if (t) t.frais_estimes = frais_estimes;
          toast("Frais de tournée enregistrés.");
          renderFinance();
        } catch (err) {
          toast(err.message, true);
        }
      },
      onChangeDevis: async (id, devis_statut) => {
        try {
          await window.PianissimoDB.updateDemande(id, { devis_statut });
          toast("Statut devis mis à jour.");
          await reloadCurrentTournee();
        } catch (err) {
          toast(err.message, true);
        }
      },
      onOpenDemande: openDemandeDialog,
      onOpenAbbyDraft: openAbbyDraftDialog,
      onFinalizeAbby: async (demandeId, billingId) => {
        if (!window.confirm("Avez-vous contrôlé le PDF brouillon ? Confirmer la finalisation officielle du devis dans Abby (attribution du numéro définitif) ?")) {
          return;
        }
        try {
          const res = await window.PianissimoDB.finalizeAbbyDevis(billingId, demandeId);
          toast(`Devis finalisé dans Abby : ${res.ref}`);
          await reloadCurrentTournee();
        } catch (err) {
          toast(err.message, true);
        }
      },
      onOpenAbbySend: openAbbySendDialog,
    });
  }

  let activateTabFn = () => {};

  function openClientMessages(demandeId) {
    activateTabFn(document.getElementById("tab-messages"));
    window.PianissimoMessages.render(
      {
        tournee: currentTournee(),
        demandes: state.demandes,
        messages: state.messages,
        brouillons: state.brouillons,
      },
      demandeId,
    );
  }

  function openTourneeDialog(tourneeId = null) {
    const dialog = document.getElementById("dialog-tournee");
    const t = tourneeId ? state.tournees.find((x) => x.id === tourneeId) : null;
    const b = getTourBareme(t);
    document.getElementById("form-tournee").reset();
    document.getElementById("tour-id").value = t?.id || "";
    document.getElementById("dialog-tournee-title").textContent = t ? `Modifier · ${t.nom}` : "Programmer une tournée";
    document.getElementById("btn-submit-tournee").textContent = t ? "Enregistrer les tarifs et dates" : "Créer la tournée";
    document.getElementById("tour-nom").value = t?.nom || "";
    document.getElementById("tour-debut").value = t?.date_debut || "";
    document.getElementById("tour-fin").value = t?.date_fin || "";
    document.getElementById("tour-statut").value = t?.statut || "en_preparation";
    document.getElementById("tour-luthiers").value = String(t?.nb_luthiers || 2);
    document.getElementById("tour-notes").value = t?.notes || "";
    document.getElementById("bareme-concert-eur").value = b.concert_eur;
    document.getElementById("bareme-concert-min").value = Math.round(Number(b.concert_h) * 60);
    document.getElementById("bareme-etude-eur").value = b.etude_eur;
    document.getElementById("bareme-etude-min").value = Math.round(Number(b.etude_h) * 60);
    document.getElementById("bareme-reprise-eur").value = b.reprise_eur;
    document.getElementById("bareme-reprise-min").value = Math.round(Number(b.reprise_h) * 60);
    document.getElementById("bareme-celtique-eur").value = b.celtique_eur;
    document.getElementById("bareme-celtique-min").value = Math.round(Number(b.celtique_h) * 60);
    dialog.showModal();
  }

  function openDemandeDialog(demandeId = null) {
    const dialog = document.getElementById("dialog-demande");
    const d = demandeId ? state.demandes.find((x) => x.id === demandeId) : null;
    const b = getTourBareme(currentTournee());
    document.getElementById("dialog-demande-title").textContent = d ? `Fiche · ${d.nom}` : "Nouvelle demande client";

    document.getElementById("lbl-dem-concert").textContent = `Concert (${window.formatDurationH(b.concert_h)} · ${b.concert_eur}€)`;
    document.getElementById("lbl-dem-etude").textContent = `Étude (${window.formatDurationH(b.etude_h)} · ${b.etude_eur}€)`;
    document.getElementById("lbl-dem-reprise").textContent = `Reprise réglage (${window.formatDurationH(b.reprise_h)} · ${b.reprise_eur}€)`;
    document.getElementById("lbl-dem-celtique").textContent = `Celtique (${window.formatDurationH(b.celtique_h)} · ${b.celtique_eur}€)`;

    document.getElementById("dem-id").value = d?.id || "";
    document.getElementById("dem-nom").value = d?.nom || "";
    document.getElementById("dem-categorie").value = d?.categorie || "particulier";
    document.getElementById("dem-secteur").value = d?.secteur || "";
    document.getElementById("dem-statut").value = d?.statut || "a_qualifier";
    document.getElementById("dem-ville").value = d?.ville || "";
    document.getElementById("dem-cp").value = d?.cp || "";
    document.getElementById("dem-pays").value = d?.pays || "Belgique";
    document.getElementById("dem-adresse").value = d?.adresse || "";
    document.getElementById("dem-lat").value = d?.latitude ?? "";
    document.getElementById("dem-lon").value = d?.longitude ?? "";
    document.getElementById("dem-adresse-ok").checked = Boolean(d?.adresse_verifiee);
    document.getElementById("dem-canal").value = d?.canal_prefere || "WhatsApp";
    document.getElementById("dem-tel").value = d?.telephone || "";
    document.getElementById("dem-email").value = d?.email || "";
    document.getElementById("dem-concert").value = d?.nb_concert ?? 0;
    document.getElementById("dem-etude").value = d?.nb_etude ?? 0;
    document.getElementById("dem-reprise").value = d?.nb_reprise ?? 0;
    document.getElementById("dem-celtique").value = d?.nb_celtique ?? 0;
    document.getElementById("dem-inconnu").value = d?.nb_inconnu ?? 0;
    document.getElementById("dem-duree").value = d?.duree_estimee_h ?? 0;
    document.getElementById("dem-duree-preview").textContent = window.formatDurationH(d?.duree_estimee_h ?? 0);
    document.getElementById("dem-montant").value = d?.montant_estime_eur ?? "";
    document.getElementById("dem-montant-note").value = d?.montant_note || "";
    document.getElementById("dem-instruments-detail").value = d?.instruments_detail || "";
    document.getElementById("dem-jour").value = d?.jour_date || "";
    document.getElementById("dem-heure").value = d?.heure_debut ? d.heure_debut.slice(0, 5) : "";
    document.getElementById("dem-devis-statut").value = d?.devis_statut || "non_requis";
    document.getElementById("dem-devis-ref").value = d?.devis_ref || "";
    document.getElementById("dem-contraintes").value = d?.contraintes || "";
    document.getElementById("dem-action").value = d?.action_requise || "";

    document.getElementById("btn-delete-demande").hidden = !d;
    dialog.showModal();
  }

  function recalcHarpFields() {
    const b = getTourBareme(currentTournee());
    const c = Number(document.getElementById("dem-concert").value || 0);
    const e = Number(document.getElementById("dem-etude").value || 0);
    const r = Number(document.getElementById("dem-reprise").value || 0);
    const cel = Number(document.getElementById("dem-celtique").value || 0);
    const inc = Number(document.getElementById("dem-inconnu").value || 0);

    const h = c * b.concert_h + e * b.etude_h + r * b.reprise_h + cel * b.celtique_h + inc * b.concert_h;
    const eur = c * b.concert_eur + e * b.etude_eur + r * b.reprise_eur + cel * b.celtique_eur;
    document.getElementById("dem-duree").value = Number(h.toFixed(2));
    document.getElementById("dem-duree-preview").textContent = window.formatDurationH(h);
    if (c + e + r + cel > 0) {
      document.getElementById("dem-montant").value = eur;
    }
  }

  async function reloadCurrentTournee(fitMap = false) {
    if (!state.currentTourneeId) return;
    const bundle = await window.PianissimoDB.fetchTourneeBundle(state.currentTourneeId);
    state.demandes = bundle.demandes;
    state.messages = bundle.messages;
    state.brouillons = bundle.brouillons;
    state.anomalies = bundle.anomalies;

    renderTourHeader();
    populateSectorFilter();
    renderKpisAndAnomalies();
    renderDemandesTableAndMap(fitMap);
    renderPlanning();
    window.PianissimoMessages.render({
      tournee: currentTournee(),
      demandes: state.demandes,
      messages: state.messages,
      brouillons: state.brouillons,
    });
    renderFinance();
  }

  async function openTourneeWorkspace(tourneeId) {
    state.currentTourneeId = tourneeId;
    if (state.unsubscribeRealtime) {
      state.unsubscribeRealtime();
      state.unsubscribeRealtime = null;
    }

    document.getElementById("tour-hub").hidden = true;
    document.getElementById("tour-workspace").hidden = false;
    activateTabFn(document.getElementById("tab-demandes"));

    await reloadCurrentTournee(true);

    state.unsubscribeRealtime = window.PianissimoDB.subscribeTourneeRealtime(tourneeId, () => {
      clearTimeout(state.realtimeTimer);
      state.realtimeTimer = setTimeout(() => {
        reloadCurrentTournee(false);
      }, 300);
    });
  }

  async function enterApp() {
    document.getElementById("auth-gate").hidden = true;
    document.getElementById("app-shell").hidden = false;

    state.tournees = await window.PianissimoDB.fetchTournees();
    showHub();
  }

  function setMapMode(mode) {
    state.mapMode = mode;
    document.getElementById("btn-map-poles").classList.toggle("is-active", mode === "poles");
    document.getElementById("btn-map-clients").classList.toggle("is-active", mode === "clients");
  }

  function bindGlobalUi() {
    activateTabFn = setupAccessibleTabs();
    setupNativeDialogs();

    window.PianissimoMap.initCallbacks({
      onSelectPole: (secteur) => {
        document.getElementById("filter-secteur").value = secteur;
        setMapMode("clients");
        renderDemandesTableAndMap(false);
      },
      onOpenDemande: openDemandeDialog,
      onOpenMessage: openClientMessages,
    });

    window.PianissimoMessages.initEvents({
      openDemande: openDemandeDialog,
      toast,
      syncNow: async () => {
        try {
          const res = await window.PianissimoDB.syncMessagesNow();
          await reloadCurrentTournee();
          toast(`Synchro terminée (${res.added || 0} nouveau(x) message(s)).`);
        } catch (err) {
          toast(err.message, true);
        }
      },
      saveDraft: async (demande, payload) => {
        try {
          await window.PianissimoDB.saveBrouillon({
            demande_id: demande.id,
            tournee_id: demande.tournee_id,
            canal: payload.canal,
            objet: payload.objet,
            texte_final: payload.texte_final,
            statut: payload.statut || "brouillon",
          });
          toast("Brouillon enregistré.");
          await reloadCurrentTournee();
        } catch (err) {
          toast(err.message, true);
        }
      },
      sendDirect: async (demande, payload) => {
        try {
          await window.PianissimoDB.sendMessageDirect({
            demande_id: demande.id,
            canal: payload.canal,
            objet: payload.objet,
            texte: payload.texte_final,
          });
          toast(`Message envoyé via ${payload.canal} (compte pro Anthony).`);
          await reloadCurrentTournee();
        } catch (err) {
          toast(err.message, true);
          throw err;
        }
      },
      logMessage: async (demande, payload) => {
        try {
          await window.PianissimoDB.logMessage({
            demande_id: demande.id,
            tournee_id: demande.tournee_id,
            canal: payload.canal,
            direction: payload.direction,
            contenu: payload.contenu,
            auteur: payload.direction === "entrant" ? demande.nom : "Équipe Pianissimo",
          });
          toast("Échange ajouté à l'historique.");
          await reloadCurrentTournee();
        } catch (err) {
          toast(err.message, true);
        }
      },
    });

    // Hub events
    document.getElementById("btn-hub-open").addEventListener("click", () => {
      const id = document.getElementById("hub-tour-select").value;
      if (id) openTourneeWorkspace(id);
    });
    document.getElementById("btn-back-hub").addEventListener("click", showHub);
    document.getElementById("btn-new-tour").addEventListener("click", () => openTourneeDialog(null));
    document.getElementById("btn-logout").addEventListener("click", async () => {
      await window.PianissimoDB.logout();
      window.location.reload();
    });

    // Page stepper ▲ / ▼
    document.getElementById("btn-page-prev").addEventListener("click", () => {
      if (state.currentTabIndex > 0) {
        activateTabFn(document.getElementById(TAB_ORDER[state.currentTabIndex - 1]));
      }
    });
    document.getElementById("btn-page-next").addEventListener("click", () => {
      if (state.currentTabIndex < TAB_ORDER.length - 1) {
        activateTabFn(document.getElementById(TAB_ORDER[state.currentTabIndex + 1]));
      }
    });

    // Map controls
    document.getElementById("btn-map-poles").addEventListener("click", () => {
      setMapMode("poles");
      renderDemandesTableAndMap(false);
    });
    document.getElementById("btn-map-clients").addEventListener("click", () => {
      setMapMode("clients");
      renderDemandesTableAndMap(false);
    });
    document.getElementById("btn-map-fit").addEventListener("click", () => {
      document.getElementById("filter-secteur").value = "";
      renderDemandesTableAndMap(true);
    });
    document.getElementById("map-day-route").addEventListener("change", (e) => {
      const day = e.target.value;
      if (!day) {
        window.PianissimoMap.showDayRoute([]);
        return;
      }
      const stops = state.demandes
        .filter((d) => d.jour_date === day && d.statut !== "annule" && d.statut !== "doublon")
        .sort((a, b) => (a.ordre_jour || 0) - (b.ordre_jour || 0));
      window.PianissimoMap.showDayRoute(stops);
    });

    ["filter-search", "filter-statut", "filter-secteur", "filter-type"].forEach((id) => {
      document.getElementById(id).addEventListener("input", () => renderDemandesTableAndMap(false));
      document.getElementById(id).addEventListener("change", () => renderDemandesTableAndMap(false));
    });

    document.getElementById("btn-new-demande").addEventListener("click", () => openDemandeDialog(null));

    // Planning controls
    document.getElementById("planning-luthiers").addEventListener("change", async (e) => {
      const nb_luthiers = Number(e.target.value || 2);
      try {
        await window.PianissimoDB.updateTournee(state.currentTourneeId, { nb_luthiers });
        const t = currentTournee();
        if (t) t.nb_luthiers = nb_luthiers;
        renderPlanning();
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.getElementById("planning-start-time").addEventListener("change", (e) => {
      state.startTime = e.target.value || "08:30";
      renderPlanning();
    });

    document.getElementById("btn-recalc-all-routes").addEventListener("click", () => {
      window.PianissimoRouting.clearCache();
      renderPlanning();
      toast("Cache trajets vidé, recalcul OSRM lancé.");
    });

    document.getElementById("btn-sync-calendar").addEventListener("click", async () => {
      if (!state.currentTourneeId) return;
      const btn = document.getElementById("btn-sync-calendar");
      const slots = window.PianissimoPlanning.getScheduledSlots();
      btn.disabled = true;
      btn.textContent = "Analyse Agenda...";
      try {
        const preview = await window.PianissimoDB.syncTourneeCalendar(state.currentTourneeId, { dry_run: true, slots });
        if (!preview.total) {
          toast("Aucun rendez-vous planifié à basculer dans l'agenda.", true);
          return;
        }
        const ok = window.confirm(
          `Basculer vers Google Agenda « Pianissimo » (${preview.calendar_id}) :\n` +
            `• ${preview.create_count} événement(s) à créer\n` +
            `• ${preview.update_count} événement(s) déjà existant(s) à mettre à jour\n\nConfirmer la synchronisation ?`,
        );
        if (!ok) return;
        btn.textContent = "Synchro Agenda...";
        const res = await window.PianissimoDB.syncTourneeCalendar(state.currentTourneeId, { dry_run: false, slots });
        toast(`Google Agenda Pianissimo à jour : ${res.created} créé(s), ${res.updated} mis à jour.`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "📅 Agenda Pianissimo";
      }
    });

    document.getElementById("btn-print-planning").addEventListener("click", () => window.print());

    ["dem-concert", "dem-etude", "dem-reprise", "dem-celtique", "dem-inconnu"].forEach((id) => {
      document.getElementById(id).addEventListener("change", recalcHarpFields);
    });
    document.getElementById("dem-duree").addEventListener("input", (e) => {
      document.getElementById("dem-duree-preview").textContent = window.formatDurationH(e.target.value);
    });

    document.getElementById("btn-geocode-demande").addEventListener("click", async () => {
      const q = [
        document.getElementById("dem-adresse").value,
        document.getElementById("dem-cp").value,
        document.getElementById("dem-ville").value,
        document.getElementById("dem-pays").value,
      ]
        .filter(Boolean)
        .join(", ");
      if (!q) return;
      try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`);
        const items = await res.json();
        if (items?.[0]) {
          document.getElementById("dem-lat").value = Number(items[0].lat).toFixed(5);
          document.getElementById("dem-lon").value = Number(items[0].lon).toFixed(5);
          toast("Coordonnées GPS renseignées.");
        } else {
          toast("Adresse introuvable sur OpenStreetMap.", true);
        }
      } catch {
        toast("Erreur de géocodage.", true);
      }
    });

    document.getElementById("form-demande").addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = document.getElementById("dem-id").value || null;
      const latRaw = document.getElementById("dem-lat").value;
      const lonRaw = document.getElementById("dem-lon").value;
      const montRaw = document.getElementById("dem-montant").value;

      const row = {
        tournee_id: state.currentTourneeId,
        nom: document.getElementById("dem-nom").value.trim(),
        categorie: document.getElementById("dem-categorie").value,
        secteur: document.getElementById("dem-secteur").value.trim(),
        statut: document.getElementById("dem-statut").value,
        ville: document.getElementById("dem-ville").value.trim(),
        cp: document.getElementById("dem-cp").value.trim(),
        pays: document.getElementById("dem-pays").value.trim(),
        adresse: document.getElementById("dem-adresse").value.trim(),
        adresse_verifiee: document.getElementById("dem-adresse-ok").checked,
        latitude: latRaw !== "" ? Number(latRaw) : null,
        longitude: lonRaw !== "" ? Number(lonRaw) : null,
        canal_prefere: document.getElementById("dem-canal").value,
        telephone: document.getElementById("dem-tel").value.trim(),
        email: document.getElementById("dem-email").value.trim(),
        nb_concert: Number(document.getElementById("dem-concert").value || 0),
        nb_etude: Number(document.getElementById("dem-etude").value || 0),
        nb_reprise: Number(document.getElementById("dem-reprise").value || 0),
        nb_celtique: Number(document.getElementById("dem-celtique").value || 0),
        nb_inconnu: Number(document.getElementById("dem-inconnu").value || 0),
        duree_estimee_h: Number(document.getElementById("dem-duree").value || 0),
        montant_estime_eur: montRaw !== "" ? Number(montRaw) : null,
        montant_note: document.getElementById("dem-montant-note").value.trim(),
        instruments_detail: document.getElementById("dem-instruments-detail").value.trim(),
        jour_date: document.getElementById("dem-jour").value || null,
        heure_debut: document.getElementById("dem-heure").value || null,
        devis_statut: document.getElementById("dem-devis-statut").value,
        devis_ref: document.getElementById("dem-devis-ref").value.trim(),
        contraintes: document.getElementById("dem-contraintes").value.trim(),
        action_requise: document.getElementById("dem-action").value.trim(),
      };

      try {
        if (id) {
          await window.PianissimoDB.updateDemande(id, row);
        } else {
          await window.PianissimoDB.createDemande(row);
        }
        document.getElementById("dialog-demande").close();
        toast(id ? "Fiche mise à jour." : "Nouvelle demande créée.");
        await reloadCurrentTournee();
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.getElementById("btn-delete-demande").addEventListener("click", async () => {
      const id = document.getElementById("dem-id").value;
      if (!id) return;
      try {
        await window.PianissimoDB.deleteDemande(id);
        document.getElementById("dialog-demande").close();
        toast("Fiche supprimée.");
        await reloadCurrentTournee();
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.getElementById("form-tournee").addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = document.getElementById("tour-id").value || null;
      const nom = document.getElementById("tour-nom").value.trim();
      const bareme = {
        concert_eur: Number(document.getElementById("bareme-concert-eur").value || 320),
        concert_h: Number(document.getElementById("bareme-concert-min").value || 150) / 60,
        etude_eur: Number(document.getElementById("bareme-etude-eur").value || 280),
        etude_h: Number(document.getElementById("bareme-etude-min").value || 120) / 60,
        reprise_eur: Number(document.getElementById("bareme-reprise-eur").value || 160),
        reprise_h: Number(document.getElementById("bareme-reprise-min").value || 60) / 60,
        celtique_eur: Number(document.getElementById("bareme-celtique-eur").value || 150),
        celtique_h: Number(document.getElementById("bareme-celtique-min").value || 45) / 60,
      };
      const payload = {
        nom,
        date_debut: document.getElementById("tour-debut").value,
        date_fin: document.getElementById("tour-fin").value,
        statut: document.getElementById("tour-statut").value,
        nb_luthiers: Number(document.getElementById("tour-luthiers").value || 2),
        bareme,
        notes: document.getElementById("tour-notes").value.trim(),
      };
      try {
        let saved;
        if (id) {
          saved = await window.PianissimoDB.updateTournee(id, payload);
        } else {
          const slug = `${nom.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
          saved = await window.PianissimoDB.createTournee({ slug, ...payload });
        }
        document.getElementById("dialog-tournee").close();
        state.tournees = await window.PianissimoDB.fetchTournees();
        renderTourHub();
        if (!id && saved?.id) {
          await openTourneeWorkspace(saved.id);
        }
        toast(id ? `Tournée « ${nom} » et tarifs mis à jour.` : `Tournée « ${nom} » créée.`);
      } catch (err) {
        toast(err.message, true);
      }
    });

    document.getElementById("btn-abby-add-line").addEventListener("click", () => {
      abbyDraftLines.push({ designation: "Prestation complémentaire", quantity: 1, unitPrice_eur: 50 });
      renderAbbyLines();
    });

    document.getElementById("abby-customer-select").addEventListener("change", syncAbbyCustomerUiState);
    document.getElementById("abby-update-existing-addr").addEventListener("change", syncAbbyCustomerUiState);
    document.getElementById("abby-cust-kind").addEventListener("change", syncAbbyCustomerUiState);
    document.getElementById("abby-cust-firstname").addEventListener("blur", (e) => {
      e.target.value = e.target.value.trim().toLocaleLowerCase("fr-FR");
    });
    document.getElementById("abby-cust-lastname").addEventListener("blur", (e) => {
      e.target.value = e.target.value.trim().toLocaleUpperCase("fr-FR");
    });

    const runManualAbbySearch = async () => {
      const q = document.getElementById("abby-customer-search-q").value.trim();
      if (!q) return;
      const btn = document.getElementById("btn-abby-customer-search");
      btn.disabled = true;
      btn.textContent = "Recherche…";
      try {
        const res = await window.PianissimoDB.searchAbbyCustomers(q);
        const items = res.items || [];
        const selectEl = document.getElementById("abby-customer-select");
        if (!items.length) {
          toast(`Aucune fiche Abby trouvée pour « ${q} ».`, true);
          return;
        }
        items.forEach((c) => {
          if (!c?.id) return;
          const already = Array.from(selectEl.options).some((o) => o.value === c.id);
          abbyModalState.knownCustomers.set(c.id, c);
          if (!already) {
            const opt = document.createElement("option");
            opt.value = c.id;
            const tag = c.isOrganization ? "Étab." : "Particulier";
            const city = c.billingAddress?.city ? ` — ${c.billingAddress.zipCode || ""} ${c.billingAddress.city}`.trim() : "";
            opt.textContent = `${c.displayName} [${tag}]${city} (recherche)`;
            const createOpt = Array.from(selectEl.options).find((o) => o.value === "__CREATE__");
            selectEl.insertBefore(opt, createOpt || null);
          }
        });
        selectEl.value = items[0].id;
        syncAbbyCustomerUiState();
        toast(`${items.length} fiche(s) trouvée(s) dans Abby.`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Chercher dans Abby";
      }
    };

    document.getElementById("btn-abby-customer-search").addEventListener("click", runManualAbbySearch);
    document.getElementById("abby-customer-search-q").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runManualAbbySearch();
      }
    });

    document.getElementById("form-abby-devis").addEventListener("submit", async (e) => {
      e.preventDefault();
      const selectVal = document.getElementById("abby-customer-select").value || "__CREATE__";
      const isCreate = selectVal === "__CREATE__";
      const updateExistingAddr = !isCreate && document.getElementById("abby-update-existing-addr").checked;

      const billingAddress = {
        address: document.getElementById("abby-addr-line1").value.trim(),
        complement: document.getElementById("abby-addr-complement").value.trim(),
        zipCode: document.getElementById("abby-addr-zip").value.trim(),
        city: document.getElementById("abby-addr-city").value.trim(),
        country: document.getElementById("abby-addr-country").value || "FR",
      };

      const draftPayload = {
        demande_id: document.getElementById("abby-demande-id").value,
        title: document.getElementById("abby-devis-title").value.trim() || null,
        lines: abbyDraftLines,
      };

      if (isCreate) {
        const kind = document.getElementById("abby-cust-kind").value;
        const firstname = document.getElementById("abby-cust-firstname").value.trim().toLocaleLowerCase("fr-FR");
        const lastname = document.getElementById("abby-cust-lastname").value.trim().toLocaleUpperCase("fr-FR");
        const orgName = document.getElementById("abby-cust-orgname").value.trim();
        document.getElementById("abby-cust-firstname").value = firstname;
        document.getElementById("abby-cust-lastname").value = lastname;

        if (kind === "contact" && (!firstname || !lastname)) {
          toast("Prénom (en minuscules) et NOM DE FAMILLE (en MAJUSCULES) obligatoires.", true);
          return;
        }
        if (kind === "organization" && !orgName) {
          toast("Le nom de l'établissement est obligatoire.", true);
          return;
        }
        if (!billingAddress.address || !billingAddress.zipCode || !billingAddress.city) {
          toast("Complétez l'adresse de facturation (rue, code postal, ville).", true);
          return;
        }
        draftPayload.customer_id = null;
        draftPayload.customer_payload = {
          force_create: true,
          kind,
          firstname,
          lastname,
          name: orgName,
          email: document.getElementById("abby-cust-email").value.trim(),
          phone: document.getElementById("abby-cust-phone").value.trim(),
          billingAddress,
        };
      } else {
        draftPayload.customer_id = selectVal;
        draftPayload.update_existing_billing_address = updateExistingAddr;
        if (updateExistingAddr) {
          if (!billingAddress.address || !billingAddress.zipCode || !billingAddress.city) {
            toast("Complétez l'adresse de facturation avant la mise à jour dans Abby.", true);
            return;
          }
          draftPayload.customer_payload = { billingAddress };
        }
      }

      const btn = document.getElementById("btn-abby-create-draft");
      btn.disabled = true;
      btn.textContent = isCreate ? "Création fiche + devis…" : "Création Abby…";
      try {
        const res = await window.PianissimoDB.createAbbyDevisDraft(draftPayload);
        document.getElementById("dialog-abby-devis").close();
        const actionLabel = res.customer_created ? "Fiche client créée et brouillon Abby généré" : "Fiche Abby existante réutilisée et brouillon généré";
        toast(`${actionLabel} (${res.customer_name}). Ouvrez « PDF brouillon ↗ » pour le contrôler.`);
        await reloadCurrentTournee();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        syncAbbyCustomerUiState();
      }
    });

    document.getElementById("abby-send-canal").addEventListener("change", (e) => {
      document.getElementById("abby-send-subject-wrap").hidden = e.target.value !== "Email";
    });

    document.getElementById("form-abby-send").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("btn-abby-send-exec");
      btn.disabled = true;
      btn.textContent = "Envoi en cours...";
      try {
        const billingId = document.getElementById("abby-send-billing-id").value;
        const canal = document.getElementById("abby-send-canal").value;
        await window.PianissimoDB.sendAbbyDevis(billingId, {
          demande_id: document.getElementById("abby-send-demande-id").value,
          canal,
          objet: document.getElementById("abby-send-objet").value.trim(),
          texte: document.getElementById("abby-send-texte").value.trim(),
        });
        document.getElementById("dialog-abby-send").close();
        toast(`Devis PDF envoyé au client via ${canal}.`);
        await reloadCurrentTournee();
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.textContent = "Confirmer et envoyer le devis PDF";
      }
    });

    document.getElementById("auth-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const errEl = document.getElementById("auth-error");
      const btn = document.getElementById("auth-submit-btn");
      errEl.hidden = true;
      btn.disabled = true;
      btn.textContent = "Connexion...";
      try {
        await window.PianissimoDB.loginWithTeamCode(document.getElementById("auth-code-input").value);
        await enterApp();
      } catch (err) {
        errEl.textContent = err.message || "Code invalide.";
        errEl.hidden = false;
      } finally {
        btn.disabled = false;
        btn.textContent = "Ouvrir l'atelier tournées";
      }
    });
  }

  async function boot() {
    bindGlobalUi();
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    const session = await window.PianissimoDB.getActiveSession();
    if (session) {
      try {
        await enterApp();
        return;
      } catch {
        await window.PianissimoDB.logout();
      }
    }
    document.getElementById("auth-gate").hidden = false;
    document.getElementById("app-shell").hidden = true;
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
