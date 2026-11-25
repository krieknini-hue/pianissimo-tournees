// Client API local VPS (cookies HttpOnly + Server-Sent Events temps réel)
(() => {
  async function apiFetch(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      ...options,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { detail: text };
    }
    if (!res.ok) {
      throw new Error(data?.detail || data?.error || `Erreur HTTP ${res.status}`);
    }
    return data;
  }

  async function loginWithTeamCode(code) {
    return apiFetch("/api/auth/login", { method: "POST", body: { code } });
  }

  async function getActiveSession() {
    try {
      const me = await apiFetch("/api/auth/me");
      return me?.authenticated ? me : null;
    } catch {
      return null;
    }
  }

  async function logout() {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  }

  async function fetchTournees() {
    return apiFetch("/api/tournees");
  }

  async function createTournee(payload) {
    return apiFetch("/api/tournees", { method: "POST", body: payload });
  }

  async function updateTournee(id, payload) {
    return apiFetch(`/api/tournees/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
  }

  async function fetchTourneeBundle(tourneeId) {
    return apiFetch(`/api/tournees/${encodeURIComponent(tourneeId)}/bundle`);
  }

  async function createDemande(payload) {
    return apiFetch("/api/demandes", { method: "POST", body: payload });
  }

  async function updateDemande(id, payload) {
    return apiFetch(`/api/demandes/${encodeURIComponent(id)}`, { method: "PATCH", body: payload });
  }

  async function deleteDemande(id) {
    return apiFetch(`/api/demandes/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  async function toggleAnomalie(id, resolue) {
    return apiFetch(`/api/anomalies/${encodeURIComponent(id)}`, { method: "PATCH", body: { resolue } });
  }

  async function saveBrouillon(payload) {
    return apiFetch("/api/brouillons", { method: "PUT", body: payload });
  }

  async function logMessage(payload) {
    return apiFetch("/api/messages", { method: "POST", body: payload });
  }

  async function sendMessageDirect(payload) {
    return apiFetch("/api/messages/send", { method: "POST", body: payload });
  }

  async function syncMessagesNow() {
    return apiFetch("/api/sync/messages", { method: "POST" });
  }

  async function checkAbbyCustomer(demandeId) {
    return apiFetch(`/api/abby/customer/check?demande_id=${encodeURIComponent(demandeId)}`);
  }

  async function searchAbbyCustomers(q) {
    return apiFetch(`/api/abby/customers/search?q=${encodeURIComponent(q || "")}`);
  }

  async function createAbbyDevisDraft(payload) {
    return apiFetch("/api/abby/devis/draft", { method: "POST", body: payload });
  }

  async function finalizeAbbyDevis(billingId, demandeId) {
    return apiFetch(`/api/abby/devis/${encodeURIComponent(billingId)}/finalize`, {
      method: "POST",
      body: { demande_id: demandeId },
    });
  }

  async function sendAbbyDevis(billingId, payload) {
    return apiFetch(`/api/abby/devis/${encodeURIComponent(billingId)}/send`, {
      method: "POST",
      body: payload,
    });
  }

  async function syncTourneeCalendar(tourneeId, payload) {
    return apiFetch(`/api/tournees/${encodeURIComponent(tourneeId)}/sync-calendar`, {
      method: "POST",
      body: payload,
    });
  }

  window.formatDurationH = function formatDurationH(hours) {
    const mins = Math.max(0, Math.round(Number(hours || 0) * 60));
    if (mins === 0) return "0 min";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m} min`;
    return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
  };

  function subscribeTourneeRealtime(_tourneeId, onChange) {
    if (typeof EventSource === "undefined") return () => {};
    const es = new EventSource("/api/events", { withCredentials: true });
    es.onmessage = (ev) => {
      if (!ev.data || ev.data === "ping") return;
      onChange(ev.data);
    };
    return () => es.close();
  }

  window.PianissimoDB = {
    loginWithTeamCode,
    getActiveSession,
    logout,
    fetchTournees,
    createTournee,
    updateTournee,
    fetchTourneeBundle,
    createDemande,
    updateDemande,
    deleteDemande,
    toggleAnomalie,
    saveBrouillon,
    logMessage,
    sendMessageDirect,
    syncMessagesNow,
    checkAbbyCustomer,
    searchAbbyCustomers,
    createAbbyDevisDraft,
    finalizeAbbyDevis,
    sendAbbyDevis,
    syncTourneeCalendar,
    subscribeTourneeRealtime,
  };
})();
