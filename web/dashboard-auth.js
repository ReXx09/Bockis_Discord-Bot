'use strict';

const { timingSafeEqual } = require('crypto');

function timingSafeStringEqual(actual, expected) {
  const actualBuffer = Buffer.from(String(actual), 'utf8');
  const expectedBuffer = Buffer.from(String(expected), 'utf8');
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

function createDashboardAuth(password, logger, options = {}) {
  const maxAttempts = options.maxAttempts || 10;
  const windowMs = options.windowMs || 15 * 60 * 1000;
  const now = options.now || Date.now;
  const attemptsByIp = new Map();

  if (!password) {
    logger.warn('Dashboard deaktiviert: DASHBOARD_PASSWORD ist nicht gesetzt.');
  }

  return function dashboardAuth(req, res, next) {
    if (!password) {
      return res.status(503).send('Dashboard deaktiviert: DASHBOARD_PASSWORD konfigurieren.');
    }

    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const timestamp = now();
    const existing = attemptsByIp.get(ip);
    if (existing?.blockedUntil > timestamp) {
      res.set('Retry-After', String(Math.ceil((existing.blockedUntil - timestamp) / 1000)));
      return res.status(429).send('Zu viele fehlgeschlagene Anmeldeversuche.');
    }
    if (existing && timestamp - existing.startedAt >= windowMs) {
      attemptsByIp.delete(ip);
    }

    const authorization = String(req.headers.authorization || '');
    const match = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);
    const credentials = match
      ? Buffer.from(match[1], 'base64').toString('utf8')
      : '';
    const separator = credentials.indexOf(':');
    const username = separator >= 0 ? credentials.slice(0, separator) : '';
    const suppliedPassword = separator >= 0 ? credentials.slice(separator + 1) : '';
    const passwordMatches = timingSafeStringEqual(suppliedPassword, password);

    if (username === 'admin' && passwordMatches) {
      attemptsByIp.delete(ip);
      return next();
    }

    for (const [attemptIp, attempt] of attemptsByIp) {
      if (timestamp - attempt.startedAt >= windowMs && attempt.blockedUntil <= timestamp) {
        attemptsByIp.delete(attemptIp);
      }
    }
    const attempt = attemptsByIp.get(ip);
    const updated = attempt && timestamp - attempt.startedAt < windowMs
      ? attempt
      : { startedAt: timestamp, failures: 0, blockedUntil: 0 };
    updated.failures += 1;
    if (updated.failures >= maxAttempts) updated.blockedUntil = timestamp + windowMs;
    attemptsByIp.set(ip, updated);
    while (attemptsByIp.size > 10_000) {
      attemptsByIp.delete(attemptsByIp.keys().next().value);
    }

    res.set('WWW-Authenticate', 'Basic realm="Service Dashboard"');
    if (updated.blockedUntil > timestamp) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).send('Zu viele fehlgeschlagene Anmeldeversuche.');
    }
    return res.status(401).send('Authentifizierung erforderlich');
  };
}

module.exports = { createDashboardAuth, timingSafeStringEqual };
