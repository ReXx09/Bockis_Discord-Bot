'use strict';

const { createDashboardAuth, timingSafeStringEqual } = require('../web/dashboard-auth');

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    redirectTo: null,
    rendered: null,
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    redirect(path) {
      this.redirectTo = path;
      return this;
    },
    render(view, locals) {
      this.rendered = { view, locals };
      return this;
    }
  };
}

function request({
  ip = '127.0.0.1',
  path = '/dashboard',
  headers = {},
  body = {},
  secure = false
} = {}) {
  return {
    ip,
    path,
    headers,
    body,
    secure,
    socket: { remoteAddress: ip }
  };
}

function credentials(username = 'admin', password = 'correct horse battery staple') {
  return { username, password };
}

function sessionCookie(response) {
  return response.headers['Set-Cookie'].split(';')[0];
}

describe('dashboard session authentication', () => {
  test('fails closed when no password is configured', () => {
    const logger = { warn: jest.fn() };
    const auth = createDashboardAuth('', logger);
    const response = createResponse();
    const next = jest.fn();

    auth(request(), response, next);

    expect(response.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('redirects browser requests and rejects unauthenticated API requests', () => {
    const auth = createDashboardAuth('secret', { warn: jest.fn() });
    const pageResponse = createResponse();
    auth(request(), pageResponse, jest.fn());
    expect(pageResponse.redirectTo).toBe('/login');

    const apiResponse = createResponse();
    auth(request({ path: '/api/config' }), apiResponse, jest.fn());
    expect(apiResponse.statusCode).toBe(401);
    expect(apiResponse.body).toEqual({ ok: false, error: 'Authentifizierung erforderlich' });
  });

  test('creates an HttpOnly same-site session, authenticates it, and logs out', () => {
    const auth = createDashboardAuth('correct horse battery staple', { warn: jest.fn() });
    const loginResponse = createResponse();
    auth.login(request({ body: credentials() }), loginResponse);

    expect(loginResponse.redirectTo).toBe('/dashboard');
    expect(loginResponse.headers['Set-Cookie']).toContain('HttpOnly');
    expect(loginResponse.headers['Set-Cookie']).toContain('SameSite=Strict');
    const cookie = sessionCookie(loginResponse);
    const next = jest.fn();
    auth(request({ headers: { cookie } }), createResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);

    const logoutResponse = createResponse();
    auth.logout(request({ headers: { cookie } }), logoutResponse);
    expect(logoutResponse.redirectTo).toBe('/login');
    expect(logoutResponse.headers['Set-Cookie']).toContain('Max-Age=0');

    const afterLogout = createResponse();
    auth(request({ headers: { cookie } }), afterLogout, jest.fn());
    expect(afterLogout.redirectTo).toBe('/login');
  });

  test('rejects invalid credentials, locks out repeated failures, then recovers', () => {
    let timestamp = 1_000;
    const auth = createDashboardAuth('secret', { warn: jest.fn() }, {
      maxAttempts: 2,
      windowMs: 60_000,
      now: () => timestamp
    });

    const firstResponse = createResponse();
    auth.login(request({ ip: '192.0.2.1', body: credentials('other', 'secret') }), firstResponse);
    expect(firstResponse.statusCode).toBe(401);

    const secondResponse = createResponse();
    auth.login(request({ ip: '192.0.2.1', body: credentials('admin', 'wrong') }), secondResponse);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.headers['Retry-After']).toBe('60');

    const lockedResponse = createResponse();
    auth.login(request({ ip: '192.0.2.1', body: credentials('admin', 'secret') }), lockedResponse);
    expect(lockedResponse.statusCode).toBe(429);

    timestamp += 60_001;
    const recoveredResponse = createResponse();
    auth.login(request({ ip: '192.0.2.1', body: credentials('admin', 'secret') }), recoveredResponse);
    expect(recoveredResponse.redirectTo).toBe('/dashboard');
  });

  test('rejects cross-origin login posts and marks proxy HTTPS cookies secure', () => {
    const auth = createDashboardAuth('secret', { warn: jest.fn() });
    const rejectedResponse = createResponse();
    auth.login(request({
      headers: { host: 'dashboard.example', origin: 'https://attacker.example' },
      body: credentials('admin', 'secret')
    }), rejectedResponse);
    expect(rejectedResponse.statusCode).toBe(403);

    const secureResponse = createResponse();
    auth.login(request({
      headers: { host: 'dashboard.example', 'x-forwarded-proto': 'https' },
      body: credentials('admin', 'secret')
    }), secureResponse);
    expect(secureResponse.headers['Set-Cookie']).toContain('; Secure');
  });

  test('expires sessions after the configured lifetime', () => {
    let timestamp = 100;
    const auth = createDashboardAuth('secret', { warn: jest.fn() }, {
      sessionTtlMs: 1_000,
      now: () => timestamp
    });
    const loginResponse = createResponse();
    auth.login(request({ body: credentials('admin', 'secret') }), loginResponse);
    const next = jest.fn();

    timestamp += 1_001;
    const response = createResponse();
    auth(request({ headers: { cookie: sessionCookie(loginResponse) } }), response, next);
    expect(response.redirectTo).toBe('/login');
    expect(next).not.toHaveBeenCalled();
  });
});

describe('timingSafeStringEqual', () => {
  test('compares equal and unequal values, including different byte lengths', () => {
    expect(timingSafeStringEqual('same', 'same')).toBe(true);
    expect(timingSafeStringEqual('same', 'other')).toBe(false);
    expect(timingSafeStringEqual('short', 'longer')).toBe(false);
  });
});
