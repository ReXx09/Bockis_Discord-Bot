#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 ReXx09 (https://github.com/ReXx09)
#
# update.sh — Bockis Discord Bot Updater
# Aktualisiert den Bot und/oder die Docker-Container auf die neueste Version.
# Unterstützt native systemd-Installation und Docker-Compose-Deployment.
#
# Voraussetzungen: git, curl, (docker compose für Docker-Modus)
# Ausführung:      bash update.sh [--mode auto|native|docker] [--bot-dir /pfad]

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
print_warn()    { echo -e "${YELLOW}  ⚠${NC} $1"; }
print_error()   { echo -e "${RED}  ✗ Fehler:${NC} $1" >&2; }
die()           { print_error "$1"; exit 1; }

# ── Banner ───────────────────────────────────────────────────────────────────
echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════╗"
echo "  ║     Bockis Discord Bot — Updater         ║"
echo "  ╚══════════════════════════════════════════╝"
echo -e "${NC}"

# ── Argument-Parsing ─────────────────────────────────────────────────────────
BOT_DIR="$HOME/bockis-bot"
MODE="auto"
SKIP_CONFIRM=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-dir)     BOT_DIR="$2"; shift 2 ;;
    --mode)        MODE="$2"; shift 2 ;;
    --yes|-y)      SKIP_CONFIRM=true; shift ;;
    --help|-h)
      echo "Verwendung: bash update.sh [OPTIONEN]"
      echo ""
      echo "Optionen:"
      echo "  --bot-dir <pfad>         Bot-Verzeichnis (Standard: \$HOME/bockis-bot)"
      echo "  --mode <auto|native|docker>  Update-Modus (Standard: auto)"
      echo "  --yes, -y                Alle Bestätigungen überspringen"
      echo "  --help, -h               Diese Hilfe anzeigen"
      echo ""
      echo "Modi:"
      echo "  auto    Erkennt automatisch ob Docker oder native systemd genutzt wird"
      echo "  native  Update via git pull + npm ci + systemctl restart"
      echo "  docker  Update via docker compose pull + docker compose up --build"
      exit 0
      ;;
    *) die "Unbekannte Option: $1. Nutze --help für Hilfe." ;;
  esac
done

# ── Sicherheits-Check ────────────────────────────────────────────────────────
if [[ "$EUID" -eq 0 ]]; then
  die "Bitte nicht als root ausführen. Nutze einen normalen User mit sudo-Rechten."
fi

# ── Bot-Verzeichnis prüfen ───────────────────────────────────────────────────
print_header "Vorprüfung"

[[ -d "$BOT_DIR" ]] || die "Bot-Verzeichnis nicht gefunden: $BOT_DIR"
[[ -f "$BOT_DIR/bot.js" ]] || die "bot.js nicht in $BOT_DIR — falsches Verzeichnis?"
[[ -f "$BOT_DIR/.env" ]] || die ".env fehlt in $BOT_DIR — bitte zuerst install.js ausführen"

print_success "Bot-Verzeichnis: $BOT_DIR"

# Aktuelle Version ermitteln
CURRENT_VERSION="unbekannt"
if command -v git >/dev/null 2>&1 && git -C "$BOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  CURRENT_VERSION=$(git -C "$BOT_DIR" describe --tags --always 2>/dev/null || git -C "$BOT_DIR" rev-parse --short HEAD)
fi
print_status "Aktuelle Version: ${BOLD}$CURRENT_VERSION${NC}"

# ── Modus auto-detection ─────────────────────────────────────────────────────
if [[ "$MODE" == "auto" ]]; then
  if [[ -f "$BOT_DIR/docker-compose.yml" ]] && command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    # Prüfen ob Container tatsächlich laufen
    if docker compose -f "$BOT_DIR/docker-compose.yml" ps --status running 2>/dev/null | grep -q "bot"; then
      MODE="docker"
    else
      MODE="native"
    fi
  else
    MODE="native"
  fi
  print_success "Erkannter Modus: ${BOLD}$MODE${NC}"
else
  print_success "Gewählter Modus: ${BOLD}$MODE${NC}"
fi

# ── Bestätigung ──────────────────────────────────────────────────────────────
if [[ "$SKIP_CONFIRM" == "false" ]]; then
  echo ""
  echo -e "  Modus:       ${BOLD}$MODE${NC}"
  echo -e "  Verzeichnis: ${BOLD}$BOT_DIR${NC}"
  echo ""
  read -rp "  Update jetzt starten? [j/N] " CONFIRM
  [[ "${CONFIRM,,}" =~ ^(j|ja|y|yes)$ ]] || { echo "Abgebrochen."; exit 0; }
fi

# ── .env Backup ──────────────────────────────────────────────────────────────
print_header "Backup"
BACKUP_FILE="$BOT_DIR/.env.backup.$(date +%Y%m%d_%H%M%S)"
cp "$BOT_DIR/.env" "$BACKUP_FILE"
print_success ".env gesichert als $(basename "$BACKUP_FILE")"

# ── UPDATE: Native (systemd) ─────────────────────────────────────────────────
update_native() {
  print_header "Bot-Update (native)"

  # 1. git pull
  command -v git >/dev/null 2>&1 || die "git ist nicht installiert: sudo apt-get install -y git"
  cd "$BOT_DIR"

  if git -C "$BOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    print_status "Lade neueste Version von GitHub..."
    STASH_DONE=false

    # Lokale .env-Änderungen sichern falls sie tracked sind
    if git -C "$BOT_DIR" diff --quiet -- .env 2>/dev/null; then
      true
    else
      git -C "$BOT_DIR" stash push -m "update-backup" -- .env 2>/dev/null && STASH_DONE=true || true
    fi

    git -C "$BOT_DIR" pull --ff-only origin main 2>&1 | while IFS= read -r line; do
      print_status "$line"
    done

    if [[ "$STASH_DONE" == "true" ]]; then
      git -C "$BOT_DIR" stash pop 2>/dev/null || print_warn ".env-Stash konnte nicht wiederhergestellt werden. Backup: $BACKUP_FILE"
    fi
    print_success "Code aktualisiert"
  else
    print_warn "Kein Git-Repository — Code-Update wird übersprungen (nur npm-Pakete werden aktualisiert)"
  fi

  # 2. npm-Pakete aktualisieren
  print_status "Aktualisiere npm-Abhängigkeiten..."
  if [[ -f "$BOT_DIR/package-lock.json" ]]; then
    npm ci --omit=dev --silent 2>&1 | tail -3
  else
    npm install --omit=dev --silent 2>&1 | tail -3
  fi
  print_success "npm-Pakete aktualisiert"

  # 3. Service neu starten
  if systemctl is-active --quiet bockis-bot 2>/dev/null; then
    print_status "Starte bockis-bot Service neu..."
    sudo systemctl restart bockis-bot
    sleep 3
    if systemctl is-active --quiet bockis-bot; then
      print_success "Service läuft wieder"
    else
      print_error "Service ist nach dem Neustart nicht aktiv!"
      sudo systemctl status bockis-bot --no-pager -l | tail -20
      die "Update fehlgeschlagen — .env-Backup: $BACKUP_FILE"
    fi
  else
    print_warn "Systemd-Service 'bockis-bot' nicht aktiv — überspringe Neustart"
    print_status "Starte manuell mit: sudo systemctl start bockis-bot"
  fi
}

# ── UPDATE: Docker ───────────────────────────────────────────────────────────
update_docker() {
  print_header "Docker-Update"

  [[ -f "$BOT_DIR/docker-compose.yml" ]] || die "docker-compose.yml nicht gefunden in $BOT_DIR"
  command -v docker >/dev/null 2>&1 || die "Docker ist nicht installiert."
  docker compose version >/dev/null 2>&1 || die "docker compose (Plugin) nicht verfügbar. Bitte Docker Desktop oder das Compose-Plugin installieren."

  cd "$BOT_DIR"

  # 1. Code per git aktualisieren (falls verfügbar)
  if git -C "$BOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    print_status "Lade neueste Version von GitHub..."
    git -C "$BOT_DIR" pull --ff-only origin main 2>&1 | while IFS= read -r line; do
      print_status "$line"
    done
    print_success "Code aktualisiert"
  else
    print_warn "Kein Git-Repository — Code-Update wird übersprungen"
  fi

  # 2. Basis-Images aktualisieren (node, etc.)
  print_status "Lade neue Docker-Images..."
  docker compose pull 2>&1 | while IFS= read -r line; do
    print_status "$line"
  done
  print_success "Images aktualisiert"

  # 3. Container stoppen, neu bauen und starten
  print_status "Baue Bot-Container neu und starte..."
  docker compose up -d --build --remove-orphans 2>&1 | while IFS= read -r line; do
    print_status "$line"
  done
  print_success "Container neu gestartet"

  # 4. Health-Check abwarten
  print_status "Warte auf Health-Check (max. 60s)..."
  ATTEMPTS=0
  MAX_ATTEMPTS=12
  while [[ $ATTEMPTS -lt $MAX_ATTEMPTS ]]; do
    sleep 5
    ATTEMPTS=$((ATTEMPTS + 1))
    STATUS=$(docker compose ps --format json 2>/dev/null | python3 -c "import sys,json; data=sys.stdin.read(); rows=[json.loads(l) for l in data.strip().splitlines() if l]; print(rows[0].get('Health','') if rows else '')" 2>/dev/null || echo "")
    if [[ "$STATUS" == "healthy" ]]; then
      print_success "Container ist healthy"
      break
    elif [[ "$STATUS" == "unhealthy" ]]; then
      print_error "Container nicht healthy — Logs:"
      docker compose logs --tail=30 bot 2>/dev/null || true
      die "Update fehlgeschlagen — .env-Backup: $BACKUP_FILE"
    fi
    print_status "Health-Check läuft... ($((ATTEMPTS * 5))s / $((MAX_ATTEMPTS * 5))s)"
  done

  # Alte, nicht mehr genutzte Images räumen
  print_status "Bereinige veraltete Docker-Images..."
  docker image prune -f >/dev/null 2>&1 && print_success "Alte Images entfernt" || true
}

# ── Update ausführen ─────────────────────────────────────────────────────────
case "$MODE" in
  native) update_native ;;
  docker) update_docker ;;
  *)      die "Ungültiger Modus: $MODE. Erlaubt: auto, native, docker" ;;
esac

# ── Neue Version anzeigen ────────────────────────────────────────────────────
NEW_VERSION="unbekannt"
if command -v git >/dev/null 2>&1 && git -C "$BOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  NEW_VERSION=$(git -C "$BOT_DIR" describe --tags --always 2>/dev/null || git -C "$BOT_DIR" rev-parse --short HEAD)
fi

# ── Abschluss ────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗"
echo -e "║       Update erfolgreich abgeschlossen!  ║"
echo -e "╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Vorher: ${YELLOW}$CURRENT_VERSION${NC}"
echo -e "  Nachher: ${GREEN}${BOLD}$NEW_VERSION${NC}"
echo ""

if [[ "$MODE" == "native" ]]; then
  echo "Service-Befehle:"
  echo "  sudo systemctl status  bockis-bot"
  echo "  sudo journalctl -u bockis-bot -f"
else
  echo "Docker-Befehle:"
  echo "  docker compose ps"
  echo "  docker compose logs -f bot"
fi
echo ""
echo -e "  .env-Backup:  ${CYAN}$BACKUP_FILE${NC}"
echo ""
