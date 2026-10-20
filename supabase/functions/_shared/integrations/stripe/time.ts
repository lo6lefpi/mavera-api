/**
 * Heures et fenêtres de paiement, sans appel à Stripe (testable hors ligne).
 *
 * Les prélèvements tombent le 1er du mois à 00:00, heure de Montréal
 * (America/Toronto, heure d'été comprise). Une session de paiement doit donc
 * être terminée avant cette heure : sinon le mois payé ne correspond plus au
 * mois en cours.
 */
import { BillingTerminalError, type IsoDate } from '../../services/ports.ts';

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 00:00 à Montréal pour une date, en secondes Unix. */
export function torontoMidnight(date: IsoDate): number {
  const match = ISO.exec(date);
  if (!match) throw new Error(`Date ISO invalide : ${date}`);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const utc = Date.UTC(year, month - 1, day);
  if (new Date(utc).toISOString().slice(0, 10) !== date) throw new Error(`Date impossible : ${date}`);
  // Le décalage est celui en vigueur à minuit heure locale : on le lit une première fois,
  // puis on le relit à l'instant obtenu (utile les jours de changement d'heure).
  const first = utc - offsetMinutes(utc) * 60_000;
  return Math.floor((utc - offsetMinutes(first) * 60_000) / 1000);
}

/** Décalage de Montréal par rapport à UTC, en minutes (ex. −240 en été). */
function offsetMinutes(instant: number): number {
  const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Toronto', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(instant)).find(part => part.type === 'timeZoneName')?.value ?? '';
  const offset = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone);
  if (!offset) throw new Error(`Décalage horaire inconnu : ${zone}`);
  return (offset[1] === '+' ? 1 : -1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0));
}

/** Ajoute un cycle (mois ou année) à une date qui tombe le 1er du mois. */
export function nextAnchor(anchorOn: IsoDate, cycle: 'month' | 'year'): IsoDate {
  const match = ISO.exec(anchorOn);
  if (!match || match[3] !== '01') throw new Error(`L'ancrage doit tomber le 1er du mois : ${anchorOn}`);
  const index = Number(match[1]) * 12 + Number(match[2]) - 1 + (cycle === 'year' ? 12 : 1);
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}-01`;
}

/** Limites de Stripe pour expires_at : entre 30 minutes et 24 heures après la création. */
const STRIPE_MIN_SECONDS = 30 * 60;
const STRIPE_MAX_SECONDS = 24 * 3600;
/** Marges : délai de traitement du webhook avant l'ancrage, et horloges légèrement décalées. */
export const ANCHOR_MARGIN_SECONDS = 15 * 60;
const CLOCK_MARGIN_SECONDS = 2 * 60;

/**
 * Heure d'expiration de la session de paiement : au plus tard 15 minutes
 * avant l'ancrage. Si la fenêtre restante est trop courte pour Stripe (dernière
 * demi-heure du mois), l'inscription est refusée : le client réessaie après
 * minuit, avec un récapitulatif recalculé.
 */
export function checkoutExpiresAt(payBefore: IsoDate, nowSeconds: number): number {
  const latest = torontoMidnight(payBefore) - ANCHOR_MARGIN_SECONDS;
  const expiresAt = Math.min(nowSeconds + STRIPE_MAX_SECONDS - CLOCK_MARGIN_SECONDS, latest);
  if (expiresAt < nowSeconds + STRIPE_MIN_SECONDS + CLOCK_MARGIN_SECONDS) {
    throw new BillingTerminalError('checkout_window_closed');
  }
  return expiresAt;
}
