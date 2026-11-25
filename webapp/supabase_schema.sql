-- Schéma PostgreSQL pour Pianissimo · Tournées Harpe
-- Supabase (Postgres 17) — RLS strict TO authenticated + Edge Function tournees-auth

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- 1. Schéma privé d'authentification (non exposé via Data API)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.app_access_codes (
  id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_hash text NOT NULL,
  auth_email text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT 'Equipe Pianissimo',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Fonction de vérification appelée uniquement par service_role (Edge Function tournees-auth)
CREATE OR REPLACE FUNCTION private.verify_tournees_code(candidate text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = private, extensions, pg_temp
AS $$
DECLARE
  matched_email text;
BEGIN
  IF candidate IS NULL OR length(trim(candidate)) = 0 THEN
    RETURN NULL;
  END IF;

  SELECT auth_email
    INTO matched_email
  FROM private.app_access_codes
  WHERE active = true
    AND extensions.crypt(trim(candidate), code_hash) = code_hash
  LIMIT 1;

  RETURN matched_email;
END;
$$;

REVOKE ALL ON FUNCTION private.verify_tournees_code(text) FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT EXECUTE ON FUNCTION private.verify_tournees_code(text) TO service_role;

-- Wrapper minimal dans public non accessible à anon/authenticated pour compatibilité RPC standard
CREATE OR REPLACE FUNCTION public.verify_tournees_code(candidate text)
RETURNS text
LANGUAGE sql
SECURITY INVOKER
SET search_path = private, pg_temp
AS $$
  SELECT private.verify_tournees_code(candidate);
$$;

REVOKE ALL ON FUNCTION public.verify_tournees_code(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_tournees_code(text) TO service_role;

-- 2. Trigger updated_at partagé
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- 3. Tables métier
CREATE TABLE IF NOT EXISTS public.tournees (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text UNIQUE NOT NULL,
  nom text NOT NULL,
  date_debut date NOT NULL,
  date_fin date NOT NULL,
  statut text NOT NULL DEFAULT 'en_preparation'
    CHECK (statut IN ('a_venir', 'en_preparation', 'en_cours', 'terminee')),
  nb_luthiers integer NOT NULL DEFAULT 2 CHECK (nb_luthiers BETWEEN 1 AND 4),
  bareme jsonb NOT NULL DEFAULT '{"concert_eur":320,"concert_h":2.5,"etude_eur":280,"etude_h":2,"celtique_eur":150,"celtique_h":0.75}'::jsonb,
  frais_estimes jsonb NOT NULL DEFAULT '{"location_voiture":300,"carburant_peages":180,"train_approche":80,"hotel_nuit":90,"nb_nuits":5}'::jsonb,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.demandes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournee_id uuid NOT NULL REFERENCES public.tournees(id) ON DELETE CASCADE,
  external_key text,
  nom text NOT NULL,
  categorie text NOT NULL DEFAULT 'particulier'
    CHECK (categorie IN ('particulier', 'prof', 'conservatoire', 'opera', 'academie')),
  secteur text NOT NULL DEFAULT 'Autre',
  ville text NOT NULL DEFAULT '',
  cp text NOT NULL DEFAULT '',
  pays text NOT NULL DEFAULT '',
  adresse text NOT NULL DEFAULT '',
  adresse_verifiee boolean NOT NULL DEFAULT false,
  latitude double precision,
  longitude double precision,
  canal_prefere text NOT NULL DEFAULT 'WhatsApp'
    CHECK (canal_prefere IN ('WhatsApp', 'Email', 'SMS', 'Telephone')),
  telephone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  nb_concert integer NOT NULL DEFAULT 0 CHECK (nb_concert >= 0),
  nb_etude integer NOT NULL DEFAULT 0 CHECK (nb_etude >= 0),
  nb_celtique integer NOT NULL DEFAULT 0 CHECK (nb_celtique >= 0),
  nb_inconnu integer NOT NULL DEFAULT 0 CHECK (nb_inconnu >= 0),
  instruments_detail text NOT NULL DEFAULT '',
  duree_estimee_h numeric(4,2) NOT NULL DEFAULT 0,
  montant_estime_eur numeric(8,2),
  montant_note text NOT NULL DEFAULT '',
  statut text NOT NULL DEFAULT 'a_qualifier'
    CHECK (statut IN ('a_contacter', 'contacte', 'a_qualifier', 'propose', 'conflit', 'confirme', 'annule', 'doublon')),
  jour_date date,
  heure_debut time,
  ordre_jour integer NOT NULL DEFAULT 0,
  creneau_epingle boolean NOT NULL DEFAULT false,
  contraintes text NOT NULL DEFAULT '',
  citation_source text NOT NULL DEFAULT '',
  action_requise text NOT NULL DEFAULT '',
  devis_statut text NOT NULL DEFAULT 'non_requis'
    CHECK (devis_statut IN ('non_requis', 'a_faire', 'envoye', 'accepte', 'marche_public')),
  devis_ref text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tournee_id, external_key)
);

CREATE TABLE IF NOT EXISTS public.messages_historique (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demande_id uuid NOT NULL REFERENCES public.demandes(id) ON DELETE CASCADE,
  tournee_id uuid NOT NULL REFERENCES public.tournees(id) ON DELETE CASCADE,
  canal text NOT NULL CHECK (canal IN ('WhatsApp', 'Email', 'SMS', 'Note')),
  direction text NOT NULL CHECK (direction IN ('entrant', 'sortant', 'interne')),
  horodatage timestamptz NOT NULL DEFAULT now(),
  contenu text NOT NULL,
  auteur text NOT NULL DEFAULT '',
  external_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (demande_id, external_hash)
);

CREATE TABLE IF NOT EXISTS public.brouillons_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  demande_id uuid NOT NULL REFERENCES public.demandes(id) ON DELETE CASCADE,
  tournee_id uuid NOT NULL REFERENCES public.tournees(id) ON DELETE CASCADE,
  canal text NOT NULL DEFAULT 'WhatsApp' CHECK (canal IN ('WhatsApp', 'Email', 'SMS')),
  objet text NOT NULL DEFAULT '',
  texte_propose text NOT NULL DEFAULT '',
  texte_final text NOT NULL DEFAULT '',
  statut text NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon', 'valide', 'envoye')),
  valide_par text NOT NULL DEFAULT '',
  envoye_le timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (demande_id, canal)
);

CREATE TABLE IF NOT EXISTS public.anomalies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournee_id uuid NOT NULL REFERENCES public.tournees(id) ON DELETE CASCADE,
  demande_id uuid REFERENCES public.demandes(id) ON DELETE SET NULL,
  severite text NOT NULL CHECK (severite IN ('critique', 'haute', 'moyenne', 'info')),
  categorie text NOT NULL,
  titre text NOT NULL,
  description text NOT NULL,
  preuve_source text NOT NULL DEFAULT '',
  action_proposee text NOT NULL DEFAULT '',
  resolue boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- 4. Index sur clés étrangères & requêtes fréquentes
CREATE INDEX IF NOT EXISTS idx_demandes_tournee_id ON public.demandes (tournee_id);
CREATE INDEX IF NOT EXISTS idx_demandes_planning ON public.demandes (tournee_id, jour_date, ordre_jour);
CREATE INDEX IF NOT EXISTS idx_messages_demande_ts ON public.messages_historique (demande_id, horodatage DESC);
CREATE INDEX IF NOT EXISTS idx_messages_tournee_id ON public.messages_historique (tournee_id);
CREATE INDEX IF NOT EXISTS idx_brouillons_demande_id ON public.brouillons_messages (demande_id);
CREATE INDEX IF NOT EXISTS idx_brouillons_tournee_id ON public.brouillons_messages (tournee_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_tournee_id ON public.anomalies (tournee_id);
CREATE INDEX IF NOT EXISTS idx_anomalies_demande_id ON public.anomalies (demande_id);

-- 5. Triggers updated_at
DROP TRIGGER IF EXISTS trg_tournees_updated_at ON public.tournees;
CREATE TRIGGER trg_tournees_updated_at
  BEFORE UPDATE ON public.tournees
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_demandes_updated_at ON public.demandes;
CREATE TRIGGER trg_demandes_updated_at
  BEFORE UPDATE ON public.demandes
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_messages_updated_at ON public.messages_historique;
CREATE TRIGGER trg_messages_updated_at
  BEFORE UPDATE ON public.messages_historique
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_brouillons_updated_at ON public.brouillons_messages;
CREATE TRIGGER trg_brouillons_updated_at
  BEFORE UPDATE ON public.brouillons_messages
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_anomalies_updated_at ON public.anomalies;
CREATE TRIGGER trg_anomalies_updated_at
  BEFORE UPDATE ON public.anomalies
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 6. Privilèges et Row Level Security strict (zéro accès anonyme)
REVOKE ALL ON public.tournees, public.demandes, public.messages_historique, public.brouillons_messages, public.anomalies FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tournees, public.demandes, public.messages_historique, public.brouillons_messages, public.anomalies TO authenticated;

ALTER TABLE public.tournees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demandes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages_historique ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.brouillons_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.anomalies ENABLE ROW LEVEL SECURITY;

-- Policies par table (TO authenticated + app_metadata.app = 'pianissimo-tournees')
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tournees', 'demandes', 'messages_historique', 'brouillons_messages', 'anomalies']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS "team_select_%I" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "team_insert_%I" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "team_update_%I" ON public.%I', t, t);
    EXECUTE format('DROP POLICY IF EXISTS "team_delete_%I" ON public.%I', t, t);

    EXECUTE format(
      'CREATE POLICY "team_select_%I" ON public.%I FOR SELECT TO authenticated USING ((((select auth.jwt()) -> ''app_metadata'' ->> ''app'') = ''pianissimo-tournees''))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "team_insert_%I" ON public.%I FOR INSERT TO authenticated WITH CHECK ((((select auth.jwt()) -> ''app_metadata'' ->> ''app'') = ''pianissimo-tournees''))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "team_update_%I" ON public.%I FOR UPDATE TO authenticated USING ((((select auth.jwt()) -> ''app_metadata'' ->> ''app'') = ''pianissimo-tournees'')) WITH CHECK ((((select auth.jwt()) -> ''app_metadata'' ->> ''app'') = ''pianissimo-tournees''))',
      t, t
    );
    EXECUTE format(
      'CREATE POLICY "team_delete_%I" ON public.%I FOR DELETE TO authenticated USING ((((select auth.jwt()) -> ''app_metadata'' ->> ''app'') = ''pianissimo-tournees''))',
      t, t
    );
  END LOOP;
END
$$;

-- 7. Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.tournees;
ALTER PUBLICATION supabase_realtime ADD TABLE public.demandes;
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages_historique;
ALTER PUBLICATION supabase_realtime ADD TABLE public.brouillons_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.anomalies;

-- 8. Insertion d'un code d'accès par défaut (à personnaliser après déploiement si besoin)
-- Exemple SQL :
-- INSERT INTO private.app_access_codes (code_hash, auth_email, label)
-- VALUES (extensions.crypt('VOTRE_CODE', extensions.gen_salt('bf')), 'equipe@pianissimo-tournees.internal', 'Anthony & Marie')
-- ON CONFLICT (auth_email) DO NOTHING;
