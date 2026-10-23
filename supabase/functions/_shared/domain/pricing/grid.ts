import type { Cents } from "./money.ts";

/**
 * Grille de prix en vigueur. C'est la SEULE source des prix de l'entreprise :
 * le site, l'application et la base ne recopient jamais ces montants.
 *
 * Quand la grille change : créer une nouvelle version (GRID_VERSION) et de
 * nouveaux prix Stripe. Les clients déjà inscrits gardent leurs conditions
 * accordées, enregistrées dans la base au moment de leur acceptation.
 *
 * Tous les montants sont en cents, avant taxes.
 */
export const GRID_VERSION = "2026-10-21";

export type PlanCode = "trajet" | "depart" | "elan" | "envol" | "sur_mesure";
export type StandardPlanCode = Exclude<PlanCode, "sur_mesure">;

/** Mêmes valeurs que l'enum public.billing_option. */
export type BillingOption = "monthly" | "monthly_commitment" | "annual";

/** Mêmes valeurs que l'enum public.filing_frequency. */
export type FilingFrequency = "monthly" | "quarterly" | "annual";

export interface PlanPricing {
  readonly code: StandardPlanCode;
  readonly name: string;
  /** Rang pour savoir si un changement est une hausse ou une baisse. */
  readonly rank: number;
  readonly monthlyCents: Cents;
  /** 12 mois pour le prix de 10; null si le paiement annuel n'est pas offert. */
  readonly annualCents: Cents | null;
  readonly includedTransactions: number;
  /** Comptes bancaires ou cartes inclus. */
  readonly includedAccounts: number;
  /** Fréquence de TPS/TVQ la plus élevée incluse dans le forfait. */
  readonly includedFilingFrequency: FilingFrequency;
  readonly openingFee: {
    /** Mensuel sans engagement. */
    readonly fullCents: Cents;
    /** Engagement de 12 mois ou annuel (moitié prix); null si non offert. */
    readonly reducedCents: Cents | null;
  };
  readonly billingOptions: readonly BillingOption[];
  /** QuickBooks Ledger fourni par la firme (sinon, le client paie son QuickBooks). */
  readonly quickbooksIncluded: boolean;
  /** Proposé par le simulateur du site. Trajet passe par la page Chauffeurs. */
  readonly suggestedBySimulator: boolean;
}

const ALL_OPTIONS: readonly BillingOption[] = ["monthly", "monthly_commitment", "annual"];

export const PLANS: Readonly<Record<StandardPlanCode, PlanPricing>> = {
  // Trajet : au mois seulement, sans engagement ni paiement annuel (21 oct. 2026).
  trajet: {
    code: "trajet",
    name: "Trajet",
    rank: 1,
    monthlyCents: 5900,
    annualCents: null,
    includedTransactions: 20,
    includedAccounts: 2,
    includedFilingFrequency: "annual",
    openingFee: { fullCents: 5900, reducedCents: null },
    billingOptions: ["monthly"],
    quickbooksIncluded: true,
    suggestedBySimulator: false,
  },
  depart: {
    code: "depart",
    name: "Départ",
    rank: 2,
    monthlyCents: 7900,
    annualCents: 79000,
    includedTransactions: 20,
    includedAccounts: 2,
    includedFilingFrequency: "annual",
    openingFee: { fullCents: 9900, reducedCents: 4900 },
    billingOptions: ALL_OPTIONS,
    quickbooksIncluded: true,
    suggestedBySimulator: true,
  },
  elan: {
    code: "elan",
    name: "Élan",
    rank: 3,
    monthlyCents: 14900,
    annualCents: 149000,
    includedTransactions: 50,
    includedAccounts: 3,
    includedFilingFrequency: "quarterly",
    openingFee: { fullCents: 14900, reducedCents: 7500 },
    billingOptions: ALL_OPTIONS,
    quickbooksIncluded: false,
    suggestedBySimulator: true,
  },
  envol: {
    code: "envol",
    name: "Envol",
    rank: 4,
    monthlyCents: 24900,
    annualCents: 249000,
    includedTransactions: 100,
    includedAccounts: 5,
    includedFilingFrequency: "quarterly",
    openingFee: { fullCents: 19900, reducedCents: 9900 },
    billingOptions: ALL_OPTIONS,
    quickbooksIncluded: false,
    suggestedBySimulator: true,
  },
};

/** Mois facturés pour un paiement annuel (deux mois gratuits). */
export const ANNUAL_MONTHS_CHARGED = 10;

/** Durée de l'engagement, en mois (mensuel avec engagement ou annuel). */
export const COMMITMENT_MONTHS = 12;

/** Chaque transaction au-delà du forfait, pour tous les forfaits. */
export const EXTRA_TRANSACTION_CENTS: Cents = 450;

/** Compte bancaire ou carte au-delà des comptes inclus, par mois. */
export const EXTRA_ACCOUNT_MONTHLY_CENTS: Cents = 1500;

/** Déclaration de TPS/TVQ au-delà de la fréquence incluse dans le forfait. */
export const EXTRA_FILING_CENTS: Cents = 2500;

/** Déclaration de TPS/TVQ seule, chiffres prêts, pour une personne sans forfait. */
export const STANDALONE_FILING_CENTS: Cents = 7500;

/**
 * « Mise à jour de vos livres » : tarif minimum de 120 $ (20 premières
 * transactions incluses), puis 6 $ par transaction. Le travail à l'heure
 * (corrections, documents manquants) passe par COACHING.
 */
export const BOOKS_UPDATE = {
  minimumCents: 12000,
  transactionsInMinimum: 20,
  perTransactionCents: 600,
  overdueFilingCents: 7500,
  maxInstallments: 3,
} as const;

/**
 * « Accompagnement hors forfait » : le seul tarif à l'heure (décision du
 * 20 octobre 2026). 60 $/h, facturé par demi-heure entamée. Couvre aussi la
 * correction de livres mal tenus et la recherche de documents manquants.
 */
export const COACHING = {
  hourlyCents: 6000,
  incrementMinutes: 30,
} as const;

/** Au-delà, le simulateur suggère Sur mesure. */
export const SIMULATOR_MAX_TRANSACTIONS = 150;

/** Le compteur avertit le client à partir de ce pourcentage du quota. */
export const COUNTER_WARNING_PERCENT = 80;

export function isStandardPlan(code: string): code is StandardPlanCode {
  return Object.hasOwn(PLANS, code);
}

export function isBillingOption(value: string): value is BillingOption {
  return (ALL_OPTIONS as readonly string[]).includes(value);
}

export function isFilingFrequency(value: string): value is FilingFrequency {
  return value === "monthly" || value === "quarterly" || value === "annual";
}
