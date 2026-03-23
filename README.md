# 🤖 Bockis Discord Bot

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-green.svg)](https://nodejs.org)
[![Version](https://img.shields.io/badge/version-1.1.0-informational.svg)](https://github.com/ReXx09/Bockis_Discord-Bot/releases)

Ein Discord-Bot zur Echtzeit-Überwachung deiner Services via **Uptime Kuma**.  
Er postet automatisch eine Live-Status-Nachricht in einen Discord-Channel und benachrichtigt bei Statusänderungen.

---

## ✨ Features

| Feature | Beschreibung |
|---------|-------------|
| 📡 Live-Status | Pinnt eine Embed-Nachricht mit allen Service-Statusseiten in Discord |
| 🔔 Benachrichtigungen | Sendet Alerts bei Service-Ausfall oder Wiederherstellung |
| 💬 Slash-Commands | `/status`, `/uptime`, `/refresh` direkt in Discord |
| 📈 Web-Dashboard | Übersicht aller Checks unter `http://localhost:3000/dashboard` |
| 📊 Prometheus | Metriken unter `/metrics` für Grafana & Co. |
| 🗄️ Datenbank | Speichert Checks lokal in SQLite (automatisches Cleanup nach 30 Tagen) |
| 🔄 Log-Rotation | Logs werden täglich rotiert und nach 14 Tagen gelöscht |

---

## 🗂️ Projektstruktur

```
.
├── bot.js                 # Haupt-Bot-Code
├── install.js             # Interaktiver TUI-Installer
├── config/
│   └── config.js          # Konfigurationsschema (convict)
├── models/
│   └── MonitorStatus.js   # Datenbankmodell
├── views/
│   └── dashboard.ejs      # Web-Dashboard Template
├── tests/
│   └── integration.test.js
├── docker-compose.yml
├── .env.example           # Vorlage für die Konfiguration
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

### ⚡ Schnellstart (empfohlen)

Alle Schritte (Node.js, Konfiguration, systemd) laufen automatisch ab:

```bash
# Repo klonen & Skript starten
git clone https://github.com/ReXx09/Bockis_Discord-Bot.git bockis-bot
cd bockis-bot
bash start-bot.sh
```

> Optional: Zielverzeichnis anpassen mit `bash start-bot.sh --bot-dir /pfad/zum/bot`

Das Skript erledigt automatisch: Systempaket-Update → Node.js LTS → `node install.js` (TUI-Konfiguration) → systemd-Service.

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

### Option: Mit Docker auf dem Raspberry Pi

Falls Docker auf dem Pi installiert ist:

```bash
# Docker installieren (falls noch nicht vorhanden)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker pi
# Einloggen & ausloggen oder:
newgrp docker

# Bot starten
docker compose up -d

# Logs anschauen
docker compose logs -f
```

> **Hinweis:** Docker auf dem Raspi Pi 3 kann langsam sein.  
> Für Pi 4 / Pi 5 ist Docker problemlos nutzbar.

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