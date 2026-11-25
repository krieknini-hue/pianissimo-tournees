// Module Messages & WhatsApp : vue Maître -> Détail plein écran sur smartphone + 2 colonnes sur ordinateur
(() => {
  let selectedId = null;
  let currentData = { tournee: null, demandes: [], messages: [], brouillons: [] };
  let callbacks = {};

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function statusBadge(statut) {
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
    const [cls, label] = map[statut] || ["badge-neutral", statut];
    return { cls, label };
  }

  function setMobileThreadOpen(isOpen) {
    const layout = document.getElementById("messages-layout");
    const ws = document.getElementById("tour-workspace");
    if (layout) layout.classList.toggle("is-thread-open", isOpen);
    if (ws) ws.classList.toggle("is-mobile-thread-open", isOpen);
    if (isOpen) {
      const panel = document.getElementById("panel-messages");
      if (panel) panel.scrollTop = 0;
    }
  }

  function getFilteredClients() {
    const q = (document.getElementById("msg-search")?.value || "").trim().toLowerCase();
    const st = document.getElementById("msg-filter-statut")?.value || "";
    const canal = document.getElementById("msg-filter-canal")?.value || "";

    const priority = { conflit: 1, a_qualifier: 2, propose: 3, confirme: 4, contacte: 5, a_contacter: 6, doublon: 7, annule: 8 };
    return (currentData.demandes || [])
      .filter((d) => {
        if (st && d.statut !== st) return false;
        if (canal && d.canal_prefere !== canal) return false;
        if (q && !`${d.nom} ${d.ville} ${d.secteur} ${d.instruments_detail}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .sort((a, b) => (priority[a.statut] || 9) - (priority[b.statut] || 9) || a.nom.localeCompare(b.nom));
  }

  function renderSidebar() {
    const listEl = document.getElementById("msg-client-list");
    if (!listEl) return;

    const clients = getFilteredClients();
    if (!clients.length) {
      listEl.innerHTML = `<li class="card-sub">Aucun client pour ces filtres.</li>`;
      return;
    }

    listEl.innerHTML = clients
      .map((d) => {
        const thread = currentData.messages.filter((m) => m.demande_id === d.id);
        const lastMsg = thread[thread.length - 1];
        const draft = currentData.brouillons.find((b) => b.demande_id === d.id && b.canal === (d.canal_prefere === "Email" ? "Email" : "WhatsApp"));
        const { cls, label } = statusBadge(d.statut);
        const isSel = d.id === selectedId ? "is-selected" : "";
        const preview = lastMsg ? `${lastMsg.contenu.slice(0, 52)}${lastMsg.contenu.length > 52 ? "…" : ""}` : "Aucun message encore";
        return `
          <li>
            <button type="button" class="msg-client-btn ${isSel}" data-id="${d.id}">
              <div class="msg-client-row">
                <strong>${escapeHtml(d.nom)}</strong>
                <span class="badge ${cls}">${label}</span>
              </div>
              <div class="msg-client-row" style="font-size:0.76rem;color:#6B6257;">
                <span>${escapeHtml(d.canal_prefere)} · ${escapeHtml(d.secteur)}</span>
                <span>${thread.length} éch. ${draft?.statut === "envoye" ? "· ✓" : ""} ›</span>
              </div>
              <div style="font-size:0.74rem;color:#6B6257;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(preview)}</div>
            </button>
          </li>
        `;
      })
      .join("");

    listEl.querySelectorAll(".msg-client-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        selectedId = btn.dataset.id;
        renderSidebar();
        renderWorkspace();
        setMobileThreadOpen(true);
      });
    });
  }

  function updateLinksAndGuards(demande) {
    const canal = document.getElementById("composer-canal").value;
    const text = document.getElementById("composer-textarea").value;
    const objet = document.getElementById("composer-objet").value;

    document.getElementById("composer-subject-row").hidden = canal !== "Email";

    const waBtn = document.getElementById("btn-open-wa");
    const mailBtn = document.getElementById("btn-open-mail");
    if (canal === "WhatsApp") {
      const waUrl = window.PianissimoTemplates.buildWhatsAppUrl(demande.telephone, text);
      waBtn.hidden = !waUrl;
      waBtn.href = waUrl || "#";
      mailBtn.hidden = true;
    } else {
      const mailUrl = window.PianissimoTemplates.buildMailtoUrl(demande.email, objet, text);
      mailBtn.hidden = !mailUrl;
      mailBtn.href = mailUrl || "#";
      waBtn.hidden = true;
    }

    const guards = window.PianissimoTemplates.evaluateGuards(text, demande);
    const guardEl = document.getElementById("composer-guards");
    guardEl.innerHTML = guards
      .map((g) => {
        const cls = g.level === "danger" ? "guard-danger" : g.level === "warn" ? "guard-warn" : "guard-ok";
        const fixBtn =
          g.code === "MARIE_PHONE"
            ? `<button type="button" class="btn btn-primary btn-xs js-fix-marie-phone">${escapeHtml(g.fixLabel)}</button>`
            : "";
        return `<div class="guard-alert ${cls}"><span>${escapeHtml(g.message)}</span>${fixBtn}</div>`;
      })
      .join("");

    const fixBtn = guardEl.querySelector(".js-fix-marie-phone");
    if (fixBtn) {
      fixBtn.addEventListener("click", () => {
        const ta = document.getElementById("composer-textarea");
        ta.value = window.PianissimoTemplates.fixMariePhone(ta.value);
        updateLinksAndGuards(demande);
      });
    }
  }

  function loadDraftForCanal(demande, canal) {
    const existing = currentData.brouillons.find((b) => b.demande_id === demande.id && b.canal === canal);
    const fallback = window.PianissimoTemplates.generateTemplate(
      demande,
      demande.statut === "confirme" ? "confirmation" : demande.statut === "conflit" ? "recalage" : "proposition",
      currentData.tournee,
    );

    const badge = document.getElementById("composer-draft-status");
    badge.textContent = existing?.statut === "envoye" ? "Envoyé ✓" : existing?.statut === "valide" ? "Validé" : "Brouillon";
    badge.className = `badge ${existing?.statut === "envoye" ? "badge-ok" : "badge-neutral"}`;

    document.getElementById("composer-objet").value = existing?.objet || fallback.objet;
    document.getElementById("composer-textarea").value = existing?.texte_final || existing?.texte_propose || fallback.texte;
    updateLinksAndGuards(demande);
  }

  function renderWorkspace() {
    const emptyEl = document.getElementById("msg-empty-state");
    const activeEl = document.getElementById("msg-active-pane");
    const demande = currentData.demandes.find((d) => d.id === selectedId);

    if (!demande) {
      emptyEl.hidden = false;
      activeEl.hidden = true;
      return;
    }

    emptyEl.hidden = true;
    activeEl.hidden = false;

    document.getElementById("msg-client-name").textContent = demande.nom;
    const contactStr = [demande.telephone, demande.email].filter(Boolean).join(" · ") || "Aucun contact direct";
    document.getElementById("msg-client-meta").textContent = `${demande.secteur} (${demande.ville}) · ${contactStr}`;

    const stEl = document.getElementById("msg-client-statut");
    const { cls, label } = statusBadge(demande.statut);
    stEl.className = `badge ${cls}`;
    stEl.textContent = label;

    const creneau = demande.jour_date
      ? `${window.PianissimoTemplates.formatDayFrench(demande.jour_date)}${demande.heure_debut ? ` à ${window.PianissimoTemplates.formatHourFrench(demande.heure_debut)}` : ""}`
      : "Non calé";

    document.getElementById("msg-client-context").innerHTML = `
      <div><strong>Instruments :</strong> ${escapeHtml(demande.instruments_detail || "À préciser")} (${Number(demande.duree_estimee_h || 0)}h · ${escapeHtml(demande.montant_note || "tarif standard")})</div>
      <div><strong>Adresse :</strong> ${escapeHtml(demande.adresse || "À confirmer")} ${demande.adresse_verifiee ? "✓" : "⚠ non vérifiée"}</div>
      <div><strong>Créneau prévu :</strong> ${escapeHtml(creneau)}</div>
      ${demande.action_requise ? `<div><strong>Action requise :</strong> ${escapeHtml(demande.action_requise)}</div>` : ""}
    `;

    const thread = currentData.messages.filter((m) => m.demande_id === demande.id);
    document.getElementById("msg-thread-count").textContent = `${thread.length} message(s)`;
    const threadEl = document.getElementById("msg-thread-list");
    if (!thread.length) {
      threadEl.innerHTML = `<p class="card-sub">Aucun échange enregistré pour cette fiche.</p>`;
    } else {
      threadEl.innerHTML = thread
        .map((m) => {
          const dt = new Date(m.horodatage).toLocaleString("fr-FR", {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });
          const dirCls = m.direction === "sortant" ? "bubble-sortant" : m.direction === "interne" ? "bubble-interne" : "bubble-entrant";
          return `
            <div class="bubble ${dirCls}">
              <div class="bubble-meta">${escapeHtml(m.auteur || m.direction)} · ${escapeHtml(m.canal)} · ${dt}</div>
              <div>${escapeHtml(m.contenu)}</div>
            </div>
          `;
        })
        .join("");
      threadEl.scrollTop = threadEl.scrollHeight;
    }

    const preferred = demande.canal_prefere === "Email" ? "Email" : "WhatsApp";
    document.getElementById("composer-canal").value = preferred;
    loadDraftForCanal(demande, preferred);
  }

  function initEvents(cbs) {
    callbacks = cbs;

    document.getElementById("msg-search")?.addEventListener("input", renderSidebar);
    document.getElementById("msg-filter-statut")?.addEventListener("change", renderSidebar);
    document.getElementById("msg-filter-canal")?.addEventListener("change", renderSidebar);

    document.getElementById("btn-msg-back-list")?.addEventListener("click", () => {
      setMobileThreadOpen(false);
    });

    document.getElementById("btn-msg-open-fiche")?.addEventListener("click", () => {
      if (selectedId && callbacks.openDemande) callbacks.openDemande(selectedId);
    });

    document.getElementById("composer-canal")?.addEventListener("change", (e) => {
      const demande = currentData.demandes.find((d) => d.id === selectedId);
      if (demande) loadDraftForCanal(demande, e.target.value);
    });

    document.getElementById("composer-textarea")?.addEventListener("input", () => {
      const demande = currentData.demandes.find((d) => d.id === selectedId);
      if (demande) updateLinksAndGuards(demande);
    });

    document.getElementById("composer-objet")?.addEventListener("input", () => {
      const demande = currentData.demandes.find((d) => d.id === selectedId);
      if (demande) updateLinksAndGuards(demande);
    });

    document.querySelectorAll("[data-tpl]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const demande = currentData.demandes.find((d) => d.id === selectedId);
        if (!demande) return;
        const tpl = window.PianissimoTemplates.generateTemplate(demande, btn.dataset.tpl, currentData.tournee);
        document.getElementById("composer-objet").value = tpl.objet;
        document.getElementById("composer-textarea").value = tpl.texte;
        updateLinksAndGuards(demande);
      });
    });

    document.getElementById("btn-copy-msg")?.addEventListener("click", async () => {
      const text = document.getElementById("composer-textarea").value;
      await navigator.clipboard.writeText(text);
      callbacks.toast && callbacks.toast("Message copié dans le presse-papiers.");
    });

    document.getElementById("btn-save-draft")?.addEventListener("click", async () => {
      const demande = currentData.demandes.find((d) => d.id === selectedId);
      if (!demande || !callbacks.saveDraft) return;
      await callbacks.saveDraft(demande, {
        canal: document.getElementById("composer-canal").value,
        objet: document.getElementById("composer-objet").value,
        texte_final: document.getElementById("composer-textarea").value,
        statut: "brouillon",
      });
    });

    document.getElementById("btn-mark-sent")?.addEventListener("click", async () => {
      const demande = currentData.demandes.find((d) => d.id === selectedId);
      if (!demande || !callbacks.markSent) return;
      await callbacks.markSent(demande, {
        canal: document.getElementById("composer-canal").value,
        objet: document.getElementById("composer-objet").value,
        texte_final: document.getElementById("composer-textarea").value,
      });
    });

    document.getElementById("msg-log-form")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const demande = currentData.demandes.find((d) => d.id === selectedId);
      if (!demande || !callbacks.logMessage) return;
      const input = document.getElementById("msg-log-text");
      const content = input.value.trim();
      if (!content) return;
      await callbacks.logMessage(demande, {
        direction: document.getElementById("msg-log-dir").value,
        canal: document.getElementById("msg-log-canal").value,
        contenu: content,
      });
      input.value = "";
    });
  }

  function render(data, openClientId = null) {
    currentData = data;
    if (openClientId) {
      selectedId = openClientId;
      setMobileThreadOpen(true);
    } else if (!selectedId && data.demandes?.length && window.innerWidth >= 900) {
      const firstConflict = data.demandes.find((d) => d.statut === "conflit");
      selectedId = (firstConflict || data.demandes[0]).id;
    }
    renderSidebar();
    renderWorkspace();
  }

  window.PianissimoMessages = {
    initEvents,
    render,
    setMobileThreadOpen,
  };
})();
