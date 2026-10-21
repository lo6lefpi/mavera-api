import test from 'node:test';
import assert from 'node:assert/strict';
import type { CheckoutStatusResponse } from '../../_shared/services/checkout-status.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(proof: T) => assert.equal(proof, true);

test('contrat TypeScript : une variante par statut, montant actif non nullable et inactif null', () => {
  type Confirmed = Extract<CheckoutStatusResponse, { status: 'confirmed' }>;
  type Verifying = Extract<CheckoutStatusResponse, { status: 'verifying' }>;
  type Processing = Extract<CheckoutStatusResponse, { status: 'processing' }>;
  // Ces assertions échouent à la compilation si les variantes sont regroupées,
  // si un montant actif devient nullable ou si les deux peuvent être remplis.
  assertType<Equal<Confirmed['summary']['paidTodayCents'], number>>(true);
  assertType<Equal<Confirmed['summary']['pendingTodayCents'], null>>(true);
  assertType<Equal<Verifying['summary']['paidTodayCents'], number>>(true);
  assertType<Equal<Verifying['summary']['pendingTodayCents'], null>>(true);
  assertType<Equal<Processing['summary']['paidTodayCents'], null>>(true);
  assertType<Equal<Processing['summary']['pendingTodayCents'], number>>(true);
});
