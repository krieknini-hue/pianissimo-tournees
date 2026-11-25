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
    subscribeTourneeRealtime,
  };
})();
