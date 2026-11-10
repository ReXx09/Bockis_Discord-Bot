'use strict';

const { createDashboardAuth, timingSafeStringEqual } = require('../web/dashboard-auth');

function createResponse() {
  return {
    headers: {},
    statusCode: null,
    body: null,
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
    }
  };
}

function request(ip = '127.0.0.1', authorization = '') {
  return { ip, headers: { authorization } };
}

function basicAuth(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

describe('dashboard authentication', () => {
  test('fails closed when no password is configured', () => {
    const logger = { warn: jest.fn() };
    const middleware = createDashboardAuth('', logger);
    const response = createResponse();
    const next = jest.fn();

    middleware(request(), response, next);

    expect(response.statusCode).toBe(503);
    expect(next).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  test('accepts only the admin username with the configured password', () => {
    const middleware = createDashboardAuth('correct horse battery staple', { warn: jest.fn() });
    const response = createResponse();
    const next = jest.fn();

    middleware(request('127.0.0.1', basicAuth('admin', 'correct horse battery staple')), response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBeNull();
  });

  test('rejects invalid credentials and locks out repeated failures', () => {
    let timestamp = 1_000;
    const middleware = createDashboardAuth('secret', { warn: jest.fn() }, {
      maxAttempts: 2,
      windowMs: 60_000,
      now: () => timestamp
    });
    const next = jest.fn();
    const wrongUsernameResponse = createResponse();
    middleware(request('192.0.2.1', basicAuth('other', 'secret')), wrongUsernameResponse, next);
    expect(wrongUsernameResponse.statusCode).toBe(401);

    const secondResponse = createResponse();
    middleware(request('192.0.2.1', basicAuth('admin', 'wrong')), secondResponse, next);
    expect(secondResponse.statusCode).toBe(429);
    expect(secondResponse.headers['Retry-After']).toBe('60');

    const lockedResponse = createResponse();
    middleware(request('192.0.2.1', basicAuth('admin', 'secret')), lockedResponse, next);
    expect(lockedResponse.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();

    timestamp += 60_001;
    const recoveredResponse = createResponse();
    middleware(request('192.0.2.1', basicAuth('admin', 'secret')), recoveredResponse, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('timingSafeStringEqual', () => {
  test('compares equal and unequal values, including different byte lengths', () => {
    expect(timingSafeStringEqual('same', 'same')).toBe(true);
    expect(timingSafeStringEqual('same', 'other')).toBe(false);
    expect(timingSafeStringEqual('short', 'longer')).toBe(false);
  });
});
