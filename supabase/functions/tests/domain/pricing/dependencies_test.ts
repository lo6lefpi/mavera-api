import { assertEquals } from "./assert.ts";

/**
 * Règle d'architecture : le domaine ne dépend de rien (ni Supabase, ni Stripe,
 * ni réseau, ni horloge). Seuls les imports relatifs vers domain/ sont permis.
 */
Deno.test("domain/pricing n'importe que des fichiers du domaine", async () => {
  const dir = new URL("../../../_shared/domain/pricing/", import.meta.url);
  const offenders: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".ts")) continue;
    const source = await Deno.readTextFile(new URL(entry.name, dir));
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      if (!match[1].startsWith("./") && !match[1].startsWith("../")) offenders.push(`${entry.name} → ${match[1]}`);
    }
    if (/\bDeno\.|\bnew Date\(\)|Date\.now\(/.test(source)) offenders.push(`${entry.name} → horloge ou Deno`);
  }
  assertEquals(offenders, []);
});
