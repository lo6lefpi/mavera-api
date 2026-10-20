import { assertEquals, assertThrows } from "./assert.ts";
import { earlyTerminationFee, grantTerms, PricingError } from "../../../_shared/domain/pricing/mod.ts";

const engage = {
  billingOption: "monthly_commitment" as const,
  startsOn: "2026-10-01",
  openingDiscountCents: grantTerms("depart", "monthly_commitment").openingDiscountCents,
};

Deno.test("départ anticipé : le client qui annule paie le rabais d'ouverture", () => {
  const fee = earlyTerminationFee(engage, "2027-03-15", "client_request");
  assertEquals(fee, { feeCents: 5000, commitmentEndsOn: "2027-10-01", reason: "early_cancellation" });
});

Deno.test("départ anticipé : rien à payer après 12 mois", () => {
  assertEquals(earlyTerminationFee(engage, "2027-10-01", "client_request").feeCents, 0);
});

Deno.test("départ anticipé : rien à payer sans engagement", () => {
  const sans = { ...engage, billingOption: "monthly" as const, openingDiscountCents: 0 };
  assertEquals(earlyTerminationFee(sans, "2026-12-01", "client_request").reason, "no_commitment");
});

Deno.test("départ anticipé : fermeture faute de réponse ou après un refus, sans frais", () => {
  for (const reason of ["no_response", "declined_proposal", "refund_before_call"]) {
    assertEquals(earlyTerminationFee(engage, "2027-01-15", reason).feeCents, 0, reason);
  }
});

Deno.test("départ anticipé : motif inconnu refusé", () => {
  assertEquals(assertThrows(() => earlyTerminationFee(engage, "2027-01-15", "fâché"), PricingError).code, "invalid_input");
});
