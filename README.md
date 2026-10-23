# mavera-api

## Paiements : test de bout en bout (bac à sable Stripe)

Jamais de clé de production : les scripts refusent toute clé qui ne commence pas par `sk_test_`.

1. Copier `supabase/functions/.env.example` en `supabase/functions/.env` et remplir
   `STRIPE_SECRET_KEY` (bac à sable), `PUBLIC_SITE_ORIGIN`, et `CAPTCHA_DISABLED=true` en local.
2. Créer les prix d'abonnement et les taux de TPS et de TVQ (une seule fois par grille; sans danger à relancer) :
   `deno run --allow-env --allow-net --env-file=supabase/functions/.env scripts/stripe-sandbox-setup.ts`
3. Trois terminaux :
   - `supabase start` puis `supabase functions serve`
   - `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`
     (copier le `whsec_…` affiché dans `STRIPE_WEBHOOK_SECRET`, puis relancer `functions serve`)
   - `deno run -A --env-file=supabase/functions/.env scripts/e2e-checkout.ts depart monthly current`
4. Payer sur la page affichée avec la carte `4242 4242 4242 4242`. Le script vérifie Stripe,
   la base, puis rejoue l'événement pour confirmer qu'aucun deuxième dossier n'est créé.

### Parcours supplémentaires

Les mêmes prérequis s'appliquent : Supabase local avec toutes les migrations, fonctions
servies, prix/taxes du bac à sable créés et `stripe listen` actif pour tous les événements.
Le script refuse les clés de production et les URL Supabase distantes.

```sh
# Débit bancaire : succès différé, puis refus différé (deux pages à remplir).
deno run -A --env-file=supabase/functions/.env scripts/e2e-checkout.ts depart monthly current acss

# Refus d'inscription après un paiement par carte réussi.
deno run -A --env-file=supabase/functions/.env scripts/e2e-checkout.ts depart monthly current rejected
```

Le quatrième argument accepte aussi `acss-success` ou `acss-failure` pour lancer un seul
résultat bancaire, et `card` (défaut) pour le parcours initial. Chaque nouveau scénario
utilise un courriel unique pour éviter les dossiers et tentatives des passages précédents.

**Débit préautorisé ACSS :** le parcours public reste limité à la carte. Le montage E2E
appelle `/quote`, enregistre le récapitulatif dans une tentative locale via le dépôt réel,
puis crée une session Checkout sandbox explicitement limitée à `acss_debit`. Il teste
donc le paiement ACSS et le webhook réels, sans prétendre valider l'activation ACSS dans
`/checkout`. Le script ne crée plus de configuration de moyens de paiement et ne modifie
pas les réglages du compte Stripe. La devise CAD est définie sur la session et ses lignes ;
`payment_method_options.acss_debit.currency`, réservé au mode `setup`, n'est pas envoyé.

Dans la page de paiement, choisir le débit bancaire et la saisie manuelle :

| Résultat | Institution | Transit | Compte |
|---|---|---|---|
| Succès après environ trois minutes | `000` | `11000` | `900123456789` |
| Refus après environ trois minutes | `000` | `11000` | `900222222227` |

Vérifier les microdépôts avec **32 et 45 cents**. Le script affiche le lien de vérification
Stripe lorsqu'il est disponible. Le délai bancaire démarre après cette vérification.
Ces valeurs viennent de la [documentation Stripe ACSS](https://docs.stripe.com/payments/acss-debit/accept-a-payment?payment-ui=checkout).

Le script exige d'avoir réellement observé `processing` avec aucun dossier en base et
aucun abonnement chez Stripe, même annulé. Il rejoue `checkout.session.completed`
pendant cette attente. Un paiement immédiat, un paiement par carte, une erreur de lecture
ou un dépassement du délai font échouer le test. Au succès, seul le webhook crée le
dossier, puis les vérifications initiales (montants, taxes, abonnement, dossier, invitation,
idempotence) s'appliquent. Au refus bancaire, le paiement doit rester non encaissé et
aucun dossier, abonnement ou remboursement ne doit être créé, même après rejeu des événements.

**Inscription refusée après paiement :** le script abandonne intentionnellement la
tentative locale avant d'afficher sa page de paiement. Cela reproduit un paiement tardif
sur une tentative abandonnée. Payer avec `4242 4242 4242 4242`. Le vrai webhook doit
enregistrer le paiement, obtenir de Stripe un remboursement complet `pending` ou `succeeded`,
puis enregistrer le refus. Le script vérifie les montants et le lien avec le PaymentIntent,
l'absence de dossier et de tout abonnement, puis rejoue l'événement : toujours un seul remboursement.

Les ressources de test restent disponibles pour inspection. Le script ne fabrique aucun
événement de confirmation : ses rejeux utilisent les événements réellement émis par Stripe.
Les parcours interactifs ont un délai de quinze minutes par phase d'attente.
La préparation ACSS affiche chaque étape (récapitulatif, taxes,
tentative, session, liaison en base) avec sa durée. Les appels réseau du script ont un
délai maximal de 30 secondes, sans relance réseau automatique Stripe ; une erreur
indique l'étape concernée. Cette limite ne modifie pas les reprises des fonctions serveur.

## Retour de paiement : contrat pour le site

`POST /functions/v1/public-api/checkout-status`, depuis une origine autorisée, avec
`Content-Type: application/json` et le corps `{ "sessionId": "cs_test_..." }`.
URL complète : `${SUPABASE_URL}/functions/v1/public-api/checkout-status` ; en local,
`http://127.0.0.1:54321/functions/v1/public-api/checkout-status`. Pour le distant,
utiliser l'URL Supabase configurée pour le même environnement que la création du paiement.
Le dépôt n'indique actuellement aucun projet Supabase distant lié.

Aucune clé, aucun `Authorization`, aucun `apikey`, aucune session utilisateur et aucun
CAPTCHA à fournir pour cette consultation (`verify_jwt = false`). Le navigateur envoie
l'en-tête `Origin`, qui doit correspondre à une origine autorisée côté serveur.

Lors d'une nouvelle création de session, le serveur ajoute automatiquement
`session_id={CHECKOUT_SESSION_ID}` au `successUrl` transmis à Stripe. Il remplace toute
ancienne valeur de `session_id` et conserve les autres paramètres et le fragment.
Exemple : `https://site/merci?lang=fr&session_id={CHECKOUT_SESSION_ID}#confirmation`.
Stripe remplace ce marqueur par l'identifiant réel. Le site lit **`session_id`** dans
l'adresse de retour et l'envoie sous le nom **`sessionId`** dans le corps JSON.
Le site peut donc continuer à envoyer un `successUrl` simple, sans marqueur.
Les sessions déjà créées conservent leur ancienne adresse de retour ; utiliser une
nouvelle tentative pour tester cet ajout. Ce retour ne prouve jamais le paiement.

Les réponses métier sont HTTP `200`, sans enveloppe supplémentaire :

```ts
type SummaryBase = {
  planCode: 'trajet' | 'depart' | 'elan' | 'envol';
  billingOption: 'monthly' | 'monthly_commitment' | 'annual';
  currency: 'cad';
  nextCharge: {
    amountCents: number;
    on: string; // AAAA-MM-JJ
  };
};

type PaidSummary = SummaryBase & {
  paidTodayCents: number;
  pendingTodayCents: null;
};

type PendingSummary = SummaryBase & {
  paidTodayCents: null;
  pendingTodayCents: number;
};

type CheckoutStatusResponse =
  | { status: 'unknown' }
  | { status: 'confirmed'; summary: PaidSummary }
  | { status: 'verifying'; summary: PaidSummary }
  | { status: 'processing'; summary: PendingSummary }
  | {
      status: 'rejected';
      refund:
        | {
            status: 'succeeded' | 'pending';
            currency: 'cad';
            amountCents: number;
          }
        | { status: 'contact_required' };
    };
```

**Un seul de `paidTodayCents` et `pendingTodayCents` contient un montant à la fois ;
l'autre vaut toujours `null`.** Pour `processing`, seul `pendingTodayCents` est rempli.
Pour `confirmed` et `verifying`, seul `paidTodayCents` est rempli.

**Tous les montants sont en cents canadiens, taxes comprises : TPS et TVQ incluses.**
Le montant du jour est copié de `quote.dueToday.totalCents`, le prochain montant de
`quote.recurring.totalCents`, et sa date de `quote.recurring.nextChargeOn`, dans la
tentative enregistrée. Aucun nouveau calcul, même si la grille a changé. La date est
celle prévue au récapitulatif initial, sans recalcul en cas de traitement tardif.
Le montant du remboursement vient du remboursement enregistré ; il est absent pour
`contact_required`. Aucun récapitulatif ni prélèvement futur n'est retourné pour un refus.

| État | Affichage du site |
|---|---|
| `confirmed` | Paiement reçu et dossier créé, dont l'existence a été vérifiée en base. |
| `processing` | Paiement bancaire en attente de confirmation ; afficher le montant en attente, jamais comme payé. |
| `verifying` | Paiement reçu, vérification de l'inscription en cours ; ne pas annoncer de dossier créé. |
| `rejected` | Inscription non aboutie ; afficher le remboursement selon le statut ci-dessous et conserver le lien pour nous écrire. |
| `unknown` | Affichage neutre identique pour identifiant inconnu, session expirée, ouverte, jamais payée ou paiement échoué. Aucun montant. |

| `refund.status` | Texte à rédiger par le site |
|---|---|
| `succeeded` | Remboursement effectué ; montant affiché ; quelques jours ouvrables possibles avant son apparition sur le relevé. |
| `pending` | Remboursement en cours ; montant affiché ; quelques jours ouvrables possibles avant son apparition sur le relevé. |
| `contact_required` | Nous allons communiquer avec vous pour finaliser le remboursement ; aucun montant affiché. Correspond à `failed`, `canceled` ou `requires_action` chez Stripe. |

La réponse métier ne contient aucun `message` : le site rédige ses textes selon les
statuts. Elle ne contient jamais de coordonnées, nom, motif du refus, identifiants
internes ou Stripe. Le serveur relit le remboursement chez Stripe sans le modifier.

Interroger toutes les cinq secondes au maximum, pendant deux minutes au plus, pour
`processing` ou `verifying`, puis afficher une attente sans annoncer de confirmation.
Une banque peut prendre plus longtemps : un délai de consultation dépassé n'est pas un refus.
Arrêter l'interrogation pour les autres états.

Protections : origine obligatoire autorisée, corps limité à 16 Kio, `sessionId` de
255 caractères maximum avec préfixe `cs_` et uniquement lettres ASCII, chiffres et
underscores. Limites indépendantes du paiement : 60 appels/IP/minute avant lecture
du corps, puis 20 appels/couple IP-session/minute. Aucun CAPTCHA supplémentaire.
Toutes les réponses JSON portent `Cache-Control: no-store`.

Les erreurs reprennent `{ error: { code, message } }` de public-api : `400 invalid_request`,
`403 origin_refused`, `405 method_not_allowed`, `413 body_too_large`,
`429 too_many_requests` avec `Retry-After: 60`, et `503 unavailable` en cas de panne.
Les réponses CORS exposent `Retry-After` avec `Access-Control-Expose-Headers: Retry-After`
pour permettre au site de lire le délai avant de relancer.
Une panne n'est jamais transformée en confirmation ou en réponse neutre.

La consultation ne crée ni ne modifie aucun dossier, paiement, abonnement ou remboursement.
Seul le compteur technique de fréquence est mis à jour. Le webhook reste seul responsable
de la création du dossier. Déployer la migration `20261021000100_checkout_status.sql`
avant la fonction `public-api` ; aucune configuration supplémentaire n'est requise.

### Trajet : grille 2026-10-21 et contrat du site

`domain/pricing` reste la seule source des montants. Trajet comprend 20 transactions,
2 comptes, la TPS/TVQ annuelle et QuickBooks Ledger fourni par la firme, à 59 $/mois
avec 59 $ d'ouverture, avant taxes, sans engagement ni paiement annuel. Départ,
Élan et Envol conservent leurs prix et inclusions. Chaque transaction au-delà des
20 incluses coûte 4,50 $ et ne change pas l'admissibilité.

Pour `POST /quote` et `POST /checkout`, envoyer les trois réponses suivantes :

```json
{
  "planCode": "trajet",
  "billingOption": "monthly",
  "startMonth": "current",
  "estimatedTransactions": 23,
  "trajetProfile": {
    "platformIncomeOnly": true,
    "accounts": 2,
    "issuesClientInvoices": false
  }
}
```

`/checkout` exige aussi les coordonnées, l'identifiant de tentative, les choix
du dossier, les URL de retour et le CAPTCHA habituels. `monthlyTransactions`
ne fait plus partie de `trajetProfile`; l'estimation reste dans
`estimatedTransactions`. Les réponses aux trois critères sont obligatoires :
revenus de plateformes seulement, au plus deux comptes (banque ou carte), aucune
facture à ses propres clients. Un refus reste HTTP `422`, sous la forme
`{ error: { code: "trajet_not_eligible", message, details } }`, où `details`
contient uniquement `other_income`, `too_many_accounts` ou `client_invoices`.
`too_many_transactions` n'est plus renvoyé. L'absence ou le mauvais type d'une
réponse produit HTTP `400 invalid_request`. Une admissibilité acceptée donne le
récapitulatif habituel sous `{ quote }`, et `/checkout` ajoute les informations
de la session de paiement.

Pour Trajet, le mois en cours coûte 135,68 $ à l'inscription (ouverture et
premier mois, taxes comprises); le prélèvement mensuel est de 67,84 $. Un départ
le mois suivant facture seulement 67,84 $ d'ouverture aujourd'hui. Les
transactions supplémentaires sont facturées séparément, selon le volume réel.
Le site affiche les montants du récapitulatif de l'API, sans les recopier.

Appliquer la migration `20261021000200_pricing_grid_versions.sql` avant les
fonctions. Elle accepte les versions `AAAA-MM` et `AAAA-MM-JJ`, sans modifier
les conditions accordées. Relancer ensuite `scripts/stripe-sandbox-setup.ts`
dans le bac à sable : il crée les 7 clés de la nouvelle grille, dont
`trajet_monthly_2026_10_21`, et conserve les anciens prix. Les clients déjà
inscrits et les récapitulatifs déjà enregistrés gardent leurs prix, quotas,
frais d'ouverture et clés Stripe accordés.

### Tests

```sh
deno test --allow-read --allow-env=STRIPE_WEBHOOK_SECRET,STRIPE_SECRET_KEY supabase/functions/tests
supabase test db
```

Les tests SQL s'exécutent sur une base locale de test avec toutes les migrations appliquées.
