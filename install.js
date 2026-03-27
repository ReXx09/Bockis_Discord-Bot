#!/usr/bin/env node
'use strict';

/**
 * Bockis Discord Bot – Interaktiver TUI-Installer
 * Copyright (c) 2026 ReXx09 (https://github.com/ReXx09)
 *
 * This software is licensed under the MIT License.
 * See the LICENSE file in the project root for full license details.
 *
 * SPDX-License-Identifier: MIT
 * Keine externen Abhängigkeiten – läuft mit Node.js >= 18 out-of-the-box.
 */

const readline = require('readline');
const { execSync, spawn } = require('child_process');
const fs = require('fs');

// ── ANSI-Farben ───────────────────────────────────────────────────────────────
const C = {
  r:    '\x1b[0m',
  b:    '\x1b[1m',
  dim:  '\x1b[2m',
  red:  '\x1b[31m',
  grn:  '\x1b[32m',
  yel:  '\x1b[33m',
  blu:  '\x1b[34m',
  cyn:  '\x1b[36m',
  bred: '\x1b[91m',
  bgrn: '\x1b[92m',
  byel: '\x1b[93m',
  bblu: '\x1b[94m',
  bcyn: '\x1b[96m',
};

const SYM = {
  ok:   `${C.bgrn}✔${C.r}`,
  fail: `${C.bred}✘${C.r}`,
  info: `${C.bblu}ℹ${C.r}`,
  warn: `${C.byel}⚠${C.r}`,
  arr:  `${C.bcyn}▸${C.r}`,
};

// ── HILFSFUNKTIONEN ───────────────────────────────────────────────────────────

function cls() {
  // Funktioniert sowohl in Windows Terminal als auch in klassischer cmd/PS
  process.stdout.write('\x1b[2J\x1b[H');
}

function hr(char = '─', len = 62) {
  return char.repeat(len);
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function padEnd(str, width) {
  const visible = stripAnsi(str).length;
  return str + ' '.repeat(Math.max(0, width - visible));
}

function box(lines, width = 62) {
  const top    = `╔${hr('═', width + 2)}╗`;
  const bottom = `╚${hr('═', width + 2)}╝`;
  const rows = lines.map(l => `║ ${padEnd(l, width)} ║`);
  return [top, ...rows, bottom].join('\n');
}

function banner() {
  cls();
  console.log(box([
    '',
    `${C.b}${C.bblu}   🤖  Bockis Discord Bot  –  Installer  v1.1${C.r}`,
    '',
    `${C.dim}   Schritt-für-Schritt-Einrichtungsassistent${C.r}`,
    '',
  ]));
  console.log();
}

function stepHeader(n, total, title) {
  console.log();
  console.log(`  ${C.b}${C.bblu}[${n}/${total}]  ${title}${C.r}`);
  console.log(`  ${hr('─', 58)}`);
  console.log();
}

function print(msg)  { console.log(`  ${msg}`); }
function nl()        { console.log(); }

// ── EINGABE-PROMPTS ───────────────────────────────────────────────────────────

async function ask(rl, question, defaultVal = '', {
  hint     = '',
  validate = null,
  required = true,
} = {}) {
  const defStr  = defaultVal ? ` ${C.dim}[Standard: ${defaultVal}]${C.r}` : '';
  const hintStr = hint
    ? `\n     ${C.dim}${hint.replace(/\n/g, `\n     `)}${C.r}`
    : '';
  const prompt  = `\n  ${SYM.arr} ${C.b}${question}${C.r}${defStr}${hintStr}\n  ${C.cyn}›${C.r} `;

  return new Promise(resolve => {
    function doAsk() {
      rl.question(prompt, raw => {
        const val = raw.trim() || defaultVal;

        if (required && !val) {
          print(`${SYM.fail}  Dieser Wert ist erforderlich.`);
          return doAsk();
        }

        if (validate && val) {
          const err = validate(val);
          if (err) {
            print(`${SYM.fail}  ${err}`);
            return doAsk();
          }
        }

        resolve(val);
      });
    }
    doAsk();
  });
}

async function confirm(rl, question, defaultYes = true) {
  const yesStr = defaultYes ? `${C.bgrn}J${C.r}` : `${C.dim}j${C.r}`;
  const noStr  = defaultYes ? `${C.dim}n${C.r}`  : `${C.bred}N${C.r}`;

  return new Promise(resolve => {
    rl.question(
      `\n  ${SYM.arr} ${C.b}${question}${C.r} [${yesStr}/${noStr}]  ${C.cyn}›${C.r} `,
      raw => {
        const a = raw.trim().toLowerCase();
        if (!a) return resolve(defaultYes);
        resolve(['j', 'y', 'ja', 'yes'].includes(a));
      }
    );
  });
}

// ── SPINNER ───────────────────────────────────────────────────────────────────

function spinner(msg) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(`\r  ${C.cyn}${frames[i++ % frames.length]}${C.r}  ${msg}   `);
  }, 80);
  return {
    succeed(text) {
      clearInterval(iv);
      process.stdout.write(`\r  ${SYM.ok}  ${text}\n`);
    },
    fail(text) {
      clearInterval(iv);
      process.stdout.write(`\r  ${SYM.fail}  ${text}\n`);
    },
  };
}

// ── SCHRITT 1: VORAUSSETZUNGEN ────────────────────────────────────────────────

function checkPrereqs() {
  stepHeader(1, 6, 'Voraussetzungen prüfen');

  // Node.js Version
  const major = parseInt(process.version.slice(1).split('.')[0], 10);
  if (major >= 18) {
    print(`${SYM.ok}  Node.js ${process.version}  (Mindest-Version 18 erfüllt)`);
  } else {
    print(`${SYM.fail}  Node.js ${process.version}  –  Mindestens Version 18 erforderlich!`);
    print(`     ${C.dim}Bitte unter https://nodejs.org/ aktualisieren und neu starten.${C.r}`);
    process.exit(1);
  }

  // npm
  try {
    const npmVer = execSync('npm --version', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    print(`${SYM.ok}  npm ${npmVer}`);
  } catch {
    print(`${SYM.fail}  npm nicht gefunden – bitte npm installieren.`);
    process.exit(1);
  }

  // package.json vorhanden?
  if (fs.existsSync('package.json')) {
    print(`${SYM.ok}  package.json vorhanden`);
  } else {
    print(`${SYM.fail}  package.json nicht gefunden.`);
    print(`     ${C.dim}Bitte den Installer aus dem Bot-Verzeichnis heraus starten.${C.r}`);
    process.exit(1);
  }

  // Bereits installiert?
  if (fs.existsSync('.env')) {
    print(`${SYM.warn}  Eine .env-Datei existiert bereits – sie wird überschrieben.`);
  }

  nl();
  print(`${SYM.ok}  Alle Voraussetzungen erfüllt.`);
}

// ── SCHRITT 2: NPM INSTALL ────────────────────────────────────────────────────

async function installDeps(rl) {
  stepHeader(2, 6, 'Abhängigkeiten installieren');

  print(`${SYM.info}  Folgende npm-Pakete werden installiert:`);
  nl();
  print(`  ${C.dim}• discord.js                –  Discord API${C.r}`);
  print(`  ${C.dim}• axios                     –  HTTP-Anfragen an Uptime Kuma${C.r}`);
  print(`  ${C.dim}• express + ejs             –  Web-Dashboard${C.r}`);
  print(`  ${C.dim}• sequelize + sqlite3       –  Lokale Datenbank${C.r}`);
  print(`  ${C.dim}• winston + rotate-file     –  Logging mit Log-Rotation${C.r}`);
  print(`  ${C.dim}• convict                   –  Konfigurationsvalidierung${C.r}`);
  print(`  ${C.dim}• prom-client               –  Prometheus-Metriken${C.r}`);
  print(`  ${C.dim}• dotenv                    –  .env Datei laden${C.r}`);
  nl();

  const doInstall = await confirm(rl, 'npm install jetzt ausführen?', true);

  if (!doInstall) {
    print(`${SYM.warn}  Übersprungen. Bitte später manuell ${C.cyn}npm install${C.r} ausführen.`);
    return;
  }

  nl();
  print(`${SYM.info}  ${C.b}Hinweis:${C.r} Das Paket ${C.cyn}sqlite3${C.r} wird nativ kompiliert.`);
  print(`         Auf einem Raspberry Pi kann dies ${C.byel}5–15 Minuten${C.r} dauern — bitte warten.`);
  nl();
  print(`${C.dim}${'─'.repeat(60)}${C.r}`);

  await new Promise((resolve) => {
    const proc = spawn('npm', ['install'], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    const FRAMES  = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];  // Braille-Spinner
    let frame     = 0;
    let elapsed   = 0;
    let phase     = 'download';  // download | compile | finalize
    let lastPkg   = '';
    let warnCount = 0;

    const phases = {
      download: { label: 'Pakete werden heruntergeladen…', color: C.cyn },
      compile:  { label: 'Kompiliere sqlite3 (C++ → nativ) — bitte warten…', color: C.yel },
      finalize: { label: 'Abschluss & Verknüpfungen werden gesetzt…', color: C.grn },
    };

    const renderLine = () => {
      const f   = phases[phase];
      const spin = FRAMES[frame++ % FRAMES.length];
      const min  = Math.floor(elapsed / 60);
      const sec  = elapsed % 60;
      const t    = min > 0 ? `${min}m${sec.toString().padStart(2,'0')}s` : `${elapsed}s`.padStart(4);
      const sub  = (phase === 'compile')
        ? '' : lastPkg ? `  ${C.dim}${lastPkg.slice(0,45)}${C.r}` : '';
      const line = `  ${f.color}${spin}${C.r} ${C.dim}[${t}]${C.r}  ${f.color}${f.label}${C.r}${sub}`;
      // \x1b[2K = Zeile löschen, \r = Anfang — sicher in SSH+tmux+screen
      process.stdout.write(`\x1b[2K\r${line}`);
    };

    renderLine();
    const iv = setInterval(() => {
      elapsed++;
      // Alle 60s extra-Hinweis in neuer Zeile
      if (elapsed > 0 && elapsed % 60 === 0) {
        process.stdout.write(`\x1b[2K\r`);
        print(`${SYM.info}  ${elapsed}s vergangen — sqlite3-Kompilierung kann 10–15 Min dauern auf ARM`);
      }
      renderLine();
    }, 1000);

    const handleData = (data) => {
      const text = data.toString();
      for (const raw of text.split('\n')) {
        const t = raw.trim();
        if (!t) continue;
        if (/gyp info|node-pre-gyp|CXX|SOLINK|compil/i.test(t)) {
          phase = 'compile';
        } else if (/^added \d+|packages in/i.test(t)) {
          phase = 'finalize';
          lastPkg = t;
        } else if (/^npm warn/i.test(t)) {
          warnCount++;
        } else if (/^\s*\d+ packages? (added|changed)/i.test(t)) {
          lastPkg = t;
        } else if (phase === 'download' && /^(added|resolved|http)/i.test(t)) {
          lastPkg = t;
        }
      }
    };

    proc.stdout.on('data', handleData);
    proc.stderr.on('data', handleData);

    proc.on('close', (code) => {
      clearInterval(iv);
      process.stdout.write('\x1b[2K\r');
      print(`${C.dim}${'─'.repeat(60)}${C.r}`);
      nl();
      if (code === 0) {
        print(`${SYM.ok}  Alle Pakete erfolgreich installiert. ${C.dim}(${elapsed}s${warnCount ? ', ' + warnCount + ' Warnungen' : ''})${C.r}`);
      } else {
        print(`${SYM.fail}  npm install fehlgeschlagen (Exit-Code ${code}).`);
        print(`     Manuell versuchen: ${C.cyn}npm install${C.r}`);
      }
      resolve(code);
    });

    proc.on('error', (err) => {
      clearInterval(iv);
      process.stdout.write('\x1b[2K\r');
      print(`${SYM.fail}  Fehler beim Starten von npm: ${err.message}`);
      resolve(1);
    });
  }).then(async (code) => {
    if (code !== 0) {
      nl();
      const cont = await confirm(rl, 'Trotzdem mit der Konfiguration fortfahren?', false);
      if (!cont) process.exit(1);
    }
  });
}

// ── SCHRITT 3: DISCORD ────────────────────────────────────────────────────────

async function configDiscord(rl) {
  stepHeader(3, 6, 'Discord konfigurieren');

  print(`${SYM.info}  ${C.b}Wo du die benötigten Werte findest:${C.r}`);
  nl();
  print(`  ${C.dim}Bot-Token:${C.r}`);
  print(`  ${C.dim}  → https://discord.com/developers/applications${C.r}`);
  print(`  ${C.dim}  → Deine App auswählen → "Bot" → "Reset Token"${C.r}`);
  print(`  ${C.dim}  → Token niemals öffentlich teilen!${C.r}`);
  nl();
  print(`  ${C.dim}Channel-IDs:${C.r}`);
  print(`  ${C.dim}  → In Discord: Einstellungen → Erweitert → "Entwicklermodus" aktivieren${C.r}`);
  print(`  ${C.dim}  → Rechtsklick auf einen Channel → "ID kopieren"${C.r}`);
  nl();

  const token = await ask(rl, 'Discord Bot Token', '', {
    hint: 'Zu finden unter: Developer Portal → Deine App → Bot → Token',
    validate: v => v.length < 50
      ? 'Token scheint zu kurz – bitte den vollständigen Token einfügen.'
      : null,
  });

  const statusChannelId = await ask(rl, 'Status-Channel ID', '', {
    hint: 'In diesen Channel schreibt der Bot die Live-Status-Nachricht.\n'
        + 'Der Bot benötigt dort die Berechtigung: Nachrichten senden, Embeds einbetten.',
    validate: v => !/^\d{17,20}$/.test(v)
      ? 'Channel-IDs bestehen aus 17–20 Ziffern.'
      : null,
  });

  const notifChannel = await ask(rl, 'Benachrichtigungs-Channel ID', '', {
    hint: 'Hierhin sendet der Bot Alerts bei Statusänderungen eines Services.\n'
        + 'Kann dieselbe ID wie der Status-Channel sein.',
    validate: v => !/^\d{17,20}$/.test(v)
      ? 'Channel-IDs bestehen aus 17–20 Ziffern.'
      : null,
  });

  return { token, statusChannelId, notifChannel };
}

// ── SCHRITT 4: UPTIME KUMA ────────────────────────────────────────────────────

async function configUptimeKuma(rl) {
  stepHeader(4, 6, 'Uptime Kuma konfigurieren');

  print(`${SYM.info}  ${C.b}Was ist Uptime Kuma?${C.r}`);
  print(`  ${C.dim}  Ein selbst-gehostetes Monitoring-Tool, das deine Services überwacht.${C.r}`);
  print(`  ${C.dim}  Dieser Bot liest die öffentliche Status-Seite deiner Uptime Kuma Instanz aus.${C.r}`);
  nl();
  print(`  ${C.dim}Status-Page Slug:${C.r}`);
  print(`  ${C.dim}  In Uptime Kuma → Status Pages → deine Seite → der URL-Teil nach /status/${C.r}`);
  print(`  ${C.dim}  Beispiel: uptime.domain.de/status/${C.b}dienste${C.r}  ${C.dim}→ Slug ist "dienste"${C.r}`);
  nl();

  const url = await ask(rl, 'Uptime Kuma Basis-URL', '', {
    hint: 'Beispiel: http://uptime.meinedomain.de  (kein abschließendes /)',
    validate: v => {
      try { new URL(v); return null; }
      catch { return 'Keine gültige URL – mit http:// oder https:// beginnen.'; }
    },
  });

  const apiKey = await ask(rl, 'Uptime Kuma API Key  (optional – Enter zum Überspringen)', '', {
    hint: 'Nur nötig wenn deine Status-Seite passwortgeschützt ist.\n'
        + 'Zu finden in Uptime Kuma → Einstellungen → API Keys.',
    required: false,
  });

  const slug = await ask(rl, 'Status-Page Slug', 'dienste', {
    hint: 'Nur Kleinbuchstaben, Zahlen und Bindestriche erlaubt.',
    validate: v => !/^[a-z0-9-]+$/.test(v)
      ? 'Nur Kleinbuchstaben, Zahlen und Bindestriche (a-z, 0-9, -) erlaubt.'
      : null,
  });

  return { url, apiKey, slug };
}

// ── SCHRITT 5: OPTIONALE EINSTELLUNGEN ────────────────────────────────────────

async function configOptional(rl) {
  stepHeader(5, 6, 'Optionale Einstellungen');

  print(`${SYM.info}  Alle Felder haben sinnvolle Standardwerte.`);
  print(`  ${C.dim}  Einfach Enter drücken, um den Standardwert zu übernehmen.${C.r}`);
  nl();

  const interval = await ask(rl, 'Update-Intervall  (in Millisekunden)', '300000', {
    hint: '300000 ms = 5 Minuten  |  Nicht unter 60000 ms (1 Min) empfohlen,\n'
        + 'da Discord sonst Rate-Limits verhängt.',
    validate: v => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 10000) return 'Mindestens 10000 ms (10 Sekunden).';
      return null;
    },
  });

  const port = await ask(rl, 'Web-Dashboard Port', '3000', {
    hint: 'Port für das lokale Web-Interface → http://localhost:PORT/dashboard',
    validate: v => {
      const n = parseInt(v, 10);
      if (isNaN(n) || n < 1 || n > 65535) return 'Ungültiger Port (1–65535).';
      return null;
    },
  });

  const dashPassword = await ask(rl, 'Dashboard-Passwort  (optional – Enter zum Überspringen)', '', {
    hint: 'Schützt /dashboard mit HTTP Basic Auth.\n'
        + 'Leer lassen = kein Passwortschutz (nur für interne Netze empfohlen).',
    required: false,
  });

  const dbPath = await ask(rl, 'Datenbankpfad', './data/status.db', {
    hint: 'Pfad zur SQLite-Datenbankdatei – Standard ist empfohlen.',
  });

  nl();
  print(`${SYM.info}  ${C.b}Cloudflare Tunnel (optional):${C.r}`);
  print(`  ${C.dim}  Der Bot postet die Uptime Kuma Status-Seite als Discord Link-Preview.${C.r}`);
  print(`  ${C.dim}  Damit Discord die Seite einbetten kann, muss sie öffentlich erreichbar${C.r}`);
  print(`  ${C.dim}  sein → empfohlen über einen Cloudflare Tunnel.${C.r}`);
  nl();
  print(`  ${C.dim}  Einrichten: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/${C.r}`);
  print(`  ${C.dim}  Kurzfassung: cloudflared tunnel create bockis-bot${C.r}`);
  print(`  ${C.dim}              cloudflared tunnel route dns bockis-bot status.deinedomain.de${C.r}`);
  nl();

  // Prüfen ob cloudflared bereits installiert ist
  let cloudflaredInstalled = false;
  try {
    execSync('cloudflared --version', { stdio: 'ignore' });
    cloudflaredInstalled = true;
    print(`${SYM.ok}  cloudflared ist bereits installiert.`);
  } catch {
    print(`${SYM.warn}  cloudflared ist ${C.byel}nicht${C.r} installiert.`);
    print(`  ${C.dim}  Raspi-Installation: curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared${C.r}`);
  }
  nl();

  const cloudflareUrl = await ask(rl, 'Cloudflare Tunnel URL  (optional – Enter zum Überspringen)', '', {
    hint: 'Öffentliche URL deines Tunnels, z.B. https://status.deinedomain.de\n'
        + 'Leer lassen = kein Discord Link-Preview (Bot postet interne URL).',
    required: false,
    validate: v => {
      if (!v) return null;
      try { const u = new URL(v); return u.protocol === 'https:' ? null : 'Muss mit https:// beginnen (Cloudflare liefert immer HTTPS).'; }
      catch { return 'Keine gültige URL – mit https:// beginnen.'; }
    },
  });

  return { interval, port, dashPassword, dbPath, cloudflareUrl };
}

// ── SCHRITT 6: ABSCHLUSS ──────────────────────────────────────────────────────

async function finalize(rl, discord, kuma, optional) {
  stepHeader(6, 6, 'Einrichtung abschließen');

  // .env schreiben
  const envContent = [
    '# ── Discord ─────────────────────────────────────────────────────────────────',
    `DISCORD_TOKEN=${discord.token}`,
    `STATUS_CHANNEL_ID=${discord.statusChannelId}`,
    `DISCORD_NOTIFICATION_CHANNEL=${discord.notifChannel}`,
    '# Channel-Name automatisch mit Statusfarbe (🟢/🟡/🔴) aktualisieren',
    '# Render-Modus fuer Discord-Status: auto = Link-Preview bevorzugen, embed = Fallback-Embed erzwingen',
    'DISCORD_STATUS_RENDER_MODE=auto',
    'CHANNEL_STATUS_INDICATOR=true',
    '',
    '# ── Uptime Kuma ─────────────────────────────────────────────────────────────',
    `UPTIME_KUMA_URL=${kuma.url}`,
    `UPTIME_KUMA_API_KEY=${kuma.apiKey}`,
    `STATUS_PAGE_SLUG=${kuma.slug}`,
    '',
    '# ── Timing ──────────────────────────────────────────────────────────────────',
    `UPDATE_INTERVAL=${optional.interval}`,
    '',
    '# ── Webserver ────────────────────────────────────────────────────────────────',
    `WEB_PORT=${optional.port}`,
    `DASHBOARD_PASSWORD=${optional.dashPassword}`,
    '',
    '# ── Datenbank ────────────────────────────────────────────────────────────────',
    'DB_DIALECT=sqlite',
    `DB_STORAGE=${optional.dbPath}`,
    '',
    '# ── Cloudflare Tunnel ────────────────────────────────────────────────────────',
    '# Öffentliche URL des Cloudflare Tunnels (z.B. https://status.deinedomain.de)',
    '# Leer lassen wenn kein Tunnel verwendet wird.',
    `CLOUDFLARE_PUBLIC_URL=${optional.cloudflareUrl || ''}`,
  ].join('\n');

  try {
    fs.writeFileSync('.env', envContent, 'utf8');
    print(`${SYM.ok}  .env-Datei erstellt`);
  } catch (e) {
    print(`${SYM.fail}  .env konnte nicht geschrieben werden: ${e.message}`);
  }

  // Verzeichnisse anlegen
  for (const dir of ['data', 'logs']) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      print(`${SYM.ok}  Verzeichnis "./${dir}/" angelegt`);
    } catch (e) {
      print(`${SYM.warn}  "./${dir}/" konnte nicht angelegt werden: ${e.message}`);
    }
  }

  nl();
  nl();
  console.log(box([
    '',
    `${C.bgrn}${C.b}   ✔  Installation erfolgreich abgeschlossen!${C.r}`,
    '',
    `${C.dim}   Konfiguration gespeichert in: .env${C.r}`,
    '',
  ]));
  nl();

  // Zusammenfassung
  print(`${C.b}Deine Konfiguration im Überblick:${C.r}`);
  nl();
  const tokenPreview = discord.token.slice(0, 12) + '...' + discord.token.slice(-4);
  print(`  ${C.dim}Discord Token:${C.r}       ${tokenPreview}`);
  print(`  ${C.dim}Status-Channel:${C.r}      ${discord.statusChannelId}`);
  print(`  ${C.dim}Notif.-Channel:${C.r}      ${discord.notifChannel}`);
  print(`  ${C.dim}Uptime Kuma URL:${C.r}     ${kuma.url}`);
  print(`  ${C.dim}Status-Page Slug:${C.r}    ${kuma.slug}`);
  print(`  ${C.dim}Update-Intervall:${C.r}    ${Math.round(parseInt(optional.interval) / 1000)}s`);
  print(`  ${C.dim}Dashboard-Port:${C.r}      ${optional.port}`);
  print(`  ${C.dim}Dashboard-Passwort:${C.r}  ${optional.dashPassword ? `${SYM.ok} gesetzt` : `${SYM.warn} nicht gesetzt`}`);
  print(`  ${C.dim}Cloudflare URL:${C.r}      ${optional.cloudflareUrl || `${SYM.warn} nicht konfiguriert (kein Link-Preview)`}`);
  nl();
  console.log(`  ${hr('─', 58)}`);
  nl();

  // Nächste Schritte
  print(`${C.b}Nächste Schritte:${C.r}`);
  nl();
  print(`  ${SYM.arr}  ${C.b}Bot direkt starten:${C.r}`);
  print(`     ${C.cyn}npm start${C.r}`);
  nl();
  print(`  ${SYM.arr}  ${C.b}Entwicklungsmodus (mit Auto-Reload):${C.r}`);
  print(`     ${C.cyn}npm run dev${C.r}`);
  nl();
  print(`  ${SYM.arr}  ${C.b}Mit Docker (empfohlen für Produktion):${C.r}`);
  print(`     ${C.cyn}docker compose up -d${C.r}`);
  nl();
  print(`  ${SYM.arr}  ${C.b}Web-Dashboard aufrufen:${C.r}`);
  print(`     ${C.cyn}http://localhost:${optional.port}/dashboard${C.r}`);
  nl();
  console.log(`  ${hr('─', 58)}`);
  nl();
  print(`${C.dim}  Hinweis: Der Bot registriert Slash-Commands automatisch beim ersten Start.${C.r}`);
  print(`${C.dim}  Es kann bis zu 1 Stunde dauern, bis sie in Discord erscheinen.${C.r}`);
  nl();
  print(`${C.dim}  Viel Spaß mit dem Bot! 🤖${C.r}`);
  nl();
}

// ── MAIN ──────────────────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
  });

  rl.on('close', () => {
    console.log('\n\n  Installation abgebrochen.\n');
    process.exit(0);
  });

  try {
    banner();

    // Intro-Text
    print(`${SYM.info}  Dieser Assistent richtet den ${C.b}Bockis Discord Bot${C.r} vollständig ein.`);
    print(`${SYM.info}  Mit ${C.b}Ctrl+C${C.r} kannst du die Installation jederzeit abbrechen.`);
    nl();
    print(`${C.b}  Ablauf:${C.r}`);
    nl();
    print(`  ${C.dim}  1/6  Voraussetzungen prüfen${C.r}`);
    print(`  ${C.dim}  2/6  Abhängigkeiten installieren  (npm install)${C.r}`);
    print(`  ${C.dim}  3/6  Discord-Bot-Token & Channels eingeben${C.r}`);
    print(`  ${C.dim}  4/6  Uptime Kuma URL & Status-Page konfigurieren${C.r}`);
    print(`  ${C.dim}  5/6  Optionale Einstellungen  (Intervall, Port, Passwort …)${C.r}`);
    print(`  ${C.dim}  6/6  .env-Datei erstellen & fertigstellen${C.r}`);
    nl();

    const start = await confirm(rl, 'Installation jetzt starten?', true);
    if (!start) {
      nl();
      print(`Installation abgebrochen.`);
      nl();
      process.exit(0);
    }

    checkPrereqs();
    await installDeps(rl);
    const discord  = await configDiscord(rl);
    const kuma     = await configUptimeKuma(rl);
    const optional = await configOptional(rl);
    await finalize(rl, discord, kuma, optional);

  } catch (e) {
    nl();
    print(`${SYM.fail}  Unerwarteter Fehler: ${e.message}`);
    if (process.env.DEBUG) console.error(e);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
