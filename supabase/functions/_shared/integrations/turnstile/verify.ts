/**
 * Vérification antirobot Cloudflare Turnstile, côté serveur. Le site affiche
 * le widget et envoie son jeton (captchaToken); sans jeton valide, aucune
 * session Stripe n'est créée. Un jeton ne sert qu'une fois.
 */
const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface HumanCheck {
  verify(token: string, remoteIp: string | null): Promise<boolean>;
}

export class TurnstileVerifier implements HumanCheck {
  constructor(
    private readonly secret: string,
    /** Hôtes acceptés (domaine du site); vide = non vérifié. */
    private readonly hostnames: readonly string[] = [],
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async verify(token: string, remoteIp: string | null): Promise<boolean> {
    if (!token || token.length > 2048) return false;
    const form = new FormData();
    form.set('secret', this.secret);
    form.set('response', token);
    if (remoteIp) form.set('remoteip', remoteIp);
    const res = await this.fetcher(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Turnstile indisponible (${res.status})`);
    const outcome = await res.json() as { success?: boolean; hostname?: string };
    if (outcome.success !== true) return false;
    return !this.hostnames.length || this.hostnames.includes(outcome.hostname ?? '');
  }
}
