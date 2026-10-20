/**
 * API publique du site : récapitulatif (/quote) et paiement (/checkout).
 *
 * /quote est un simple calcul : public, sans base ni Stripe.
 * /checkout crée des ressources Stripe : la vérification d'origine ne suffit pas
 * (un programme peut la falsifier), il est donc aussi protégé par une limite
 * d'appels (adresse IP, puis courriel) et une vérification antirobot côté serveur.
 *
 * Chaque refus a un code stable et un message en français pour le site; une
 * panne ne donne jamais de détail technique au visiteur. Le site ne révèle pas
 * si un courriel est déjà client : ancien client et inscription refusée
 * reçoivent le même message.
 */
import { PricingError } from '../_shared/domain/pricing/mod.ts';
import type { HumanCheck } from '../_shared/integrations/turnstile/verify.ts';
import {
  BillingTerminalError,
  type BillingGateway,
  type CheckoutRepository,
  InvalidRequestError,
  SignupError,
  type SignupInput,
} from '../_shared/services/ports.ts';
import { prepareQuote, type QuoteRequest, startCheckout } from '../_shared/services/start-checkout.ts';

export interface RateLimiter {
  /** true si l'appel est permis (et le compte), false si la limite est atteinte. */
  allow(key: string, limit: number, windowSeconds: number): Promise<boolean>;
}

export interface PublicApiDeps {
  /** Créés seulement pour /checkout : /quote n'a besoin ni de Stripe ni de la base. */
  checkoutDeps(): { billing: BillingGateway; repository: CheckoutRepository };
  rateLimiter(): RateLimiter;
  /** null : vérification antirobot désactivée (développement local seulement). */
  humanCheck: HumanCheck | null;
  /** Jour courant à Montréal (AAAA-MM-JJ). */
  today(): string;
  /** Origines autorisées (site vitrine, application). */
  allowedOrigins: readonly string[];
}

const MAX_BODY = 16_384;
/** Limites de /checkout : par adresse IP, puis par courriel. */
export const LIMITS = {
  ip: { limit: 20, windowSeconds: 3600 },
  email: { limit: 5, windowSeconds: 3600 },
} as const;

export type ApiErrorCode =
  | 'invalid_request' | 'not_found' | 'method_not_allowed' | 'origin_refused' | 'body_too_large'
  | 'too_many_requests' | 'human_check_failed'
  | 'trajet_not_eligible' | 'plan_not_purchasable' | 'billing_not_offered'
  | 'cannot_signup_online' | 'payment_in_progress' | 'attempt_expired' | 'attempt_conflict'
  | 'checkout_window_closed' | 'unavailable';

const MESSAGES: Record<ApiErrorCode, string> = {
  invalid_request: 'Certaines informations sont manquantes ou invalides.',
  not_found: 'Adresse inconnue.',
  method_not_allowed: 'Méthode non permise.',
  origin_refused: 'Origine non autorisée.',
  body_too_large: 'Demande trop volumineuse.',
  too_many_requests: 'Trop de tentatives. Patientez un moment avant de réessayer.',
  human_check_failed: 'La vérification de sécurité a échoué. Rechargez la page et réessayez.',
  trajet_not_eligible: 'Votre situation ne correspond pas aux critères du forfait Trajet. Comparez les autres forfaits pour trouver celui qui vous convient.',
  plan_not_purchasable: 'Ce forfait se fait sur soumission : écrivez-nous pour en discuter.',
  billing_not_offered: 'Cette option de paiement n\'est pas offerte pour ce forfait.',
  cannot_signup_online: 'Nous ne pouvons pas finaliser cette inscription en ligne. Si vous avez déjà un dossier chez nous, connectez-vous à votre espace client. Sinon, écrivez-nous et nous vous répondrons rapidement.',
  payment_in_progress: 'Un paiement est déjà en traitement pour ce courriel. Surveillez vos courriels : la confirmation arrive dans quelques minutes.',
  attempt_expired: 'Cette page de paiement a expiré. Recommencez l\'inscription pour obtenir une nouvelle page.',
  attempt_conflict: 'Vos choix ont changé depuis l\'ouverture de la page de paiement. Recommencez l\'inscription.',
  checkout_window_closed: 'Les paiements sont fermés pendant la dernière demi-heure du mois. Réessayez après minuit.',
  unavailable: 'Le service est momentanément indisponible. Réessayez dans quelques minutes.',
};

const STATUS: Record<ApiErrorCode, number> = {
  invalid_request: 400, not_found: 404, method_not_allowed: 405, origin_refused: 403, body_too_large: 413,
  too_many_requests: 429, human_check_failed: 403,
  trajet_not_eligible: 422, plan_not_purchasable: 422, billing_not_offered: 422,
  cannot_signup_online: 409, payment_in_progress: 409, attempt_expired: 410, attempt_conflict: 409,
  checkout_window_closed: 409, unavailable: 503,
};

class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, readonly details: readonly string[] = [], readonly retryAfter?: number) {
    super(code);
  }
}

/** Traduit toute erreur en code d'API. Ce qui n'est pas prévu est une panne. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof InvalidRequestError) return new ApiError('invalid_request');
  if (error instanceof SignupError) {
    // Même réponse pour un ancien client et un refus : le site ne révèle pas qui est client.
    return new ApiError(error.code === 'returning_client' || error.code === 'not_allowed'
      ? 'cannot_signup_online' : error.code);
  }
  if (error instanceof BillingTerminalError && error.reason === 'checkout_window_closed') {
    return new ApiError('checkout_window_closed');
  }
  if (error instanceof PricingError) {
    switch (error.code) {
      case 'not_eligible': return new ApiError('trajet_not_eligible', error.details);
      case 'plan_not_purchasable': return new ApiError('plan_not_purchasable');
      case 'billing_not_offered': return new ApiError('billing_not_offered');
      case 'invalid_input': return new ApiError('invalid_request');
    }
  }
  return new ApiError('unavailable');
}

// ---------- Lecture du corps : taille bornée avant lecture, puis chaque champ vérifié.

async function readBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (!Number.isFinite(declared) || declared > MAX_BODY) throw new ApiError('body_too_large');
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new ApiError('body_too_large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

const str = (body: Record<string, unknown>, key: string, max = 200): string => {
  const v = body[key];
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new InvalidRequestError(`${key} invalide`);
  return v.trim();
};
const bool = (body: Record<string, unknown>, key: string): boolean => {
  const v = body[key];
  if (typeof v !== 'boolean') throw new InvalidRequestError(`${key} invalide`);
  return v;
};
const int = (body: Record<string, unknown>, key: string): number => {
  const v = body[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 100_000) {
    throw new InvalidRequestError(`${key} invalide`);
  }
  return v;
};
const oneOf = <T extends string>(body: Record<string, unknown>, key: string, values: readonly T[]): T => {
  const v = body[key];
  if (typeof v !== 'string' || !values.includes(v as T)) throw new InvalidRequestError(`${key} invalide`);
  return v as T;
};

function parseQuote(body: Record<string, unknown>): QuoteRequest {
  const profile = body.trajetProfile;
  let trajetProfile: QuoteRequest['trajetProfile'];
  if (profile !== undefined && profile !== null) {
    if (typeof profile !== 'object' || Array.isArray(profile)) throw new InvalidRequestError('trajetProfile invalide');
    const p = profile as Record<string, unknown>;
    trajetProfile = {
      platformIncomeOnly: bool(p, 'platformIncomeOnly'),
      issuesClientInvoices: bool(p, 'issuesClientInvoices'),
      accounts: int(p, 'accounts'),
      monthlyTransactions: int(p, 'monthlyTransactions'),
    };
  }
  return {
    planCode: str(body, 'planCode', 40),
    billingOption: oneOf(body, 'billingOption', ['monthly', 'monthly_commitment', 'annual'] as const),
    startMonth: oneOf(body, 'startMonth', ['current', 'next'] as const),
    estimatedTransactions: int(body, 'estimatedTransactions'),
    trajetProfile,
  };
}

function parseSignup(body: Record<string, unknown>, origins: readonly string[]): SignupInput {
  const redirect = (key: string): string => {
    const value = str(body, key, 2000);
    let url: URL;
    try { url = new URL(value); } catch { throw new InvalidRequestError(`${key} invalide`); }
    if (!origins.includes(url.origin) || url.username || url.password) {
      throw new InvalidRequestError(`${key} non autorisée`);
    }
    return url.toString();
  };
  return {
    ...parseQuote(body),
    attemptId: str(body, 'attemptId', 36),
    email: str(body, 'email', 254),
    phone: str(body, 'phone', 40),
    displayName: str(body, 'displayName', 200),
    booksUpToDate: bool(body, 'booksUpToDate'),
    usesQuickbooks: bool(body, 'usesQuickbooks'),
    successUrl: redirect('successUrl'),
    cancelUrl: redirect('cancelUrl'),
  };
}

/** Adresse IP du visiteur, telle que transmise par la passerelle Supabase. */
function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || request.headers.get('x-real-ip') || null;
}

async function enforce(limiter: RateLimiter, key: string, rule: { limit: number; windowSeconds: number }) {
  if (!await limiter.allow(key, rule.limit, rule.windowSeconds)) {
    throw new ApiError('too_many_requests', [], rule.windowSeconds);
  }
}

// ---------- Réponses

function cors(origin: string, origins: readonly string[]): Record<string, string> {
  return origins.includes(origin) ? { 'access-control-allow-origin': origin, vary: 'origin' } : { vary: 'origin' };
}
function json(body: unknown, status: number, origin: string, origins: readonly string[],
  extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      ...cors(origin, origins), ...extra,
    },
  });
}
function errorResponse(error: ApiError, origin: string, origins: readonly string[]): Response {
  const body = {
    error: {
      code: error.code, message: MESSAGES[error.code],
      ...(error.details.length ? { details: error.details } : {}),
    },
  };
  return json(body, STATUS[error.code], origin, origins,
    error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {});
}

export async function handlePublicApi(request: Request, deps: PublicApiDeps): Promise<Response> {
  const origins = deps.allowedOrigins;
  const origin = request.headers.get('origin') ?? '';
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors(origin, origins),
        'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-max-age': '600',
      },
    });
  }
  const route = new URL(request.url).pathname.split('/').filter(Boolean).at(-1);
  try {
    if (request.method !== 'POST') throw new ApiError('method_not_allowed');
    if (!origins.length) throw new Error('Origines autorisées non configurées');
    if (route !== 'quote' && route !== 'checkout') throw new ApiError('not_found');
    // /checkout : l'origine est obligatoire (un navigateur l'envoie toujours sur un POST).
    if ((route === 'checkout' || origin) && !origins.includes(origin)) throw new ApiError('origin_refused');

    const ip = clientIp(request);
    // Compté avant toute lecture : un envoi massif de requêtes invalides est aussi limité.
    if (route === 'checkout') await enforce(deps.rateLimiter(), `checkout:ip:${ip ?? 'inconnue'}`, LIMITS.ip);

    const raw = await readBody(request);
    let body: unknown;
    try { body = JSON.parse(raw); } catch { throw new ApiError('invalid_request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError('invalid_request');
    const fields = body as Record<string, unknown>;

    if (route === 'quote') {
      return json({ quote: prepareQuote(parseQuote(fields), deps.today()) }, 200, origin, origins);
    }
    const input = parseSignup(fields, origins);
    if (deps.humanCheck) {
      const token = typeof fields.captchaToken === 'string' ? fields.captchaToken : '';
      if (!await deps.humanCheck.verify(token, ip)) throw new ApiError('human_check_failed');
    }
    await enforce(deps.rateLimiter(), `checkout:email:${input.email.toLowerCase()}`, LIMITS.email);
    const result = await startCheckout(input, deps.checkoutDeps(), deps.today());
    return json({ attemptId: result.attemptId, url: result.url, quote: result.quote }, 200, origin, origins);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === 'unavailable') {
      console.error('public-api : panne', route, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    }
    return errorResponse(apiError, origin, origins);
  }
}

/** Jour courant à Montréal, au format AAAA-MM-JJ. */
export function montrealToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}
