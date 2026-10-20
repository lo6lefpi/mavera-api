-- =============================================================================
-- Application client — schéma de la base de données (P0)
-- 20 octobre 2026
--
-- Normalisation : chaque table est en forme normale de Boyce-Codd (FNBC) et en
-- 4e forme normale (4FN).
--   * Chaque attribut dépend de la clé, de toute la clé et de rien d'autre.
--   * Aucun statut calculable n'est stocké : les statuts (question en attente,
--     demande reçue, activation, pause, compteurs) sont dérivés dans les vues
--     (fichier 04_views). On stocke des faits datés, jamais leur conséquence.
--   * Les ensembles indépendants d'un client (comptes, membres, options, etc.)
--     sont dans des tables séparées : pas de dépendance multivaluée (4FN).
--   * Les liens entre un objet et le contexte d'un autre client (document ↔
--     demande, message ↔ question, relance ↔ question) passent par des tables
--     d'association qui ne recopient pas client_id. La règle « même client des
--     deux côtés » est vérifiée par des déclencheurs (fichier 02_integrity).
--
-- Conventions : identifiants en anglais (comme le dossier domain/), commentaires
-- en français. Horodatages *_at (timestamptz), dates *_on, montants *_cents
-- (entiers, avant taxes). Les prix ne sont PAS ici : domain/pricing est la seule
-- source de vérité. La base garde seulement les montants convenus avec un
-- client (propositions), qui sont des faits historiques.
-- =============================================================================

create extension if not exists btree_gist with schema extensions;

-- Fonctions : PostgreSQL accorde EXECUTE à PUBLIC sur toute nouvelle fonction, par
-- un défaut GLOBAL. Un retrait limité à un schéma ne peut pas l'annuler : on retire
-- donc le défaut global du rôle qui exécute les migrations. Chaque fonction
-- appelable par l'application est ensuite accordée explicitement.
alter default privileges revoke execute on functions from public;

-- -----------------------------------------------------------------------------
-- Types énumérés : états fixés par le code (une valeur ajoutée = une migration)
-- -----------------------------------------------------------------------------
create type public.member_role       as enum ('owner', 'collaborator');
create type public.filing_frequency  as enum ('monthly', 'quarterly', 'annual');
create type public.account_kind      as enum ('bank', 'credit_card', 'platform', 'other');
create type public.billing_option    as enum ('monthly', 'monthly_commitment', 'annual');
create type public.close_reason      as enum ('no_response', 'declined_proposal', 'refund_before_call', 'client_request', 'end_of_mandate', 'non_payment', 'previously_refused', 'other');
create type public.closure_kind      as enum ('temporary', 'permanent');
create type public.review_outcome    as enum ('different_person', 'same_person');
create type public.pause_outcome     as enum ('resumed', 'closed');
create type public.proposal_kind     as enum ('plan_change', 'add_on', 'books_update', 'custom_quote', 'compliance_catch_up');
create type public.proposal_decision as enum ('accepted', 'declined');
create type public.answer_kind       as enum ('text', 'personal', 'receipt');
create type public.document_direction as enum ('from_client', 'from_firm');
create type public.reminder_reason   as enum ('pending_items', 'intake_form');
create type public.device_platform   as enum ('ios', 'android', 'web');
create type public.deletion_source   as enum ('app', 'web');

-- -----------------------------------------------------------------------------
-- Tables de référence : listes que l'entreprise peut modifier sans code
-- -----------------------------------------------------------------------------
create table public.plans (
  code       text primary key check (code ~ '^[a-z_]+$'),
  name       text not null,
  sort_order smallint not null
);
comment on table public.plans is
  'Forfaits. La grille en vigueur (prix, quota) est dans domain/pricing; les conditions accordées à chaque client sont photographiées dans subscriptions et subscription_plan_periods.';

create table public.add_ons (
  code text primary key check (code ~ '^[a-z_]+$'),
  name text not null
);
comment on table public.add_ons is 'Options payantes ajoutables à un forfait (compte supplémentaire, déclarations plus fréquentes, etc.).';

create table public.document_types (
  code               text primary key check (code ~ '^[a-z_]+$'),
  name               text not null,
  sendable_by_client boolean not null
);

create table public.activity_types (
  code text primary key check (code ~ '^[a-z_]+$'),
  name text not null
);

insert into public.plans (code, name, sort_order) values
  ('trajet',     'Trajet',     1),
  ('depart',     'Départ',     2),
  ('elan',       'Élan',       3),
  ('envol',      'Envol',      4),
  ('sur_mesure', 'Sur mesure', 5);

insert into public.add_ons (code, name) values
  ('extra_account',         'Compte supplémentaire'),
  ('more_frequent_filings', 'Déclarations de TPS/TVQ plus fréquentes'),
  ('client_invoicing',      'Factures clients');

insert into public.document_types (code, name, sendable_by_client) values
  ('receipt',          'Reçu',                 true),
  ('bank_statement',   'Relevé bancaire',      true),
  ('card_statement',   'Relevé de carte',      true),
  ('platform_report',  'Relevé de plateforme', true),
  ('invoice',          'Facture',              true),
  ('other',            'Autre',                true),
  ('report',           'Rapport',              false),
  ('tax_filing',       'Déclaration',          false);

insert into public.activity_types (code, name) values
  ('self_employed',   'Travailleur autonome'),
  ('platform_driver', 'Chauffeur de plateforme'),
  ('delivery',        'Livreur de plateforme'),
  ('small_business',  'TPE ou PME'),
  ('other',           'Autre');

-- -----------------------------------------------------------------------------
-- Personnes et accès
-- -----------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);
comment on table public.admins is 'Comptes de la firme. La double authentification (aal2) est exigée par private.is_admin().';

create table public.clients (
  id                 uuid primary key default gen_random_uuid(),
  display_name       text not null check (length(trim(display_name)) > 0),
  contact_email      text not null check (contact_email = lower(contact_email) and contact_email like '_%@_%'),
  phone              text,
  stripe_customer_id text unique,
  created_at         timestamptz not null default now()
);
comment on table public.clients is 'Le client de la firme (personne ou entreprise). Stable d''un mandat à l''autre.';

create table public.client_members (
  client_id uuid not null references public.clients (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  role      public.member_role not null default 'owner',
  added_at  timestamptz not null default now(),
  primary key (client_id, user_id)
);
create unique index client_members_one_owner on public.client_members (client_id) where role = 'owner';
create index client_members_user_idx on public.client_members (user_id);
comment on table public.client_members is 'Qui a accès au dossier d''un client. Un seul titulaire au lancement; collaborateurs en P3.';

create table public.invitations (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  email       text not null check (email = lower(email) and email like '_%@_%'),
  sent_at     timestamptz not null default now(),
  expires_at  timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users (id) on delete set null,
  check (expires_at > sent_at),
  check (accepted_by is null or accepted_at is not null)
);
create unique index invitations_one_pending on public.invitations (client_id, email) where accepted_at is null;

create table public.account_deletion_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid references auth.users (id) on delete set null,
  email        text not null check (email = lower(email)),
  source       public.deletion_source not null,
  requested_at timestamptz not null default now(),
  processed_at timestamptz
);
comment on table public.account_deletion_requests is 'Demandes de suppression (dans l''application ou par la page web exigée par Google Play).';

-- -----------------------------------------------------------------------------
-- Comptes utilisés et autorisation (au niveau du client)
-- -----------------------------------------------------------------------------
create table public.client_accounts (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  kind        public.account_kind not null,
  institution text not null check (length(trim(institution)) > 0),
  nickname    text,
  created_at  timestamptz not null default now(),
  unique nulls not distinct (client_id, kind, institution, nickname)
);
create index client_accounts_client_idx on public.client_accounts (client_id);
comment on table public.client_accounts is 'Comptes et plateformes utilisés (banque, carte, Uber…). Jamais de numéro de compte.';

create table public.revenue_quebec_authorizations (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients (id) on delete cascade,
  signer_name text not null check (length(trim(signer_name)) > 0),
  signed_by   uuid references auth.users (id) on delete set null default auth.uid(),
  signed_at   timestamptz not null default now(),
  revoked_at  timestamptz,
  check (revoked_at is null or revoked_at >= signed_at)
);
create unique index rq_authorizations_one_active on public.revenue_quebec_authorizations (client_id) where revoked_at is null;

-- -----------------------------------------------------------------------------
-- Mandats, abonnements et pauses
-- -----------------------------------------------------------------------------
create table public.mandates (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references public.clients (id) on delete cascade,
  opened_at            timestamptz not null default now(),
  welcome_call_done_at timestamptz,
  quickbooks_ready_at  timestamptz,
  activated_at         timestamptz,
  check (activated_at is null or (welcome_call_done_at is not null and quickbooks_ready_at is not null))
);
create index mandates_client_idx on public.mandates (client_id);
comment on table public.mandates is
  'Une période de service. Une réouverture après fermeture temporaire crée un nouveau mandat (nouveaux frais d''ouverture). Le statut d''activation est dérivé (vue mandate_status). Un seul mandat ouvert par client (déclencheur mandates_one_open).';

create table public.mandate_closures (
  mandate_id      uuid primary key references public.mandates (id) on delete cascade,
  kind            public.closure_kind not null,
  reason          public.close_reason not null,
  closed_at       timestamptz not null default now(),
  closed_by       uuid references auth.users (id) on delete set null,
  retention_until date not null
);
comment on table public.mandate_closures is
  'Fermeture d''un mandat. temporary : le client peut revenir (réouverture). permanent : le client n''est plus accepté; toute nouvelle inscription avec son adresse est refusée (check_signup_eligibility).';
comment on column public.mandate_closures.closed_by is 'Null : fermeture automatique (dossier sans réponse).';

create table public.closure_lifts (
  mandate_id uuid primary key references public.mandate_closures (mandate_id) on delete cascade,
  lifted_at  timestamptz not null default now(),
  lifted_by  uuid references auth.users (id) on delete set null,
  reason     text not null check (length(trim(reason)) > 0)
);
comment on table public.closure_lifts is
  'Annulation d''une fermeture définitive (erreur, situation réglée). Le client redevient admissible comme après une fermeture temporaire : il peut se réinscrire (nouveau mandat, nouveaux frais d''ouverture). La fermeture reste au dossier, pour l''historique.';

-- Fiche de départ : une par mandat. À la réouverture, une nouvelle fiche est
-- préremplie à partir de la précédente; le client la confirme ou la corrige.
create table public.intake_forms (
  mandate_id                     uuid primary key references public.mandates (id) on delete cascade,
  activity_type_code             text references public.activity_types (code),
  gst_qst_registered             boolean,
  gst_qst_frequency              public.filing_frequency,
  books_up_to_date               boolean,          -- réponse du site
  uses_quickbooks                boolean,          -- réponse du site
  estimated_monthly_transactions integer check (estimated_monthly_transactions >= 0), -- simulateur du site
  current_step                   smallint not null default 1 check (current_step between 1 and 20),
  completed_at                   timestamptz,
  check (gst_qst_frequency is null or gst_qst_registered),
  check (completed_at is null or (
         activity_type_code is not null
     and gst_qst_registered is not null
     and (not gst_qst_registered or gst_qst_frequency is not null)))
);
comment on column public.intake_forms.current_step is 'Dernier écran atteint : permet de reprendre plus tard.';

create table public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  mandate_id             uuid not null references public.mandates (id) on delete cascade,
  stripe_subscription_id text not null unique,
  billing_option         public.billing_option not null,
  starts_on              date not null,
  opening_fee_cents      integer not null check (opening_fee_cents >= 0),
  stripe_status          text not null,
  payment_failed_at      timestamptz,
  read_only_since        timestamptz,
  ended_at               timestamptz,
  check (read_only_since is null or payment_failed_at is not null)
);
create unique index subscriptions_one_current on public.subscriptions (mandate_id) where ended_at is null;
comment on column public.subscriptions.starts_on is
  'Mois en cours ou mois suivant, selon le choix fait sur le site. La fin de l''engagement (12 mois) se calcule à partir de starts_on et billing_option.';
comment on column public.subscriptions.read_only_since is
  'Fixé par le domaine (TypeScript) à la fin du délai de grâce. La RLS bloque alors les envois du client.';

create table public.subscription_plan_periods (
  subscription_id uuid not null references public.subscriptions (id) on delete cascade,
  plan_code               text not null references public.plans (code),
  effective_from          date not null,
  effective_to            date,
  recurring_price_cents   integer not null check (recurring_price_cents >= 0),
  included_transactions   integer check (included_transactions > 0),   -- null : sans quota (sur mesure)
  extra_transaction_cents integer not null check (extra_transaction_cents >= 0),
  stripe_price_id         text not null,
  primary key (subscription_id, effective_from),
  check (effective_to is null or effective_to > effective_from),
  exclude using gist (subscription_id with =, daterange(effective_from, effective_to, '[)') with &&)
);
comment on table public.subscription_plan_periods is
  'Historique des forfaits avec les conditions accordées (photographie contractuelle) : prix par cycle de facturation (mois ou année selon billing_option), quota, prix d''une transaction supplémentaire, prix Stripe. Un changement de grille dans domain/pricing ne touche pas les clients déjà inscrits. Une hausse ferme la période en cours et en ouvre une autre le jour même; une baisse, au début du mois suivant. Les périodes ne se chevauchent pas.';

create table public.subscription_add_ons (
  subscription_id uuid not null references public.subscriptions (id) on delete cascade,
  add_on_code     text not null references public.add_ons (code),
  quantity              smallint not null default 1 check (quantity > 0),
  recurring_price_cents integer not null check (recurring_price_cents >= 0),  -- prix unitaire accordé
  effective_from        date not null,
  effective_to    date,
  primary key (subscription_id, add_on_code, effective_from),
  check (effective_to is null or effective_to > effective_from),
  exclude using gist (subscription_id with =, add_on_code with =, daterange(effective_from, effective_to, '[)') with &&)
);

create table public.signup_flags (
  mandate_id        uuid not null references public.mandates (id) on delete cascade,
  matched_client_id uuid not null references public.clients (id) on delete cascade,
  flagged_at        timestamptz not null default now(),
  primary key (mandate_id, matched_client_id)
);
comment on table public.signup_flags is
  'Inscription à vérifier : le téléphone correspond à un client fermé définitivement. Un numéro peut avoir été réattribué à une autre personne : on ne refuse pas, la teneuse de livres vérifie à l''appel de bienvenue.';

create table public.signup_reviews (
  mandate_id  uuid primary key references public.mandates (id) on delete cascade,
  outcome     public.review_outcome not null,
  reviewed_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null
);
comment on table public.signup_reviews is 'Décision de la teneuse de livres sur une inscription à vérifier. Le mandat ne peut pas être activé avant.';

create table public.pauses (
  id                uuid primary key default gen_random_uuid(),
  mandate_id        uuid not null references public.mandates (id) on delete cascade,
  started_at        timestamptz not null default now(),
  skipped_charge_on date not null,
  ended_at          timestamptz,
  outcome           public.pause_outcome,
  check ((ended_at is null) = (outcome is null)),
  check (ended_at is null or ended_at >= started_at)
);
create unique index pauses_one_open on public.pauses (mandate_id) where ended_at is null;
comment on column public.pauses.skipped_charge_on is 'Date du prélèvement annulé (affichée dans « Dossiers en pause »).';

create table public.stripe_events (
  id           text primary key,          -- evt_… : un événement reçu deux fois est rejeté
  type         text not null,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

-- -----------------------------------------------------------------------------
-- Propositions et notes au dossier
-- -----------------------------------------------------------------------------
create table public.proposals (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients (id) on delete cascade,
  kind         public.proposal_kind not null,
  title        text not null,
  details      text,
  amount_cents integer not null check (amount_cents >= 0),
  plan_code    text references public.plans (code),
  add_on_code  text references public.add_ons (code),
  installments smallint not null default 1 check (installments between 1 and 3),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  check ((kind = 'plan_change') = (plan_code is not null)),
  check ((kind = 'add_on') = (add_on_code is not null)),
  check (installments = 1 or kind = 'books_update'),
  check (expires_at is null or expires_at > created_at)
);
create index proposals_client_idx on public.proposals (client_id);
comment on column public.proposals.amount_cents is 'Prix exact proposé, avant taxes, calculé par domain/pricing au moment de la proposition.';
comment on column public.proposals.created_by is 'Null : créée par le système (ex. mise à jour du mois en cours choisie au paiement).';

create table public.proposal_responses (
  proposal_id  uuid primary key references public.proposals (id) on delete cascade,
  decision     public.proposal_decision not null,
  responded_by uuid references auth.users (id) on delete set null,
  responded_at timestamptz not null default now()
);
comment on table public.proposal_responses is 'Réponse gardée au dossier. Une seule par proposition, jamais modifiée.';

create table public.file_notes (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients (id) on delete cascade,
  body              text not null check (length(trim(body)) > 0),
  visible_to_client boolean not null default false,
  created_by        uuid references auth.users (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now()
);
create index file_notes_client_idx on public.file_notes (client_id);
comment on table public.file_notes is 'Ce qui est « noté au dossier » (service non inclus, période non couverte…).';

-- -----------------------------------------------------------------------------
-- Documents
-- -----------------------------------------------------------------------------
create table public.documents (
  id                        uuid primary key default gen_random_uuid(),
  client_id                 uuid not null references public.clients (id) on delete cascade,
  direction                 public.document_direction not null,
  document_type_code        text not null references public.document_types (code),
  title                     text,
  note                      text,
  uploaded_by               uuid references auth.users (id) on delete set null default auth.uid(),
  created_at                timestamptz not null default now(),
  sent_at                   timestamptz,
  processed_at              timestamptz,
  quickbooks_transferred_at timestamptz,  -- P2
  check (sent_at is null or sent_at >= created_at),
  check (processed_at is null or sent_at is not null)
);
create index documents_client_idx on public.documents (client_id, direction, sent_at desc);
comment on table public.documents is
  'Un document logique (un reçu de 3 pages = 1 document). sent_at null = envoi en cours (brouillon). from_firm = document finalisé déposé par la teneuse de livres.';

create table public.document_pages (
  document_id  uuid not null references public.documents (id) on delete cascade,
  page_number  smallint not null check (page_number >= 1),
  storage_path text not null unique,
  mime_type    text not null,
  size_bytes   integer not null check (size_bytes > 0),
  primary key (document_id, page_number)
);
comment on column public.document_pages.storage_path is 'Chemin dans le compartiment « documents » : {client_id}/{document_id}/{page}.{ext}';

create table public.document_views (
  document_id     uuid not null references public.documents (id) on delete cascade,
  user_id         uuid not null references auth.users (id) on delete cascade default auth.uid(),
  first_opened_at timestamptz not null default now(),
  primary key (document_id, user_id)
);
comment on table public.document_views is 'Sert à l''indication « ouvert par le client » des documents finalisés.';

-- -----------------------------------------------------------------------------
-- Questions et demandes de documents
-- -----------------------------------------------------------------------------
create table public.questions (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references public.clients (id) on delete cascade,
  transaction_on date,
  amount_cents   integer,
  merchant       text,
  prompt         text not null check (length(trim(prompt)) > 0),
  due_on         date,
  created_by     uuid references auth.users (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz
);
create index questions_client_idx on public.questions (client_id, created_at desc);

create table public.question_answers (
  question_id uuid primary key references public.questions (id) on delete cascade,
  kind        public.answer_kind not null,
  body        text,
  document_id uuid unique references public.documents (id),
  answered_by uuid references auth.users (id) on delete set null default auth.uid(),
  answered_at timestamptz not null default now(),
  check (kind <> 'text' or length(trim(body)) > 0),
  check ((kind = 'receipt') = (document_id is not null))
);
comment on table public.question_answers is 'Réponse du client : texte, « personnel » ou photo du reçu (document).';

create table public.document_requests (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references public.clients (id) on delete cascade,
  document_type_code text not null references public.document_types (code),
  title              text not null,
  details            text,
  due_on             date,
  created_by         uuid references auth.users (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  processed_at       timestamptz,
  canceled_at        timestamptz,
  check (processed_at is null or canceled_at is null)
);
create index document_requests_client_idx on public.document_requests (client_id, created_at desc);
comment on column public.document_requests.created_by is 'Null : demande créée automatiquement (fiche de départ, demande récurrente).';

create table public.request_documents (
  document_id uuid primary key references public.documents (id) on delete cascade,
  request_id  uuid not null references public.document_requests (id) on delete cascade
);
create index request_documents_request_idx on public.request_documents (request_id);
comment on table public.request_documents is 'Documents déposés dans une demande. Un document répond à une seule demande.';

-- -----------------------------------------------------------------------------
-- Messages
-- -----------------------------------------------------------------------------
create table public.messages (
  id        uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  author_id uuid references auth.users (id) on delete set null default auth.uid(),
  body      text not null check (length(trim(body)) between 1 and 5000),
  sent_at   timestamptz not null default now()
);
create index messages_client_idx on public.messages (client_id, sent_at desc);
comment on table public.messages is 'Sans lien dans question_messages ni request_messages : le message est dans le fil général.';

create table public.question_messages (
  message_id  uuid primary key references public.messages (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade
);
create index question_messages_question_idx on public.question_messages (question_id);

create table public.request_messages (
  message_id uuid primary key references public.messages (id) on delete cascade,
  request_id uuid not null references public.document_requests (id) on delete cascade
);
create index request_messages_request_idx on public.request_messages (request_id);

create table public.message_reads (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade default auth.uid(),
  read_at    timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index message_reads_user_idx on public.message_reads (user_id);

-- -----------------------------------------------------------------------------
-- Notifications et relances
-- -----------------------------------------------------------------------------
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  kind       text not null,
  title      text not null,
  body       text not null,   -- discret : jamais de montant ni de fournisseur
  link_path  text,            -- écran à ouvrir dans l'application, ex. /questions/{id}
  created_at timestamptz not null default now(),
  read_at    timestamptz
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.push_devices (
  token         text primary key,
  user_id       uuid not null references auth.users (id) on delete cascade default auth.uid(),
  platform      public.device_platform not null,
  registered_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index push_devices_user_idx on public.push_devices (user_id);

create table public.reminders (
  id        uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients (id) on delete cascade,
  reason    public.reminder_reason not null,
  sent_at   timestamptz not null default now()
);
-- Un seul rappel par client et par jour (heure de Montréal)
create unique index reminders_one_per_day
  on public.reminders (client_id, ((timezone('America/Toronto', sent_at))::date));
comment on table public.reminders is 'Chaque rappel envoyé. Le nombre de relances par élément et le signal « à appeler » sont dérivés.';

create table public.reminder_questions (
  reminder_id uuid not null references public.reminders (id) on delete cascade,
  question_id uuid not null references public.questions (id) on delete cascade,
  primary key (reminder_id, question_id)
);
create index reminder_questions_question_idx on public.reminder_questions (question_id);

create table public.reminder_requests (
  reminder_id uuid not null references public.reminders (id) on delete cascade,
  request_id  uuid not null references public.document_requests (id) on delete cascade,
  primary key (reminder_id, request_id)
);
create index reminder_requests_request_idx on public.reminder_requests (request_id);

create table public.client_settings (
  client_id                 uuid primary key references public.clients (id) on delete cascade,
  reminders_suspended_since timestamptz
);
comment on table public.client_settings is 'Réglages de la firme pour un client (relances suspendues). Séparé de clients : écrit par d''autres personnes.';

-- -----------------------------------------------------------------------------
-- Journal des accès (Loi 25)
-- -----------------------------------------------------------------------------
create table public.access_log (
  id           bigint generated always as identity primary key,
  user_id      uuid,      -- pas de clé étrangère : le journal survit à la suppression du compte
  client_id    uuid,
  action       text not null,
  object_table text,
  object_id    uuid,
  occurred_at  timestamptz not null default now()
);
create index access_log_client_idx on public.access_log (client_id, occurred_at desc);
