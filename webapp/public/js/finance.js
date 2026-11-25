// Module Pilotage financier, rentabilité prévisionnelle et suivi des devis
(() => {
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render({ tournee, demandes, onSaveFrais, onChangeDevis, onOpenDemande }) {
    const container = document.getElementById("finance-summary-grid");
    if (!container || !tournee) return;

    const bareme = tournee.bareme || { concert_eur: 320, etude_eur: 280, celtique_eur: 150 };
    const frais = tournee.frais_estimes || {
      location_voiture: 300,
      carburant_peages: 180,
      train_approche: 80,
      hotel_nuit: 90,
      nb_nuits: 5,
    };

    const actives = demandes.filter((d) => d.statut !== "annule" && d.statut !== "doublon");

    let caConfirme = 0;
    let caEnCours = 0;
    let totalConcert = 0;
    let totalEtude = 0;
    let totalCeltique = 0;
    let totalInconnu = 0;

    for (const d of actives) {
      totalConcert += Number(d.nb_concert || 0);
      totalEtude += Number(d.nb_etude || 0);
      totalCeltique += Number(d.nb_celtique || 0);
      totalInconnu += Number(d.nb_inconnu || 0);

      const est =
        d.montant_estime_eur != null
          ? Number(d.montant_estime_eur)
          : Number(d.nb_concert || 0) * bareme.concert_eur +
            Number(d.nb_etude || 0) * bareme.etude_eur +
            Number(d.nb_celtique || 0) * bareme.celtique_eur;

      if (d.statut === "confirme") caConfirme += est;
      else caEnCours += est;
    }

    const totalFrais =
      Number(frais.location_voiture || 0) +
      Number(frais.carburant_peages || 0) +
      Number(frais.train_approche || 0) +
      Number(frais.hotel_nuit || 0) * Number(frais.nb_nuits || 0);

    const caTotalBas = caConfirme + caEnCours;
    const caTotalHaut = caTotalBas + totalInconnu * bareme.concert_eur;
    const netBas = caTotalBas - totalFrais;
    const netHaut = caTotalHaut - totalFrais;

    const devisItems = actives.filter((d) => d.devis_statut !== "non_requis" || d.categorie === "conservatoire" || d.categorie === "opera" || d.categorie === "academie");

    const devisRows = devisItems
      .map(
        (d) => `
      <tr>
        <th scope="row">${escapeHtml(d.nom)}</th>
        <td>${escapeHtml(d.montant_note || (d.montant_estime_eur ? `${d.montant_estime_eur} €` : "À chiffrer"))}</td>
        <td>
          <select class="select-sm js-devis-statut" data-id="${d.id}" aria-label="Statut devis pour ${escapeHtml(d.nom)}">
            <option value="non_requis" ${d.devis_statut === "non_requis" ? "selected" : ""}>Non requis</option>
            <option value="a_faire" ${d.devis_statut === "a_faire" ? "selected" : ""}>À faire</option>
            <option value="envoye" ${d.devis_statut === "envoye" ? "selected" : ""}>Envoyé</option>
            <option value="accepte" ${d.devis_statut === "accepte" ? "selected" : ""}>Accepté / BC</option>
            <option value="marche_public" ${d.devis_statut === "marche_public" ? "selected" : ""}>Marché public</option>
          </select>
        </td>
        <td>${escapeHtml(d.devis_ref || "—")}</td>
        <td><button type="button" class="btn btn-ghost btn-xs js-fin-fiche" data-id="${d.id}">Fiche</button></td>
      </tr>
    `,
      )
      .join("");

    container.innerHTML = `
      <section class="card">
        <h2>Chiffre d'affaires &amp; rentabilité</h2>
        <p class="card-sub">Estimation basée sur les harpes prouvées et le barème de la tournée</p>
        <div class="kpi-strip" style="margin-top:12px;">
          <div class="kpi-card">
            <div class="kpi-label">CA confirmé (hors marchés non chiffrés)</div>
            <div class="kpi-value">${Math.round(caConfirme).toLocaleString("fr-FR")} €</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">CA en cours (proposé / conflit)</div>
            <div class="kpi-value">${Math.round(caEnCours).toLocaleString("fr-FR")} €</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Fourchette globale brute</div>
            <div class="kpi-value">${Math.round(caTotalBas).toLocaleString("fr-FR")} – ${Math.round(caTotalHaut).toLocaleString("fr-FR")} €</div>
            <div class="kpi-detail">${totalInconnu} harpe(s) à modèle inconnu</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label">Net prévisionnel (après frais)</div>
            <div class="kpi-value" style="color:${netBas >= 0 ? "var(--ok)" : "var(--danger)"}">${Math.round(netBas).toLocaleString("fr-FR")} – ${Math.round(netHaut).toLocaleString("fr-FR")} €</div>
            <div class="kpi-detail">Frais déduits : ${Math.round(totalFrais).toLocaleString("fr-FR")} €</div>
          </div>
        </div>

        <h3 style="font-size:0.98rem;margin-top:14px;">Frais de tournée prévisionnels</h3>
        <form id="form-frais-tournee" class="finance-form">
          <label>Location voiture (€)<input type="number" id="frais-loc" value="${Number(frais.location_voiture || 0)}" /></label>
          <label>Carburant &amp; péages (€)<input type="number" id="frais-carb" value="${Number(frais.carburant_peages || 0)}" /></label>
          <label>Train d'approche (€)<input type="number" id="frais-train" value="${Number(frais.train_approche || 0)}" /></label>
          <label>Hôtel / nuit (€)<input type="number" id="frais-hotel" value="${Number(frais.hotel_nuit || 0)}" /></label>
          <label>Nb nuits<input type="number" id="frais-nuits" value="${Number(frais.nb_nuits || 0)}" /></label>
          <div style="display:flex;align-items:flex-end;">
            <button type="submit" class="btn btn-primary btn-sm">Mettre à jour frais</button>
          </div>
        </form>
      </section>

      <section class="card">
        <h2>Parc d'instruments &amp; Devis institutions</h2>
        <p class="card-sub">Répartition active : ${totalConcert} Concert · ${totalEtude} Étude · ${totalCeltique} Celtique · ${totalInconnu} À préciser</p>
        <div tabindex="0" role="region" aria-label="Suivi des devis et marchés publics" class="table-wrapper" style="margin-top:12px;">
          <table class="data-table">
            <thead>
              <tr>
                <th scope="col">Établissement / Client</th>
                <th scope="col">Montant / Note</th>
                <th scope="col">Statut devis</th>
                <th scope="col">Référence</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              ${devisRows || `<tr><td colspan="5">Aucune institution ou demande de devis sur cette tournée.</td></tr>`}
            </tbody>
          </table>
        </div>
      </section>
    `;

    document.getElementById("form-frais-tournee")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      await onSaveFrais({
        location_voiture: Number(document.getElementById("frais-loc").value || 0),
        carburant_peages: Number(document.getElementById("frais-carb").value || 0),
        train_approche: Number(document.getElementById("frais-train").value || 0),
        hotel_nuit: Number(document.getElementById("frais-hotel").value || 0),
        nb_nuits: Number(document.getElementById("frais-nuits").value || 0),
      });
    });

    container.querySelectorAll(".js-devis-statut").forEach((sel) => {
      sel.addEventListener("change", () => onChangeDevis(sel.dataset.id, sel.value));
    });

    container.querySelectorAll(".js-fin-fiche").forEach((btn) => {
      btn.addEventListener("click", () => onOpenDemande(btn.dataset.id));
    });
  }

  window.PianissimoFinance = { render };
})();
