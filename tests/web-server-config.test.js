'use strict';

const { describeWebServerListenError, normalizeWebPort } = require('../web/server-config');

describe('dashboard web server configuration', () => {
  test.each([
    ['3210', '3210'],
    [' 003210 ', '3210'],
    ['1', '1'],
    ['65535', '65535'],
  ])('normalizes valid port %s', (input, expected) => {
    expect(normalizeWebPort(input)).toBe(expected);
  });

  test.each(['', '0', '-1', '65536', '3210.5', '3210abc', '+3210'])('rejects invalid port %s', input => {
    expect(() => normalizeWebPort(input)).toThrow('WEB_PORT muss eine ganze Zahl zwischen 1 und 65535 sein.');
  });

  test('describes common host and port binding failures', () => {
    expect(describeWebServerListenError({ code: 'EADDRINUSE' }, '0.0.0.0', 3210))
      .toBe('Dashboard-Port 3210 auf 0.0.0.0 ist bereits belegt.');
    expect(describeWebServerListenError({ code: 'EADDRNOTAVAIL' }, '192.168.8.121', 3210))
      .toBe('Dashboard-Host 192.168.8.121 ist auf diesem Rechner nicht verfügbar.');
  });
});