#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 ReXx09 (https://github.com/ReXx09)
#
# start-bot.sh — Raspberry Pi / Debian / Ubuntu System-Setup
# Installiert Node.js LTS, richtet den Bot-Ordner ein und konfiguriert
# einen systemd-Service. Die interaktive Bot-Konfiguration übernimmt
# danach automatisch der TUI-Installer (node install.js).
#
# Voraussetzungen: Debian/Ubuntu/Raspberry Pi OS, sudo-Rechte, curl
# Ausführung:      bash start-bot.sh [--bot-dir /pfad/zum/bot]

set -euo pipefail

# ── Farben & Hilfsfunktionen ─────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_header()  { echo -e "\n${BOLD}${CYAN}━━ $1 ━━${NC}"; }
print_status()  { echo -e "${YELLOW}  →${NC} $1"; }
print_success() { echo -e "${GREEN}  ✓${NC} $1"; }
print_error()   { echo -e "${RED}  ✗ Fehler:${NC} $1" >&2; }
die()           { print_error "$1"; exit 1; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║     Bockis Discord Bot — System-Setup    ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ── Argument-Parsing ─────────────────────────────────────────────────────────
BOT_DIR="$HOME/bockis-bot"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-dir) BOT_DIR="$2"; shift 2 ;;
    *) die "Unbekannte Option: $1. Verwendung: bash start-bot.sh [--bot-dir /pfad]" ;;
  esac
done

# ── 1. Systemprüfung ─────────────────────────────────────────────────────────
print_header "1. Systemprüfung"

if [[ "$EUID" -eq 0 ]]; then
  die "Bitte nicht als root ausführen. Nutze einen normalen User mit sudo-Rechten."
fi

command -v apt-get >/dev/null 2>&1 || die "apt-get nicht gefunden. Dieses Skript benötigt Debian/Ubuntu/Raspberry Pi OS."
command -v curl   >/dev/null 2>&1 || die "curl ist nicht installiert. Bitte zuerst: sudo apt-get install -y curl"

print_success "System kompatibel ($(lsb_release -ds 2>/dev/null || uname -sr))"

# ── 2. Systemaktualisierung ──────────────────────────────────────────────────
print_header "2. Systempakete aktualisieren"
print_status "sudo apt-get update && apt-get upgrade ..."
sudo apt-get update -qq
sudo apt-get upgrade -y -qq
print_success "Systempakete aktualisiert"

# ── 3. Node.js LTS installieren ──────────────────────────────────────────────
print_header "3. Node.js LTS installieren"

NODE_OK=false
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null && echo "ok" || echo "alt")
  if [[ "$NODE_VER" == "ok" ]]; then
    print_success "Node.js $(node -v) bereits installiert — wird übersprungen"
    NODE_OK=true
  else
    print_status "Node.js $(node -v) zu alt, aktualisiere auf LTS..."
  fi
fi

if [[ "$NODE_OK" == "false" ]]; then
  print_status "Installiere Node.js LTS via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - >/dev/null 2>&1
  sudo apt-get install -y nodejs >/dev/null 2>&1
  print_success "Node.js $(node -v) installiert"
fi

# npm sicherstellen
command -v npm >/dev/null 2>&1 || die "npm fehlt nach Node.js-Installation. Bitte manuell prüfen."
print_success "npm $(npm -v) verfügbar"

# ── 4. Bot-Verzeichnis einrichten ────────────────────────────────────────────
print_header "4. Bot-Verzeichnis einrichten"

if [[ ! -d "$BOT_DIR" ]]; then
  print_status "Erstelle Verzeichnis $BOT_DIR ..."
  mkdir -p "$BOT_DIR"
  print_success "Verzeichnis erstellt"
else
  print_success "Verzeichnis $BOT_DIR bereits vorhanden"
fi

# Prüfen ob bot.js vorhanden ist (Dateien müssen vorher kopiert/geclont werden)
if [[ ! -f "$BOT_DIR/bot.js" ]]; then
  echo ""
  echo -e "${YELLOW}  Bitte die Bot-Dateien in ${BOLD}$BOT_DIR${NC}${YELLOW} ablegen.${NC}"
  echo "  Optionen:"
  echo "    git clone  https://github.com/ReXx09/Bockis_Discord-Bot.git $BOT_DIR"
  echo "    scp -r     ./Bockis_Discord-Bot-v1.1.0/* pi@<IP>:$BOT_DIR/"
  echo ""
  read -rp "  Dateien bereitstellen und dann Enter drücken ..."

  [[ -f "$BOT_DIR/bot.js" ]] || die "bot.js nicht in $BOT_DIR gefunden. Bitte Dateien korrekt kopieren."
fi

print_success "Bot-Dateien gefunden in $BOT_DIR"

# ── 5. TUI-Installer ausführen ───────────────────────────────────────────────
print_header "5. Interaktive Konfiguration (TUI-Installer)"
print_status "Starte node install.js für geführte Einrichtung..."
echo ""

cd "$BOT_DIR"
node install.js

# .env muss nach install.js vorhanden sein
[[ -f "$BOT_DIR/.env" ]] || die ".env wurde nicht erstellt. Bitte install.js erneut ausführen."
print_success "Konfiguration abgeschlossen"

# ── 6. Systemd-Service einrichten ────────────────────────────────────────────
print_header "6. Systemd-Service einrichten"

NODE_BIN=$(command -v node)
SERVICE_FILE=/etc/systemd/system/bockis-bot.service

print_status "Erstelle $SERVICE_FILE ..."
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=Bockis Discord Uptime Bot
Documentation=https://github.com/ReXx09/Bockis_Discord-Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$BOT_DIR
EnvironmentFile=$BOT_DIR/.env
ExecStart=$NODE_BIN $BOT_DIR/bot.js
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
sudo systemctl restart bockis-bot
print_success "Systemd-Service 'bockis-bot' gestartet und aktiviert"

# ── 7. Abschluss ─────────────────────────────────────────────────────────────
BOT_IP=$(hostname -I | awk '{print $1}')
WEB_PORT=$(grep -oP '(?<=WEB_PORT=)\d+' "$BOT_DIR/.env" 2>/dev/null || echo 3000)

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗"
echo -e "║   Bockis Bot erfolgreich installiert!   ║"
echo -e "╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}Service-Befehle:${NC}"
echo "  sudo systemctl status  bockis-bot"
echo "  sudo systemctl restart bockis-bot"
echo "  sudo systemctl stop    bockis-bot"
echo "  sudo journalctl -u bockis-bot -f"
echo ""
echo -e "${BOLD}Web-Oberfläche (nur lokal):${NC}"
echo "  Dashboard:  http://${BOT_IP}:${WEB_PORT}/dashboard"
echo "  Health:     http://${BOT_IP}:${WEB_PORT}/health"
echo "  Metrics:    http://${BOT_IP}:${WEB_PORT}/metrics"
echo ""
