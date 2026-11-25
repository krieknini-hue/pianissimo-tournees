// Client Supabase, authentification par code équipe et souscription Realtime
(() => {
  const cfg = window.PIANISSIMO_CONFIG;
  const supabaseClient = window.supabase.createClient(
    cfg.SUPABASE_URL,
    cfg.SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    },
  );

  async function loginWithTeamCode(code) {
    const res = await fetch(`${cfg.SUPABASE_URL}/functions/v1/${cfg.AUTH_FUNCTION}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.SUPABASE_PUBLISHABLE_KEY,
      },
      body: JSON.stringify({ code }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token || !body.refresh_token) {
      throw new Error(body.error || "Code d'accès invalide.");
    }
    const { data, error } = await supabaseClient.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
    });
    if (error) throw error;
    return data.session;
  }

  async function getActiveSession() {
    const { data } = await supabaseClient.auth.getSession();
    return data?.session || null;
  }

  async function logout() {
    await supabaseClient.auth.signOut();
  }

  async function fetchTournees() {
    const { data, error } = await supabaseClient
      .from("tournees")
      .select("*")
      .order("date_debut", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function fetchTourneeBundle(tourneeId) {
    const [demRes, msgRes, brouillonRes, anomRes] = await Promise.all([
      supabaseClient
        .from("demandes")
        .select("*")
        .eq("tournee_id", tourneeId)
        .order("jour_date", { ascending: true, nullsFirst: false })
        .order("ordre_jour", { ascending: true })
        .order("nom", { ascending: true }),
      supabaseClient
        .from("messages_historique")
        .select("*")
        .eq("tournee_id", tourneeId)
        .order("horodatage", { ascending: true }),
      supabaseClient
        .from("brouillons_messages")
        .select("*")
        .eq("tournee_id", tourneeId),
      supabaseClient
        .from("anomalies")
        .select("*")
        .eq("tournee_id", tourneeId)
        .order("resolue", { ascending: true })
        .order("created_at", { ascending: true }),
    ]);

    if (demRes.error) throw demRes.error;
    if (msgRes.error) throw msgRes.error;
    if (brouillonRes.error) throw brouillonRes.error;
    if (anomRes.error) throw anomRes.error;

    return {
      demandes: demRes.data || [],
      messages: msgRes.data || [],
      brouillons: brouillonRes.data || [],
      anomalies: anomRes.data || [],
    };
  }

  function subscribeTourneeRealtime(tourneeId, onChange) {
    const channel = supabaseClient
      .channel(`tournee-${tourneeId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "demandes", filter: `tournee_id=eq.${tourneeId}` },
        () => onChange("demandes"),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages_historique", filter: `tournee_id=eq.${tourneeId}` },
        () => onChange("messages_historique"),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "brouillons_messages", filter: `tournee_id=eq.${tourneeId}` },
        () => onChange("brouillons_messages"),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "anomalies", filter: `tournee_id=eq.${tourneeId}` },
        () => onChange("anomalies"),
      )
      .subscribe();

    return () => {
      supabaseClient.removeChannel(channel);
    };
  }

  window.PianissimoDB = {
    client: supabaseClient,
    loginWithTeamCode,
    getActiveSession,
    logout,
    fetchTournees,
    fetchTourneeBundle,
    subscribeTourneeRealtime,
  };
})();
