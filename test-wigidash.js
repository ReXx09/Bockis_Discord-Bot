#!/usr/bin/env node

/**
 * WigiDash Integration Test Script
 * 
 * Dieses Script testet die WigiDash Status-API
 * 
 * Verwendung:
 *   node test-wigidash.js                          # Standard-Test (localhost:47900)
 *   node test-wigidash.js http://localhost:3000    # Dashboard-Endpunkt testen
 *   node test-wigidash.js http://192.168.x.x:47900 --api-key=geheim123
 */

const http = require('http');
const https = require('https');
const url = require('url');

// Argumente parsen
const args = process.argv.slice(2);
let targetUrl = args[0] || 'http://127.0.0.1:47900/status';
let apiKey = null;

for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--api-key=')) {
    apiKey = args[i].substring('--api-key='.length);
  }
}

// Stelle sicher, dass URL den Endpunkt hat
if (!targetUrl.includes('/status') && !targetUrl.includes('/api/')) {
  targetUrl += targetUrl.endsWith('/') ? 'status' : '/status';
}

console.log('╔════════════════════════════════════════════════════════════════╗');
console.log('║          WigiDash Integration Test Script                      ║');
console.log('╚════════════════════════════════════════════════════════════════╝');
console.log('');
console.log(`📍 Ziel-URL: ${targetUrl}`);
if (apiKey) console.log(`🔑 API-Key: ${apiKey.substring(0, 4)}${'*'.repeat(Math.max(0, apiKey.length - 8))}${apiKey.substring(Math.max(0, apiKey.length - 4))}`);
console.log('');

// Funktion zum Abrufen der Status-Daten
function testEndpoint() {
  const parsedUrl = new url.URL(targetUrl);
  const protocol = parsedUrl.protocol === 'https:' ? https : http;

  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': 'WigiDash-Test/1.0',
      'Accept': 'application/json'
    },
    timeout: 5000
  };

  if (apiKey) {
    options.headers['X-API-Key'] = apiKey;
  }

  console.log('🔄 Sende Request...');
  console.log('');

  const startTime = Date.now();

  const req = protocol.request(options, (res) => {
    const elapsedMs = Date.now() - startTime;
    
    console.log(`✅ Response erhalten (${elapsedMs}ms)`);
    console.log(`📊 HTTP Status: ${res.statusCode}`);
    console.log(`📋 Content-Type: ${res.headers['content-type'] || 'nicht angegeben'}`);
    console.log('');

    let data = '';

    res.on('data', (chunk) => {
      data += chunk;
    });

    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        
        // Format und Validierung überprüfen
        const requiredFields = ['Username', 'Status', 'Activity', 'VoiceChannel', 'Guild'];
        const hasAllFields = requiredFields.every(field => field in parsed);
        
        console.log('📦 Response Payload:');
        console.log('');
        
        for (const field of requiredFields) {
          const value = parsed[field] ?? 'undefined';
          const symbol = value === '' ? '⚪' : value === 'offline' ? '⛔' : '✓';
          console.log(`   ${symbol} ${field.padEnd(15)}: "${value}"`);
        }
        
        console.log('');
        
        if (hasAllFields) {
          console.log('✅ Alle erforderlichen Felder vorhanden');
        } else {
          const missing = requiredFields.filter(f => !(f in parsed));
          console.log(`❌ Fehlende Felder: ${missing.join(', ')}`);
        }

        // Status validierung
        const validStatuses = ['online', 'idle', 'dnd', 'offline'];
        if (validStatuses.includes(parsed.Status)) {
          console.log(`✅ Status ist gültig: "${parsed.Status}"`);
        } else {
          console.log(`⚠️  Status ist unbekannt: "${parsed.Status}"`);
        }

        console.log('');
        console.log('─'.repeat(64));
        console.log('');
        console.log('🎉 Test erfolgreich!');
        console.log('');
        console.log('Nächste Schritte:');
        console.log('  1. Konfiguriere WigiDash mit dieser URL');
        console.log('  2. Überprüfe die Daten im HWiNFO Widget');
        console.log('  3. Stelle sicher, dass Discord-Intents aktiviert sind:');
        console.log('     - Presence Intent ✓');
        console.log('     - Server Members Intent ✓');
        console.log('');
        
      } catch (e) {
        console.log('❌ Response ist kein gültiges JSON');
        console.log('');
        console.log('Response Body:');
        console.log(data);
        process.exit(1);
      }
    });
  });

  req.on('error', (e) => {
    console.log('❌ Request Fehler:');
    console.log('');
    
    if (e.code === 'ECONNREFUSED') {
      console.log(`   Verbindung abgelehnt. Ist der Server auf ${options.hostname}:${options.port} online?`);
    } else if (e.code === 'ETIMEDOUT') {
      console.log(`   Timeout nach 5 Sekunden. Server reagiert nicht.`);
    } else if (e.code === 'ENOTFOUND') {
      console.log(`   Host "${options.hostname}" nicht gefunden.`);
    } else {
      console.log(`   Fehler: ${e.message}`);
    }
    
    console.log('');
    console.log('Debugging-Tipps:');
    console.log(`  - Prüfe: curl ${targetUrl}`);
    console.log(`  - Ist der Bot gestartet? npm start`);
    console.log(`  - Ist WIGIDASH_API_ENABLED=true in .env?`);
    console.log(`  - Port-Konflikt? netstat -ano | findstr :47900`);
    
    process.exit(1);
  });

  req.on('timeout', () => {
    console.log('❌ Request Timeout (5s)');
    req.destroy();
    process.exit(1);
  });

  req.end();
}

// Tests ausführen
testEndpoint();
