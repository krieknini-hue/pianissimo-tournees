// Générateur de messages personnalisables & garde-fous métier Pianissimo
(() => {
  const ANTHONY_PHONE_DISPLAY = "06 28 23 07 61";
  const ANTHONY_DIGITS = "33628230761";
  const FR_MOBILE_REGEX = /(?:0|\+33|0033)\s*[67](?:[\s.-]*\d{2}){4}/g;

  function findUnauthorizedPhones(text) {
    const matches = (text || "").match(FR_MOBILE_REGEX) || [];
    return matches.filter((m) => {
      let d = m.replace(/\D/g, "");
      if (d.startsWith("00")) d = d.slice(2);
      if (d.startsWith("0") && d.length === 10) d = "33" + d.slice(1);
      return d !== ANTHONY_DIGITS;
    });
  }

  function formatDayFrench(isoDate) {
    if (!isoDate) return "lors de notre passage";
    const [y, m, d] = isoDate.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "UTC",
    });
  }

  function formatHourFrench(timeStr) {
    if (!timeStr) return "";
    const [hh, mm] = timeStr.slice(0, 5).split(":");
    return `${Number(hh)}h${mm === "00" ? "00" : mm}`;
  }

  function extractSalutation(demande) {
    const nom = demande.nom || "";
    const paren = nom.match(/\(([^)]+)\)/);
    if (paren && /(conservatoire|crr|opéra|opera)/i.test(nom)) {
      const inner = paren[1].trim();
      if (inner.includes(" ")) return `Bonjour ${inner.split(" ")[0]},`;
    }
    const clean = nom.replace(/\(.*?\)/g, "").trim();
    if (/^(M\.|Mme|Mr)\s+/i.test(clean)) return `Bonjour ${clean},`;
    if (/(conservatoire|crr|opéra|opera|académie|academie)/i.test(clean)) return "Bonjour,";
    const first = clean.split(/\s+/).find((w) => w && w !== w.toUpperCase());
    return first ? `Bonjour ${first},` : "Bonjour,";
  }

  function generateTemplate(demande, intent, tournee) {
    const salut = extractSalutation(demande);
    const jour = formatDayFrench(demande.jour_date);
    const heure = demande.heure_debut ? ` vers ${formatHourFrench(demande.heure_debut)}` : "";
    const addr = demande.adresse || demande.ville || "votre adresse";
    const signature = `\n\nBien cordialement,\nMarie — PIANISSIMO\nContact Anthony : ${ANTHONY_PHONE_DISPLAY}`;

    let corps = "";
    if (intent === "proposition") {
      corps = `Nous préparons l'itinéraire de la tournée ${tournee?.nom || ""} et nous vous proposons un passage le ${jour}${heure} (${addr}).\nEst-ce que ce créneau vous conviendrait ?`;
    } else if (intent === "recalage") {
      corps = `Suite à votre retour concernant vos disponibilités, nous pouvons réorganiser notre passage et vous proposer le ${jour}${heure} (${addr}).\nPourriez-vous nous dire si cette nouvelle proposition vous convient ?`;
    } else if (intent === "precisions") {
      corps = `Pour préparer au mieux notre intervention${demande.jour_date ? ` envisagée le ${jour}` : ""}, pourriez-vous nous confirmer :\n- le modèle exact de votre harpe ;\n- l'adresse complète (et la salle le cas échéant) ?`;
    } else if (intent === "confirmation") {
      corps = `Merci pour votre retour ! Nous confirmons notre passage le ${jour}${heure} à l'adresse : ${addr}.\nNous vous préviendrons en cas d'imprévu sur la route.`;
    } else if (intent === "rappel") {
      corps = `Petit rappel de notre passage prévu le ${jour}${heure} à l'adresse : ${addr}.\nN'hésitez pas à nous prévenir au ${ANTHONY_PHONE_DISPLAY} en cas de changement.`;
    } else {
      corps = `Nous vous proposons un passage le ${jour}${heure} (${addr}).`;
    }

    const objet = `Tournée harpes Pianissimo — ${demande.nom}`;
    return {
      objet,
      texte: `${salut}\n\n${corps}${signature}`,
    };
  }

  function evaluateGuards(text, demande) {
    const alerts = [];
    const content = text || "";

    const badPhones = findUnauthorizedPhones(content);
    if (badPhones.length > 0) {
      alerts.push({
        level: "danger",
        code: "MARIE_PHONE",
        message: `Numéro non autorisé détecté (${badPhones.join(", ")}) ! Seul le numéro d'Anthony (${ANTHONY_PHONE_DISPLAY}) est autorisé dans les messages clients.`,
        fixLabel: `Remplacer par ${ANTHONY_PHONE_DISPLAY}`,
      });
    }

    if (demande.statut !== "confirme" && /\bconfirm(ons|é|er|e)\b/i.test(content)) {
      alerts.push({
        level: "warn",
        code: "UNCONFIRMED_CONFIRM",
        message: `Ce client est au statut « ${demande.statut} ». Règle Pianissimo : PROPOSER un créneau, ne jamais « confirmer » avant son accord.`,
      });
    }

    if (demande.heure_debut) {
      const expected = formatHourFrench(demande.heure_debut);
      const timeTokens = content.match(/\b\d{1,2}h\d{0,2}\b/gi) || [];
      if (timeTokens.length > 0 && !timeTokens.some((t) => t.toLowerCase() === expected.toLowerCase())) {
        alerts.push({
          level: "warn",
          code: "TIME_DRIFT",
          message: `Le texte mentionne (${timeTokens.join(", ")}) alors que le planning prévoit ${expected}.`,
        });
      }
    }

    if (!alerts.length && content.trim()) {
      alerts.push({
        level: "ok",
        code: "ALL_GOOD",
        message: `Message conforme (numéro Anthony ${ANTHONY_PHONE_DISPLAY}, cohérence statut & horaire OK).`,
      });
    }

    return alerts;
  }

  function fixMariePhone(text) {
    return (text || "").replace(FR_MOBILE_REGEX, (m) => {
      let d = m.replace(/\D/g, "");
      if (d.startsWith("00")) d = d.slice(2);
      if (d.startsWith("0") && d.length === 10) d = "33" + d.slice(1);
      return d === ANTHONY_DIGITS ? m : ANTHONY_PHONE_DISPLAY;
    });
  }

  function normalizeWaPhone(rawPhone) {
    if (!rawPhone) return "";
    let d = rawPhone.replace(/[^\d+]/g, "");
    if (d.startsWith("00")) d = "+" + d.slice(2);
    if (d.startsWith("0") && d.length === 10) d = "33" + d.slice(1);
    else if (d.startsWith("0") && d.length === 9) d = "32" + d.slice(1);
    d = d.replace(/\D/g, "");
    return d.length >= 9 ? d : "";
  }

  function buildWhatsAppUrl(rawPhone, text) {
    const num = normalizeWaPhone(rawPhone);
    if (!num) return "";
    return `https://wa.me/${num}?text=${encodeURIComponent(text || "")}`;
  }

  function buildMailtoUrl(email, subject, body) {
    if (!email) return "";
    return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject || "Tournée harpes Pianissimo")}&body=${encodeURIComponent(body || "")}`;
  }

  window.PianissimoTemplates = {
    ANTHONY_PHONE_DISPLAY,
    formatDayFrench,
    formatHourFrench,
    generateTemplate,
    evaluateGuards,
    fixMariePhone,
    normalizeWaPhone,
    buildWhatsAppUrl,
    buildMailtoUrl,
  };
})();
