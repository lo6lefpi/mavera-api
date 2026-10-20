import { invalid } from "./errors.ts";

/**
 * Montant en cents entiers, avant taxes. Jamais de nombre à virgule :
 * 4,50 $ s'écrit 450.
 */
export type Cents = number;

export function assertCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw invalid(`${label} doit être un nombre entier de cents`);
  }
}

export function assertCount(value: number, label: string, min = 0): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw invalid(`${label} doit être un entier d'au moins ${min}`);
  }
}

/** Multiplie puis divise sans passer par un nombre à virgule non arrondi. */
export function prorate(amount: Cents, numerator: number, denominator: number): Cents {
  assertCents(amount, "amount");
  assertCount(numerator, "numerator");
  assertCount(denominator, "denominator", 1);
  // Arrondi au cent le plus proche, la moitié vers le haut (en valeur absolue).
  const sign = amount < 0 ? -1 : 1;
  const raw = Math.abs(amount) * numerator;
  return sign * Math.floor((raw * 2 + denominator) / (denominator * 2));
}

const NBSP = " ";

/**
 * Format québécois : « 79 $ », « 13,50 $ », « 1 490 $ ».
 * Espaces insécables pour les milliers et avant le symbole.
 */
export function formatCad(amount: Cents): string {
  assertCents(amount, "amount");
  const sign = amount < 0 ? "−" : "";
  const abs = Math.abs(amount);
  const dollars = Math.floor(abs / 100);
  const cents = abs % 100;
  const grouped = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const decimals = cents === 0 ? "" : "," + String(cents).padStart(2, "0");
  return `${sign}${grouped}${decimals}${NBSP}$`;
}
