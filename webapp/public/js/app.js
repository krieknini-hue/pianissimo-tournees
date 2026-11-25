// Orchestrateur principal : état, auth, onglets accessibles, dialogues natifs, CRUD Supabase
(() => {
  const state = {
    tournees: [],
    currentTourneeId: null,
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

  function setupAccessibleTabs() {
    const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
    const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));

    function activateTab(tab) {
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
        } else {
          p.setAttribute("hidden", "until-found");
          p.removeAttribute("tabindex");
        }
      });

      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
      if (targetId === "panel-demandes") {
        window.PianissimoMap.invalidateSize();
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

    // Support hidden="until-found" find-in-page
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

  function renderTourHeader() {
    const select = document.getElementById("tour-select");
    select.innerHTML = state.tournees
      .map((t) => `<option value="${t.id}" ${t.id === state.currentTourneeId ? "selected" : ""}>${escapeHtml(t.nom)}</option>`)
      .join("");

    const t = currentTournee();
    if (!t) return;
    document.getElementById("tour-dates-badge").textContent = `${t.date_debut} → ${t.date_fin}`;
    const stBadge = document.getElementById("tour-status-badge");
    const stLabels = {
      a_venir: ["badge-neutral", "À venir"],
      en_preparation: ["badge-warn", "En préparation"],
      en_cours: ["badge-ok", "En cours"],
      terminee: ["badge-neutral", "Terminée"],
    };
    const [cls, lbl] = stLabels[t.statut] || ["badge-neutral", t.statut];
    stBadge.className = `badge ${cls}`;
    stBadge.textContent = lbl;

    const luthiersSel = document.getElementById("planning-luthiers");
    if (luthiersSel) luthiersSel.value = String(t.nb_luthiers || 2);

    // Remplir le sélecteur d'itinéraire jour sur la carte et dans la modale demande
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
        <div class="kpi-value">${c + e + cel + inc}</div>
        <div class="kpi-detail">${c} concert · ${e} étude · ${cel} celtique · ${inc} ?</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Demandes / RDV</div>
        <div class="kpi-value">${actives.length}</div>
        <div class="kpi-detail">${confirmes} confirmé(s) · ${conflits} conflit(s)</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Charge atelier totale</div>
        <div class="kpi-value">${totalHours.toFixed(1)} h</div>
        <div class="kpi-detail">Calculée par instrument</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Points de vigilance</div>
        <div class="kpi-value" style="color:${openAnom ? "var(--danger)" : "var(--ok)"}">${openAnom}</div>
        <div class="kpi-detail">Sur ${state.anomalies.length} audit(s)</div>
      </div>
    `;

    // Anomalies
    document.getElementById("anomalies-count-badge").textContent = `${openAnom} ouvert(s)`;
    const anomList = document.getElementById("anomalies-list");
    anomList.innerHTML = state.anomalies.length
      ? state.anomalies
          .map(
            (a) => `
          <div class="anomaly-item ${a.resolue ? "is-resolved" : ""}">
            <div style="flex:1 1 320px;">
              <span class="badge ${a.severite === "critique" ? "badge-danger" : a.severite === "haute" ? "badge-warn" : "badge-neutral"}">${escapeHtml(a.severite.toUpperCase())}</span>
              <strong>${escapeHtml(a.titre)}</strong>
              <p>${escapeHtml(a.description)}</p>
              ${a.action_proposee ? `<p><strong>Action :</strong> ${escapeHtml(a.action_proposee)}</p>` : ""}
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              ${a.demande_id ? `<button type="button" class="btn btn-ghost btn-xs js-anom-msg" data-id="${a.demande_id}">Messages</button>` : ""}
              <button type="button" class="btn btn-ghost btn-xs js-anom-toggle" data-id="${a.id}" data-resolue="${a.resolue}">${a.resolue ? "Rouvrir" : "Marquer résolu"}</button>
            </div>
          </div>
        `,
          )
          .join("")
      : `<p class="card-sub">Aucune anomalie enregistrée pour cette tournée.</p>`;

    anomList.querySelectorAll(".js-anom-toggle").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const resolue = btn.dataset.resolue !== "true";
        const { error } = await window.PianissimoDB.client
          .from("anomalies")
          .update({ resolue })
          .eq("id", btn.dataset.id);
        if (error) return toast(error.message, true);
        await reloadCurrentTournee();
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
                <strong>${Number(d.duree_estimee_h || 0)}h</strong>
                <div style="font-size:0.74rem;color:#6B6257;">${d.montant_estime_eur != null ? `${d.montant_estime_eur} €` : "Fourchette"}</div>
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
          const { error } = await window.PianissimoDB.client
            .from("demandes")
            .update({ creneau_epingle: !d.creneau_epingle })
            .eq("id", id);
          if (error) return toast(error.message, true);
          await reloadCurrentTournee();
        },
        changeDay: async (id, jourDate) => {
          const { error } = await window.PianissimoDB.client
            .from("demandes")
            .update({ jour_date: jourDate, ordre_jour: jourDate ? 50 : 99 })
            .eq("id", id);
          if (error) return toast(error.message, true);
          toast("Journée mise à jour.");
          await reloadCurrentTournee();
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
            copy.map((s, order) =>
              window.PianissimoDB.client.from("demandes").update({ ordre_jour: order + 1 }).eq("id", s.id),
            ),
          );
          await reloadCurrentTournee();
        },
        applyOrder: async (_dayIso, orderedIds) => {
          await Promise.all(
            orderedIds.map((id, order) =>
              window.PianissimoDB.client.from("demandes").update({ ordre_jour: order + 1 }).eq("id", id),
            ),
          );
          toast("Ordre optimisé appliqué.");
          await reloadCurrentTournee();
        },
      },
    });
  }

  function renderFinance() {
    window.PianissimoFinance.render({
      tournee: currentTournee(),
      demandes: state.demandes,
      onSaveFrais: async (frais_estimes) => {
        const { error } = await window.PianissimoDB.client
          .from("tournees")
          .update({ frais_estimes })
          .eq("id", state.currentTourneeId);
        if (error) return toast(error.message, true);
        const t = currentTournee();
        if (t) t.frais_estimes = frais_estimes;
        toast("Frais de tournée enregistrés.");
        renderFinance();
      },
      onChangeDevis: async (id, devis_statut) => {
        const { error } = await window.PianissimoDB.client
          .from("demandes")
          .update({ devis_statut })
          .eq("id", id);
        if (error) return toast(error.message, true);
        toast("Statut devis mis à jour.");
        await reloadCurrentTournee();
      },
      onOpenDemande: openDemandeDialog,
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

  function openDemandeDialog(demandeId = null) {
    const dialog = document.getElementById("dialog-demande");
    const d = demandeId ? state.demandes.find((x) => x.id === demandeId) : null;
    document.getElementById("dialog-demande-title").textContent = d ? `Fiche · ${d.nom}` : "Nouvelle demande client";

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
    document.getElementById("dem-celtique").value = d?.nb_celtique ?? 0;
    document.getElementById("dem-inconnu").value = d?.nb_inconnu ?? 0;
    document.getElementById("dem-duree").value = d?.duree_estimee_h ?? 0;
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
    const t = currentTournee();
    const b = t?.bareme || { concert_eur: 320, concert_h: 3, etude_eur: 280, etude_h: 3, celtique_eur: 150, celtique_h: 1.5 };
    const c = Number(document.getElementById("dem-concert").value || 0);
    const e = Number(document.getElementById("dem-etude").value || 0);
    const cel = Number(document.getElementById("dem-celtique").value || 0);
    const inc = Number(document.getElementById("dem-inconnu").value || 0);

    const h = c * b.concert_h + e * b.etude_h + cel * b.celtique_h + inc * b.concert_h;
    const eur = c * b.concert_eur + e * b.etude_eur + cel * b.celtique_eur;
    document.getElementById("dem-duree").value = h;
    if (c + e + cel > 0) {
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

  async function selectTournee(tourneeId) {
    state.currentTourneeId = tourneeId;
    if (state.unsubscribeRealtime) {
      state.unsubscribeRealtime();
      state.unsubscribeRealtime = null;
    }
    await reloadCurrentTournee(true);

    state.unsubscribeRealtime = window.PianissimoDB.subscribeTourneeRealtime(tourneeId, () => {
      clearTimeout(state.realtimeTimer);
      state.realtimeTimer = setTimeout(() => {
        reloadCurrentTournee(false);
      }, 350);
    });
  }

  async function enterApp() {
    document.getElementById("auth-gate").hidden = true;
    document.getElementById("app-shell").hidden = false;

    state.tournees = await window.PianissimoDB.fetchTournees();
    if (state.tournees.length) {
      const preferred =
        state.tournees.find((t) => t.statut === "en_preparation" || t.statut === "en_cours") ||
        state.tournees[0];
      await selectTournee(preferred.id);
    }
    window.PianissimoMap.invalidateSize();
  }

  function bindGlobalUi() {
    activateTabFn = setupAccessibleTabs();
    setupNativeDialogs();

    window.PianissimoMap.initCallbacks({
      onSelectPole: (secteur) => {
        document.getElementById("filter-secteur").value = secteur;
        renderDemandesTableAndMap(false);
      },
      onOpenDemande: openDemandeDialog,
      onOpenMessage: openClientMessages,
    });

    window.PianissimoMessages.initEvents({
      openDemande: openDemandeDialog,
      toast,
      saveDraft: async (demande, payload) => {
        const { error } = await window.PianissimoDB.client
          .from("brouillons_messages")
          .upsert(
            {
              demande_id: demande.id,
              tournee_id: demande.tournee_id,
              canal: payload.canal,
              objet: payload.objet,
              texte_final: payload.texte_final,
              statut: payload.statut || "brouillon",
            },
            { onConflict: "demande_id,canal" },
          );
        if (error) return toast(error.message, true);
        toast("Brouillon enregistré.");
        await reloadCurrentTournee();
      },
      markSent: async (demande, payload) => {
        const nowIso = new Date().toISOString();
        const { error: errB } = await window.PianissimoDB.client
          .from("brouillons_messages")
          .upsert(
            {
              demande_id: demande.id,
              tournee_id: demande.tournee_id,
              canal: payload.canal,
              objet: payload.objet,
              texte_final: payload.texte_final,
              statut: "envoye",
              envoye_le: nowIso,
            },
            { onConflict: "demande_id,canal" },
          );
        if (errB) return toast(errB.message, true);

        const { error: errM } = await window.PianissimoDB.client.from("messages_historique").insert({
          demande_id: demande.id,
          tournee_id: demande.tournee_id,
          canal: payload.canal,
          direction: "sortant",
          horodatage: nowIso,
          contenu: payload.texte_final,
          auteur: "Pianissimo (validé)",
        });
        if (errM) return toast(errM.message, true);

        toast("Message consigné comme envoyé.");
        await reloadCurrentTournee();
      },
      logMessage: async (demande, payload) => {
        const { error } = await window.PianissimoDB.client.from("messages_historique").insert({
          demande_id: demande.id,
          tournee_id: demande.tournee_id,
          canal: payload.canal,
          direction: payload.direction,
          horodatage: new Date().toISOString(),
          contenu: payload.contenu,
          auteur: payload.direction === "entrant" ? demande.nom : "Équipe Pianissimo",
        });
        if (error) return toast(error.message, true);
        toast("Échange ajouté à l'historique.");
        await reloadCurrentTournee();
      },
    });

    // Topbar & filters
    document.getElementById("tour-select").addEventListener("change", (e) => selectTournee(e.target.value));
    document.getElementById("btn-new-tour").addEventListener("click", () => {
      document.getElementById("form-tournee").reset();
      document.getElementById("dialog-tournee").showModal();
    });
    document.getElementById("btn-logout").addEventListener("click", async () => {
      await window.PianissimoDB.logout();
      window.location.reload();
    });

    document.getElementById("btn-map-poles").addEventListener("click", () => {
      state.mapMode = "poles";
      document.getElementById("btn-map-poles").classList.add("is-active");
      document.getElementById("btn-map-clients").classList.remove("is-active");
      renderDemandesTableAndMap(false);
    });
    document.getElementById("btn-map-clients").addEventListener("click", () => {
      state.mapMode = "clients";
      document.getElementById("btn-map-clients").classList.add("is-active");
      document.getElementById("btn-map-poles").classList.remove("is-active");
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
      const { error } = await window.PianissimoDB.client
        .from("tournees")
        .update({ nb_luthiers })
        .eq("id", state.currentTourneeId);
      if (error) return toast(error.message, true);
      const t = currentTournee();
      if (t) t.nb_luthiers = nb_luthiers;
      renderPlanning();
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

    document.getElementById("btn-print-planning").addEventListener("click", () => window.print());

    // Harp count auto recalc
    ["dem-concert", "dem-etude", "dem-celtique", "dem-inconnu"].forEach((id) => {
      document.getElementById(id).addEventListener("change", recalcHarpFields);
    });

    // Geocode address via Nominatim
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

    // Save demande
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

      const op = id
        ? window.PianissimoDB.client.from("demandes").update(row).eq("id", id)
        : window.PianissimoDB.client.from("demandes").insert(row);
      const { error } = await op;
      if (error) return toast(error.message, true);
      document.getElementById("dialog-demande").close();
      toast(id ? "Fiche mise à jour." : "Nouvelle demande créée.");
      await reloadCurrentTournee();
    });

    document.getElementById("btn-delete-demande").addEventListener("click", async () => {
      const id = document.getElementById("dem-id").value;
      if (!id) return;
      const { error } = await window.PianissimoDB.client.from("demandes").delete().eq("id", id);
      if (error) return toast(error.message, true);
      document.getElementById("dialog-demande").close();
      toast("Fiche supprimée.");
      await reloadCurrentTournee();
    });

    // Save new tournee
    document.getElementById("form-tournee").addEventListener("submit", async (e) => {
      e.preventDefault();
      const nom = document.getElementById("tour-nom").value.trim();
      const slug = `${nom.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
      const { data, error } = await window.PianissimoDB.client
        .from("tournees")
        .insert({
          slug,
          nom,
          date_debut: document.getElementById("tour-debut").value,
          date_fin: document.getElementById("tour-fin").value,
          statut: document.getElementById("tour-statut").value,
          nb_luthiers: Number(document.getElementById("tour-luthiers").value || 2),
          notes: document.getElementById("tour-notes").value.trim(),
        })
        .select()
        .single();
      if (error) return toast(error.message, true);
      document.getElementById("dialog-tournee").close();
      state.tournees = await window.PianissimoDB.fetchTournees();
      await selectTournee(data.id);
      toast(`Tournée « ${nom} » créée.`);
    });

    // Auth form
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
