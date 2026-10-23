-- Récapitulatif d'inscription : TPS et TVQ vérifiées par la base.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

create temp table q (v jsonb) on commit drop;
insert into q values ('{"terms":{"gridVersion":"2026-10-21","planCode":"elan","billingOption":"monthly_commitment","cycle":"month","recurringPriceCents":14900,"includedTransactions":50,"extraTransactionCents":450,"includedAccounts":3,"extraAccountCents":1500,"includedFilingFrequency":"quarterly","extraFilingCents":2500,"quickbooksIncluded":false,"openingFeeCents":7500,"openingDiscountCents":7400,"stripeRecurringLookupKey":"elan_monthly_2026_10_21"},"startsOn":"2026-10-01","dueToday":{"lines":[{"kind":"opening_fee","amountCents":7500,"gstCents":375,"qstCents":748},{"kind":"first_period","amountCents":14900,"gstCents":745,"qstCents":1486}],"subtotalCents":22400,"gstCents":1120,"qstCents":2234,"totalCents":25754},"recurring":{"amountCents":14900,"gstCents":745,"qstCents":1486,"totalCents":17131,"cycle":"month","nextChargeOn":"2026-11-01"},"commitmentEndsOn":"2027-10-01","extraTransactionCents":450,"currentMonthBooksUpdate":null,"taxRegion":"QC"}');

select ok(private.is_valid_checkout_quote((select v from q)), 'Récapitulatif taxé du domaine : valide');
select is((select (v #>> '{dueToday,totalCents}')::integer from q), 25754, 'Élan avec engagement : 224 $ + TPS 11,20 $ + TVQ 22,34 $');
select ok(not private.is_valid_checkout_quote((select v - 'taxRegion' from q)), 'Région de taxes absente : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{dueToday,lines,0,gstCents}', '376') from q)), 'TPS d''une ligne fausse d''un cent : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{dueToday,lines,1,qstCents}', '1487') from q)), 'TVQ d''une ligne fausse : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{dueToday,totalCents}', '22400') from q)), 'Total sans taxes : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{recurring,totalCents}', '14900') from q)), 'Prélèvement sans taxes : invalide');
select ok(not private.is_valid_checkout_quote((select jsonb_set(v, '{dueToday,gstCents}', '0') from q)), 'Somme de la TPS incohérente : invalide');

select * from finish();
rollback;
