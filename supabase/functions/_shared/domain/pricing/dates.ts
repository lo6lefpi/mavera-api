import { invalid } from "./errors.ts";

/**
 * Date de calendrier « AAAA-MM-JJ », sans heure ni fuseau.
 * L'appelant fournit la date du jour à Montréal; le domaine ne lit jamais
 * l'horloge, ce qui le rend testable.
 */
export type IsoDate = string;

interface Ymd {
  y: number;
  m: number; // 1 à 12
  d: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

function parse(date: IsoDate): Ymd {
  const match = ISO.exec(date);
  if (!match) throw invalid(`Date invalide : ${date} (format AAAA-MM-JJ attendu)`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) {
    throw invalid(`Date invalide : ${date}`);
  }
  return { y, m, d };
}

function format({ y, m, d }: Ymd): IsoDate {
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function toDayNumber({ y, m, d }: Ymd): number {
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function assertIsoDate(date: IsoDate): void {
  parse(date);
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { y, m } = parse(date);
  return format({ y, m, d: 1 });
}

/** Ajoute des mois à une date qui tombe le 1er du mois. */
export function addMonths(firstOfMonth: IsoDate, months: number): IsoDate {
  const { y, m, d } = parse(firstOfMonth);
  if (d !== 1) throw invalid(`addMonths attend le 1er du mois : ${firstOfMonth}`);
  const index = y * 12 + (m - 1) + months;
  return format({ y: Math.floor(index / 12), m: (index % 12) + 1, d: 1 });
}

export function firstOfNextMonth(date: IsoDate): IsoDate {
  return addMonths(startOfMonth(date), 1);
}

/** Nombre de jours de `from` (inclus) à `to` (exclu). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(parse(to)) - toDayNumber(parse(from));
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return daysBetween(b, a);
}
