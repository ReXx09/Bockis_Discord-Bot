# 🤖 Bockis Discord Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-1.1.0-informational.svg)](https://github.com/ReXx09/Bockis_Discord-Bot/releases)
[![Platform](https://img.shields.io/badge/platform-Raspberry%20Pi%20%7C%20Linux-lightgrey.svg)](https://www.raspberrypi.org)
[![Uptime Kuma](https://img.shields.io/badge/powered%20by-Uptime%20Kuma-blueviolet.svg)](https://github.com/louislam/uptime-kuma)

> **Echtzeit-Monitoring für deinen Discord-Server — powered by Uptime Kuma.**

Bockis Discord Bot verbindet deine **Uptime Kuma**-Instanz mit Discord und hält deinen Server immer auf dem Laufenden: Er postet eine automatisch aktualisierte Live-Status-Nachricht, sendet Alerts bei Ausfällen und stellt Slash-Commands, ein Web-Dashboard sowie Prometheus-Metriken bereit.

Optimiert für den Betrieb auf dem **Raspberry Pi** — mit interaktivem Installer, whiptail-Verwaltungsmenü, automatischem Update-Skript und systemd-Integration.

---

## ✨ Features

| Feature | Beschreibung |
|---|---|
| 📡 Live-Status | Automatisch aktualisierte Embed-Nachricht mit Status aller überwachten Services |
| 🔔 Benachrichtigungen | Sofort-Alerts in Discord bei Service-Ausfall und Wiederherstellung |
| 💬 Slash-Commands | `/status`, `/uptime`, `/refresh` — direkt in Discord nutzbar |
| 📈 Web-Dashboard | Statusübersicht aller Checks unter `http://localhost:3000/dashboard` (passwortgeschützt) |
| 📊 Prometheus-Metriken | Metriken unter `/metrics` für Grafana, Prometheus & Co. |
| 🗄️ SQLite-Datenbank | Speichert Checks lokal, automatisches Cleanup nach 30 Tagen |
| 🔄 Log-Rotation | Tägliche Log-Rotation, automatische Löschung nach 14 Tagen |
| 🔁 Retry-Logik | 3 Versuche mit exponentiellem Backoff bei API-Fehlern |
| ⚡ Rate-Limit-Schutz | Mindestabstand zwischen Discord-Edits verhindert API-Sperren |
| 💾 State-Persistenz | `statusMessageId` bleibt auch nach Bot-Neustart erhalten |
| 🛡️ Endpoint-Sicherheit | `/metrics` und `/health` nur lokal erreichbar (`localOnly`-Middleware) |
| 🍓 Raspi-Verwaltungsmenü | whiptail-Menü für System-Setup, Uptime Kuma, Updates und Statusprüfungen |
| 🔧 TUI-Installer | Geführte Ersteinrichtung ohne manuelle Dateibearbeitung (`node install.js`) |
| 🔄 Auto-Updater | `update.sh` aktualisiert Bot und Docker-Container in einem Schritt |

---

## 🗂️ Projektstruktur

```
.
├── bot.js                  # Haupt-Bot-Code
├── install.js              # Interaktiver TUI-Installer
├── start-bot.sh            # System-Setup für Raspberry Pi (Node.js, systemd)
├── update.sh               # Auto-Updater (native systemd & Docker)
├── raspi-menu.sh           # Interaktives whiptail-Verwaltungsmenü
├── docker-compose.yml      # Docker-Deployment
├── config/
│   └── config.js           # Konfigurationsschema (convict)
├── models/
│   └── MonitorStatus.js    # SQLite-Datenbankmodell
├── views/
│   └── dashboard.ejs       # Web-Dashboard Template
├── tests/
│   └── integration.test.js
├── .env.example            # Vorlage für die Konfiguration
└── README.md
```

---

## 🚀 Installation

### Option A – Interaktiver Installer (empfohlen)

Der einfachste Weg. Führe im Bot-Verzeichnis aus:

```bash
node install.js
```

Der Assistent führt dich Schritt für Schritt durch:
1. Prüft Voraussetzungen (Node.js, npm)
2. Installiert alle Abhängigkeiten
3. Fragt Discord-Token, Channel-IDs, Uptime Kuma URL ab
4. Erstellt die `.env`-Datei automatisch

---

### Option B – Manuell

```bash
# 1. Abhängigkeiten installieren
npm install

# 2. Konfigurationsdatei erstellen
cp .env.example .env

# 3. .env mit einem Editor öffnen und befüllen
nano .env          # Linux / Raspberry Pi
notepad .env       # Windows

# 4. Bot starten
npm start
```

---

## 🍓 Deployment auf dem Raspberry Pi

### ⚡ Schnellstart mit dem Verwaltungsmenü (empfohlen)

Das interaktive **whiptail-Menü** führt dich durch alle Schritte:

```bash
git clone https://github.com/ReXx09/Bockis_Discord-Bot.git bockis-bot
cd bockis-bot
bash raspi-menu.sh
```

Das Menü bietet:

| Bereich | Was du damit tun kannst |
|---|---|
| 🍓 System vorbereiten | apt-Update, Node.js LTS, Docker, Firewall, Swap, Zeitzone |
| 📊 Uptime Kuma | Docker-Installation, Start/Stop, Update, Logs |
| 🤖 Bot-Verwaltung | Installieren, Update, Start/Stop, Logs, Health-Check |
| 🔍 Status & Prüfungen | Services, Container, CPU/RAM/Temp, Ports, Netzwerk |
| 🔄 Schnell-Update | Bot + Docker in einem Schritt aktualisieren |

> Alternativ ohne Menü: `bash start-bot.sh` führt direkt die Installation durch.

---

### Manuelle Installation (Schritt für Schritt)

### Voraussetzungen

- Raspberry Pi mit **Raspberry Pi OS** (Lite oder Desktop, 64-bit empfohlen)
- Internetverbindung
- SSH-Zugang oder direktes Terminal

---

### Schritt 1 – Node.js installieren

Raspberry Pi OS enthält oft eine veraltete Node.js-Version. Wir installieren die aktuellste LTS-Version via **NodeSource**:

```bash
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Version prüfen (muss ≥ 18 sein):

```bash
node --version   # z.B. v20.x.x
npm --version
```

---

### Schritt 2 – Git installieren & Repo klonen

```bash
# Git installieren (falls noch nicht vorhanden)
sudo apt-get install -y git

# Repo klonen
git clone https://github.com/DEIN-USERNAME/Bockis_Discord-Bot.git
cd Bockis_Discord-Bot
```

> **Kein Git-Repository?**  
> Du kannst das Projekt auch als ZIP herunterladen, auf den Pi übertragen und entpacken:
>
> ```bash
> # Auf dem Pi entpacken (Beispiel)
> unzip Bockis_Discord-Bot-1.0.0.zip
> cd Bockis_Discord-Bot-1.0.0
> ```
>
> Oder per `scp` vom Windows-PC auf den Pi kopieren:
>
> ```powershell
> # Auf deinem Windows-PC (PowerShell)
> scp -r "C:\Users\ReXx\Desktop\Bockis_Discord-Bot-1.0.0\Bockis_Discord-Bot-1.0.0" pi@RASPI-IP:/home/pi/bockis-bot
> ```

---

### Schritt 3 – Bot einrichten

```bash
# Ins Bot-Verzeichnis wechseln
cd /home/pi/bockis-bot

# Interaktiven Installer starten
node install.js
```

Der Installer führt dich automatisch durch die gesamte Konfiguration.

---

### Schritt 4 – Bot dauerhaft laufen lassen (systemd)

> **Tipp:** Bei Nutzung von `start-bot.sh` wird der systemd-Service automatisch eingerichtet — Schritt 4 kann übersprungen werden.

Damit der Bot automatisch startet und bei Absturz neu gestartet wird:

```bash
sudo tee /etc/systemd/system/bockis-bot.service > /dev/null <<EOF
[Unit]
Description=Bockis Discord Uptime Bot
Documentation=https://github.com/ReXx09/Bockis_Discord-Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=/home/pi/bockis-bot
EnvironmentFile=/home/pi/bockis-bot/.env
ExecStart=$(command -v node) /home/pi/bockis-bot/bot.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=bockis-bot

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable bockis-bot
sudo systemctl start bockis-bot
sudo systemctl status bockis-bot
```

Nützliche Befehle:

```bash
sudo systemctl stop bockis-bot      # Bot stoppen
sudo systemctl restart bockis-bot   # Bot neu starten
sudo journalctl -u bockis-bot -f    # Live-Logs anzeigen
```

---

### 🔄 Bot aktualisieren (native)

```bash
cd ~/bockis-bot

# Automatische Erkennung (native oder Docker)
bash update.sh

# Oder explizit für native systemd-Installation
bash update.sh --mode native

# Ohne Bestätigungsdialog
bash update.sh --yes
```

Das Skript erledigt automatisch: git pull → npm ci → Service-Neustart. Eine `.env`-Sicherungskopie wird vor jedem Update angelegt.

---

### Option: Mit Docker auf dem Raspberry Pi

Falls Docker auf dem Pi installiert ist:

```bash
# Docker installieren (falls noch nicht vorhanden)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker pi
# Einloggen & ausloggen oder:
newgrp docker

# Bot starten
cd ~/bockis-bot
docker compose up -d

# Logs anschauen
docker compose logs -f
```

> **Hinweis:** Docker auf dem Raspi Pi 3 kann langsam sein.  
> Für Pi 4 / Pi 5 ist Docker problemlos nutzbar.

### 🔄 Docker-Container aktualisieren

```bash
cd ~/bockis-bot

# Automatische Erkennung — findet Docker falls Container laufen
bash update.sh

# Oder explizit Docker-Modus
bash update.sh --mode docker

# Ohne Bestätigungsdialog (z.B. in Cron)
bash update.sh --mode docker --yes
```

Das Skript pullt neue Images, baut den Bot-Container neu, führt den Health-Check durch und räumt alte Images auf. Eine `.env`-Sicherungskopie wird vor jedem Update angelegt.

**Automatische Updates per Cron:**
```bash
# Jeden Sonntag um 03:00 Uhr automatisch updaten
crontab -e
# Folgende Zeile einfügen:
0 3 * * 0 cd $HOME/bockis-bot && bash update.sh --yes >> $HOME/bockis-bot/logs/update.log 2>&1
```

---

## 📋 Kurzbefehle (Cheat Sheet)

### Verwaltungsmenü (empfohlen)

```bash
bash ~/bockis-bot/raspi-menu.sh        # Interaktives Hauptmenü öffnen
```

### Bot-Service (systemd)

```bash
sudo systemctl start   bockis-bot      # Bot starten
sudo systemctl stop    bockis-bot      # Bot stoppen
sudo systemctl restart bockis-bot      # Bot neu starten
sudo systemctl status  bockis-bot      # Status anzeigen
sudo systemctl enable  bockis-bot      # Autostart aktivieren
sudo systemctl disable bockis-bot      # Autostart deaktivieren
```

### Logs

```bash
sudo journalctl -u bockis-bot -f       # Live-Logs (systemd)
sudo journalctl -u bockis-bot -n 50   # Letzte 50 Zeilen
tail -f ~/bockis-bot/logs/*.log        # Bot-Logdatei live
```

### Update

```bash
bash ~/bockis-bot/update.sh            # Auto-Update (erkennt native/Docker)
bash ~/bockis-bot/update.sh --mode native   # Nur systemd (git pull + npm ci)
bash ~/bockis-bot/update.sh --mode docker   # Nur Docker-Container
bash ~/bockis-bot/update.sh --yes      # Ohne Bestätigungsdialog (Cron)
```

### Uptime Kuma (Docker)

```bash
docker start  uptime-kuma             # Starten
docker stop   uptime-kuma             # Stoppen
docker restart uptime-kuma            # Neu starten
docker logs   uptime-kuma -f          # Live-Logs
docker pull louislam/uptime-kuma:latest && \
  docker stop uptime-kuma && docker rm uptime-kuma && \
  docker run -d --name uptime-kuma --restart=unless-stopped \
    -p 3001:3001 -v ~/uptime-kuma-data:/app/data \
    louislam/uptime-kuma:latest        # Manuelles Update
```

### Health-Check & Status

```bash
curl http://localhost:3000/health      # Bot Health-Endpunkt
systemctl is-active bockis-bot        # Nur Status (aktiv/inaktiv)
docker ps                             # Laufende Container
ss -tlnp | grep -E '3000|3001'       # Ports prüfen
cat /sys/class/thermal/thermal_zone0/temp  # CPU-Temperatur (Raspi)
```

### Neu installieren / zurücksetzen

```bash
# Service entfernen (Dateien bleiben):
sudo systemctl stop bockis-bot && sudo systemctl disable bockis-bot
sudo rm /etc/systemd/system/bockis-bot.service && sudo systemctl daemon-reload

# Neu einrichten:
bash ~/bockis-bot/start-bot.sh
```

---

## ⚙️ Konfiguration (.env)

| Variable | Pflicht | Beschreibung |
|----------|---------|-------------|
| `DISCORD_TOKEN` | ✅ | Bot-Token aus dem [Discord Developer Portal](https://discord.com/developers/applications) |
| `STATUS_CHANNEL_ID` | ✅ | Channel-ID für die Live-Status-Nachricht |
| `DISCORD_NOTIFICATION_CHANNEL` | ✅ | Channel-ID für Statusänderungs-Alerts |
| `UPTIME_KUMA_URL` | ✅ | Basis-URL der Uptime Kuma Instanz |
| `UPTIME_KUMA_API_KEY` | ❌ | API-Key (nur bei passwortgeschützter Status-Seite) |
| `STATUS_PAGE_SLUG` | ❌ | Slug der Status-Seite (Standard: `dienste`) |
| `UPDATE_INTERVAL` | ❌ | Update-Intervall in ms (Standard: `300000` = 5 Min) |
| `WEB_PORT` | ❌ | Port für das Dashboard (Standard: `3000`) |
| `DASHBOARD_PASSWORD` | ❌ | Passwort für `/dashboard` (leer = kein Schutz) |
| `DB_STORAGE` | ❌ | Pfad zur SQLite-Datei (Standard: `./data/status.db`) |

---

## 💬 Slash-Commands

| Befehl | Berechtigung | Beschreibung |
|--------|-------------|-------------|
| `/status` | Alle | Zeigt alle Services mit Uptime als Embed |
| `/uptime` | Alle | Zeigt die Gesamt-Uptime aus der Datenbank |
| `/refresh` | ManageGuild | Erzwingt sofortigen Status-Update |

> Slash-Commands werden beim ersten Bot-Start automatisch registriert.  
> Es kann bis zu **1 Stunde** dauern, bis sie in Discord erscheinen.

---

## 🌐 Web-Endpunkte

| Endpoint | Zugriff | Beschreibung |
|----------|---------|-------------|
| `/dashboard` | Öffentlich (optionaler Passwortschutz) | Status-Übersicht der letzten 50 Checks |
| `/health` | Nur lokal (127.0.0.1) | Systemstatus: DB + Discord-Verbindung |
| `/metrics` | Nur lokal (127.0.0.1) | Prometheus-Metriken |

---

## 🛠️ Entwicklung

```bash
# Bot mit automatischem Reload starten
npm run dev

# Tests ausführen
npm test
```

---

## 📋 Voraussetzungen

- **Node.js** ≥ 18.0.0
- **Uptime Kuma** Instanz mit einer öffentlichen Status-Seite
- **Discord-Bot** mit folgenden Berechtigungen:
  - `Send Messages`
  - `Embed Links`
  - `Read Message History`
  - Slash-Commands: `applications.commands`

---

## 📜 Lizenz

Dieses Projekt steht unter der **MIT-Lizenz**. Siehe [LICENSE](LICENSE) für alle Details.

```
Copyright (c) 2026 ReXx09 (https://github.com/ReXx09)
```