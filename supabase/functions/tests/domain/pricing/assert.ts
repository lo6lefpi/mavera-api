/**
 * Petites assertions sans dépendance réseau (pas de jsr:@std/assert à
 * télécharger), pour garder les tests du domaine exécutables hors ligne.
 */
import { deepStrictEqual } from "node:assert/strict";

export function assertEquals<T>(actual: T, expected: T, message?: string): void {
  deepStrictEqual(actual, expected, message);
}

// deno-lint-ignore no-explicit-any
type ErrorClass<E extends Error> = new (...args: any[]) => E;

export function assertThrows<E extends Error>(
  fn: () => unknown,
  errorClass: ErrorClass<E>,
  includes?: string,
): E {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof errorClass)) {
      throw new Error(`Erreur de type inattendu : ${String(error)}`);
    }
    if (includes && !error.message.includes(includes)) {
      throw new Error(`Message « ${error.message} » sans « ${includes} »`);
    }
    return error;
  }
  throw new Error("Une erreur était attendue");
}
