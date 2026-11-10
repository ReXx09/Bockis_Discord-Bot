'use strict';

const { randomBytes, timingSafeEqual } = require('crypto');

const SESSION_COOKIE = 'bockis_dashboard_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MAX_SESSIONS = 10_000;

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual), 'utf8');
  const expectedBuffer = Buffer.from(String(expected), 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function readSessionId(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const cookie = cookies.map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`));
  return cookie ? cookie.slice(SESSION_COOKIE.length + 1) : '';
}

function createDashboardAuth(password, logger, options = {}) {
  const maxAttempts = options.maxAttempts || 10;
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const sessionTtlMs = options.sessionTtlMs || SESSION_TTL_MS;
  const now = options.now || Date.now;
  const sessions = new Map();
  const attemptsByIp = new Map();

  if (!password) {
    logger.warn('Dashboard deaktiviert: DASHBOARD_PASSWORD ist nicht gesetzt.');
  }

  function getActiveSession(req) {
    const sessionId = readSessionId(req);
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    return { sessionId, session };
  }

  function cookieSecurityAttributes(req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] || '')
      .split(',')[0].trim().toLowerCase();
    const secure = req.secure === true || forwardedProto === 'https';
    return `Path=/; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  }

  function clearSessionCookie(req, res) {
    res.set('Set-Cookie',
      `${SESSION_COOKIE}=; ${cookieSecurityAttributes(req)}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
  }

  function getLoginBlock(ip, timestamp) {
    const attempt = attemptsByIp.get(ip);
    if (!attempt) return null;
    if (attempt.blockedUntil > timestamp) return attempt;
    if (timestamp - attempt.startedAt >= windowMs) attemptsByIp.delete(ip);
    return null;
  }

  function recordLoginFailure(ip, timestamp) {
    const previous = attemptsByIp.get(ip);
    const attempt = previous && timestamp - previous.startedAt < windowMs
      ? previous
      : { startedAt: timestamp, failures: 0, blockedUntil: 0 };
    attempt.failures += 1;
    if (attempt.failures >= maxAttempts) attempt.blockedUntil = timestamp + windowMs;
    attemptsByIp.set(ip, attempt);
    while (attemptsByIp.size > MAX_SESSIONS) {
      attemptsByIp.delete(attemptsByIp.keys().next().value);
    }
    return attempt;
  }

  function requestHasSameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const parsed = new URL(origin);
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
        && parsed.host.toLowerCase() === String(req.headers.host || '').toLowerCase();
    } catch {
      return false;
    }
  }

  function dashboardAuth(req, res, next) {
    if (!password) {
      return res.status(503).send('Dashboard deaktiviert: DASHBOARD_PASSWORD konfigurieren.');
    }
    if (getActiveSession(req)) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ ok: false, error: 'Authentifizierung erforderlich' });
    }
    return res.redirect('/login');
  }

  dashboardAuth.enabled = Boolean(password);
  dashboardAuth.isAuthenticated = req => Boolean(password && getActiveSession(req));
  dashboardAuth.login = (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!password) {
      return res.status(503).render('login', {
        error: 'Dashboard deaktiviert: DASHBOARD_PASSWORD konfigurieren.',
      });
    }
    if (!requestHasSameOrigin(req)) {
      return res.status(403).render('login', { error: 'Ungültige Anfrage.' });
    }

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const timestamp = now();
    const blockedAttempt = getLoginBlock(ip, timestamp);
    if (blockedAttempt?.blockedUntil > timestamp) {
      res.set('Retry-After', String(Math.ceil((blockedAttempt.blockedUntil - timestamp) / 1000)));
      return res.status(429).render('login', {
        error: 'Zu viele fehlgeschlagene Anmeldeversuche. Bitte später erneut versuchen.',
      });
    }

    const username = typeof req.body?.username === 'string' ? req.body.username : '';
    const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
    const usernameMatches = timingSafeStringEqual(username, 'admin');
    const passwordMatches = timingSafeStringEqual(suppliedPassword, password);
    if (!usernameMatches || !passwordMatches) {
      const failedAttempt = recordLoginFailure(ip, timestamp);
      if (failedAttempt.blockedUntil > timestamp) {
        res.set('Retry-After', String(Math.ceil((failedAttempt.blockedUntil - timestamp) / 1000)));
        return res.status(429).render('login', {
          error: 'Zu viele fehlgeschlagene Anmeldeversuche. Bitte später erneut versuchen.',
        });
      }
      return res.status(401).render('login', { error: 'Benutzername oder Passwort ist falsch.' });
    }

    attemptsByIp.delete(ip);
    const existing = getActiveSession(req);
    if (existing) sessions.delete(existing.sessionId);
    for (const [sessionId, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(sessionId);
    }
    while (sessions.size >= MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }

    const sessionId = randomBytes(32).toString('base64url');
    sessions.set(sessionId, { expiresAt: timestamp + sessionTtlMs });
    const maxAgeSeconds = Math.floor(sessionTtlMs / 1000);
    res.set('Set-Cookie',
      `${SESSION_COOKIE}=${sessionId}; ${cookieSecurityAttributes(req)}; Max-Age=${maxAgeSeconds}`);
    return res.redirect('/dashboard');
  };
  dashboardAuth.logout = (req, res) => {
    const session = getActiveSession(req);
    if (session) sessions.delete(session.sessionId);
    clearSessionCookie(req, res);
    return res.redirect('/login');
  };

  return dashboardAuth;
}

module.exports = { createDashboardAuth, timingSafeStringEqual };
