'use strict';

function normalizeWebPort(value) {
  const text = String(value).trim();
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('WEB_PORT muss eine ganze Zahl zwischen 1 und 65535 sein.');
  }
  return String(port);
}

function describeWebServerListenError(error, host, port) {
  if (error.code === 'EADDRINUSE') return `Dashboard-Port ${port} auf ${host} ist bereits belegt.`;
  if (error.code === 'EADDRNOTAVAIL') return `Dashboard-Host ${host} ist auf diesem Rechner nicht verfügbar.`;
  return `Dashboard konnte nicht auf ${host}:${port} starten: ${error.message}`;
}

module.exports = { describeWebServerListenError, normalizeWebPort };