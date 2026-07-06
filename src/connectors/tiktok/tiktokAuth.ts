import axios from 'axios';
import crypto from 'node:crypto';
import http from 'node:http';
import { env, setupMessage } from '../../config/env';
import { getSetting, setSetting } from '../../db/database';
import { audit, logger } from '../../utils/logger';
import { withRetry } from '../../utils/retry';

/**
 * TikTok OAuth 2.0 (authorization-code) helper — official endpoints only.
 *
 * Access tokens expire after ~24h; refresh tokens last ~365 days. Tokens are
 * stored in the SQLite `settings` table so uploads keep working unattended:
 * getValidAccessToken() transparently refreshes when needed.
 *
 * Flow (run `npm run tiktok-auth`):
 *   1. Open the printed tiktok.com authorize URL and approve the app.
 *   2. If TIKTOK_REDIRECT_URI is a localhost URL, a temporary local server
 *      catches the redirect automatically; otherwise copy the `code` query
 *      param from the redirect and run `npm run tiktok-auth -- --code <code>`.
 *   3. Tokens are exchanged at open.tiktokapis.com and saved.
 */

const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';

const KEYS = {
  accessToken: 'tiktok.access_token',
  accessExpiresAt: 'tiktok.access_expires_at',
  refreshToken: 'tiktok.refresh_token',
  refreshExpiresAt: 'tiktok.refresh_expires_at',
  openId: 'tiktok.open_id',
  scope: 'tiktok.scope',
  pendingState: 'tiktok.pending_state',
} as const;

export interface StoredTikTokTokens {
  accessToken?: string;
  accessExpiresAt?: string;
  refreshToken?: string;
  refreshExpiresAt?: string;
  openId?: string;
  scope?: string;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  open_id: string;
  scope: string;
  token_type: string;
  error?: string;
  error_description?: string;
}

export function getStoredTokens(): StoredTikTokTokens {
  return {
    accessToken: getSetting(KEYS.accessToken),
    accessExpiresAt: getSetting(KEYS.accessExpiresAt),
    refreshToken: getSetting(KEYS.refreshToken),
    refreshExpiresAt: getSetting(KEYS.refreshExpiresAt),
    openId: getSetting(KEYS.openId),
    scope: getSetting(KEYS.scope),
  };
}

function saveTokens(t: TokenResponse): void {
  const now = Date.now();
  setSetting(KEYS.accessToken, t.access_token);
  setSetting(KEYS.accessExpiresAt, new Date(now + t.expires_in * 1000).toISOString());
  setSetting(KEYS.refreshToken, t.refresh_token);
  setSetting(
    KEYS.refreshExpiresAt,
    new Date(now + t.refresh_expires_in * 1000).toISOString(),
  );
  setSetting(KEYS.openId, t.open_id ?? '');
  setSetting(KEYS.scope, t.scope ?? '');
  audit('info', 'TikTok tokens saved', {
    openId: t.open_id,
    scope: t.scope,
    accessExpiresIn: t.expires_in,
  });
}

/** 'oauth-stored' | 'env-token' | 'none' — used by the CLI banner/status. */
export function describeTikTokAuth(): 'oauth-stored' | 'env-token' | 'none' {
  try {
    const stored = getStoredTokens();
    if (stored.refreshToken || stored.accessToken) return 'oauth-stored';
  } catch {
    // DB not ready yet — fall through to env.
  }
  return env.TIKTOK_ACCESS_TOKEN ? 'env-token' : 'none';
}

/** True when any credential path (stored OAuth or env token) is available. */
export function hasTikTokAuth(): boolean {
  return describeTikTokAuth() !== 'none';
}

export function buildAuthUrl(state: string): string {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_REDIRECT_URI) {
    throw new Error(
      'TIKTOK_CLIENT_KEY and TIKTOK_REDIRECT_URI must be set in .env first.\n' +
        'Create an app at https://developers.tiktok.com (Content Posting API product, ' +
        'video.publish scope) and register the redirect URI there.',
    );
  }
  const params = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    scope: env.TIKTOK_SCOPES,
    response_type: 'code',
    redirect_uri: env.TIKTOK_REDIRECT_URI,
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  return withRetry(
    async () => {
      const res = await axios.post<TokenResponse>(TOKEN_URL, body.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 30_000,
      });
      if (res.data.error) {
        throw new Error(
          `TikTok token endpoint error: ${res.data.error} — ${res.data.error_description ?? ''}`,
        );
      }
      if (!res.data.access_token) {
        throw new Error(`TikTok token endpoint returned no access_token: ${JSON.stringify(res.data).slice(0, 300)}`);
      }
      return res.data;
    },
    { label: 'TikTok token exchange', retries: 2 },
  );
}

export async function exchangeCode(code: string): Promise<StoredTikTokTokens> {
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    throw new Error('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set in .env.');
  }
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: env.TIKTOK_REDIRECT_URI,
  });
  const tokens = await postToken(body);
  saveTokens(tokens);
  return getStoredTokens();
}

export async function refreshTokens(): Promise<StoredTikTokTokens> {
  const stored = getStoredTokens();
  if (!stored.refreshToken) {
    throw new Error('No stored refresh token. Run `npm run tiktok-auth` first.');
  }
  if (!env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) {
    throw new Error('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET must be set to refresh tokens.');
  }
  const body = new URLSearchParams({
    client_key: env.TIKTOK_CLIENT_KEY,
    client_secret: env.TIKTOK_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: stored.refreshToken,
  });
  const tokens = await postToken(body);
  saveTokens(tokens);
  logger.info('TikTok access token refreshed.');
  return getStoredTokens();
}

/**
 * The token every API call should use. Order:
 *   1. stored token still valid (>2 min margin)
 *   2. stored refresh token -> refresh -> new token
 *   3. static TIKTOK_ACCESS_TOKEN from .env (no expiry tracking possible)
 */
export async function getValidAccessToken(): Promise<string> {
  const stored = getStoredTokens();
  const margin = 2 * 60 * 1000;

  if (
    stored.accessToken &&
    stored.accessExpiresAt &&
    new Date(stored.accessExpiresAt).getTime() - margin > Date.now()
  ) {
    return stored.accessToken;
  }

  if (stored.refreshToken && env.TIKTOK_CLIENT_KEY && env.TIKTOK_CLIENT_SECRET) {
    if (
      stored.refreshExpiresAt &&
      new Date(stored.refreshExpiresAt).getTime() < Date.now()
    ) {
      throw new Error(
        'TikTok refresh token has expired — run `npm run tiktok-auth` to re-authorize.',
      );
    }
    const refreshed = await refreshTokens();
    if (refreshed.accessToken) return refreshed.accessToken;
  }

  if (env.TIKTOK_ACCESS_TOKEN) return env.TIKTOK_ACCESS_TOKEN;
  throw new Error(setupMessage('tiktok'));
}

// ---------------------------------------------------------------------------
// Interactive auth flow
// ---------------------------------------------------------------------------

export interface AuthFlowResult {
  authorized: boolean;
  message: string;
}

/**
 * Run the authorization flow. When the registered redirect URI points at
 * localhost, a temporary local HTTP server captures the callback; otherwise
 * the user pastes the code back via --code.
 */
export async function runAuthFlow(opts: { code?: string } = {}): Promise<AuthFlowResult> {
  if (opts.code) {
    const stored = await exchangeCode(opts.code.trim());
    return {
      authorized: true,
      message:
        `Authorized TikTok account (open_id: ${stored.openId ?? 'unknown'}).\n` +
        `Scopes: ${stored.scope}. Access token valid until ${stored.accessExpiresAt}.\n` +
        'Tokens are stored locally and refresh automatically.',
    };
  }

  const state = crypto.randomBytes(16).toString('hex');
  setSetting(KEYS.pendingState, state);
  const authUrl = buildAuthUrl(state);

  let redirect: URL | undefined;
  try {
    redirect = new URL(env.TIKTOK_REDIRECT_URI);
  } catch {
    redirect = undefined;
  }
  const isLocal =
    redirect && ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname);

  if (!isLocal) {
    return {
      authorized: false,
      message:
        `1. Open this URL in your browser and approve the app:\n\n${authUrl}\n\n` +
        `2. After approving, TikTok redirects to ${env.TIKTOK_REDIRECT_URI} with a "code" query parameter.\n` +
        '3. Copy that code and finish with:\n   npm run tiktok-auth -- --code <code>',
    };
  }

  // Localhost redirect: catch the callback automatically.
  const port = Number(redirect!.port || 80);
  const pathName = redirect!.pathname || '/';

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      if (url.pathname !== pathName) {
        res.writeHead(404).end();
        return;
      }
      const err = url.searchParams.get('error');
      const gotState = url.searchParams.get('state');
      const gotCode = url.searchParams.get('code');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (err || !gotCode) {
        res.end('<h3>Authorization failed — you can close this tab.</h3>');
        cleanup(new Error(`TikTok authorization failed: ${err ?? 'no code returned'}`));
        return;
      }
      if (gotState !== state) {
        res.end('<h3>State mismatch — you can close this tab.</h3>');
        cleanup(new Error('OAuth state mismatch — try again.'));
        return;
      }
      res.end('<h3>Authorized! You can close this tab and return to the terminal.</h3>');
      cleanup(undefined, gotCode);
    });

    const timeout = setTimeout(
      () => cleanup(new Error('Timed out waiting for the TikTok redirect (5 minutes).')),
      5 * 60 * 1000,
    );

    function cleanup(error?: Error, value?: string): void {
      clearTimeout(timeout);
      server.close();
      if (error) reject(error);
      else resolve(value!);
    }

    server.on('error', (e) => cleanup(e as Error));
    server.listen(port, () => {
      logger.info(`Listening on ${env.TIKTOK_REDIRECT_URI} for the OAuth callback…`);
      // eslint-disable-next-line no-console
      console.log(`\nOpen this URL in your browser and approve the app:\n\n${authUrl}\n`);
    });
  });

  const stored = await exchangeCode(code);
  return {
    authorized: true,
    message:
      `Authorized TikTok account (open_id: ${stored.openId ?? 'unknown'}).\n` +
      `Scopes: ${stored.scope}. Access token valid until ${stored.accessExpiresAt}.\n` +
      'Tokens are stored locally and refresh automatically.',
  };
}
