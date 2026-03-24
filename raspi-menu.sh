#!/bin/bash
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 ReXx09 (https://github.com/ReXx09)
#
# raspi-menu.sh — Bockis Discord Bot — Raspberry Pi Verwaltungsmenü
# Interaktives whiptail-Menü für System-Setup, Bot-Verwaltung,
# Uptime Kuma, Docker und Statusprüfungen.
#
# Voraussetzungen: Debian/Ubuntu/Raspberry Pi OS, sudo-Rechte
# Ausführung:      bash raspi-menu.sh [--bot-dir /pfad]

# ── Sicherheits-Check ────────────────────────────────────────────────────────
if [[ "$EUID" -eq 0 ]]; then
  echo "Bitte nicht als root ausführen. Nutze einen normalen User mit sudo-Rechten." >&2
  exit 1
fi

command -v apt-get >/dev/null 2>&1 || { echo "Dieses Skript benötigt Debian/Ubuntu/Raspberry Pi OS." >&2; exit 1; }

# ── whiptail installieren falls nötig ────────────────────────────────────────
if ! command -v whiptail >/dev/null 2>&1; then
  echo "Installiere whiptail..."
  sudo apt-get install -y whiptail >/dev/null 2>&1
fi

# ── Farben & Hilfsfunktionen ─────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
info() { echo -e "${YELLOW}  →${NC} $1"; }
err()  { echo -e "${RED}  ✗${NC} $1" >&2; }
pause(){ echo ""; read -rp "  Enter drücken um fortzufahren..."; }

# ── Konfiguration ─────────────────────────────────────────────────────────────
BOT_DIR="$HOME/bockis-bot"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KUMA_DIR="$HOME/uptime-kuma"
KUMA_PORT=3001
BOT_PORT=3000
WEB_PORT=3000   # Dashboard-Port (gleich wie BOT_PORT, aus .env lesbar)
LOG_LINES=50

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-dir) BOT_DIR="$2"; shift 2 ;;
    *) echo "Unbekannte Option: $1"; exit 1 ;;
  esac
done

# Fenstermaße – dynamisch an Terminalgröße anpassen
COLS=$(tput cols  2>/dev/null || echo 80)
ROWS=$(tput lines 2>/dev/null || echo 24)
W=$(( COLS > 90 ? 86 : COLS - 2 ))
H=$(( ROWS > 28 ? 26 : ROWS - 2 ))
[ "$W" -lt 64 ] && W=64
[ "$H" -lt 20 ] && H=20

# ── Hilfsfunktionen ──────────────────────────────────────────────────────────

# Spinner für lange Befehle
run_with_spinner() {
  local MSG="$1"; shift
  local TMP; TMP=$(mktemp)
  "$@" >"$TMP" 2>&1 &
  local PID=$!
  local SPIN=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  local I=0
  tput civis
  while kill -0 "$PID" 2>/dev/null; do
    printf "\r  ${CYAN}%s${NC} %s " "${SPIN[$I]}" "$MSG"
    I=$(( (I+1) % ${#SPIN[@]} ))
    sleep 0.1
  done
  tput cnorm
  printf "\r  %-60s\r" ""
  wait "$PID"
  local RC=$?
  rm -f "$TMP"
  return $RC
}

# Status-Badge
badge() {
  local LABEL="$1" CMD="$2"
  if eval "$CMD" >/dev/null 2>&1; then
    echo -e "  ${GREEN}[✓ AKTIV ]${NC}  $LABEL"
  else
    echo -e "  ${RED}[✗ INAKTIV]${NC}  $LABEL"
  fi
}

# Zeigt Ausgabe in whiptail-Scrollbox
show_output() {
  local TITLE="$1" CONTENT="$2"
  whiptail --title "$TITLE" --scrolltext --msgbox "$CONTENT" 30 $W 3>&1 1>&2 2>&3
}

# ════════════════════════════════════════════════════════════════════════════════
# MODUL 1 — SYSTEM VORBEREITUNG
# ════════════════════════════════════════════════════════════════════════════════

menu_system() {
  while true; do
    CHOICE=$(whiptail --title "🍓 System vorbereiten" --menu \
      "Raspberry Pi für den Bot-Betrieb einrichten:" $H $W 10 \
      "1" "System aktualisieren  (apt update + upgrade)" \
      "2" "Wichtige Pakete installieren  (git, curl, ufw, ...)" \
      "3" "Swap-Speicher einrichten (empfohlen für Pi 3)" \
      "4" "Firewall (ufw) konfigurieren" \
      "5" "Zeitzone setzen" \
      "6" "Node.js LTS installieren / aktualisieren" \
      "7" "Docker installieren" \
      "8" "Alle Vorbereitungen in einem Schritt  ★" \
      "←" "Zurück zum Hauptmenü" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1") sys_update ;;
      "2") sys_packages ;;
      "3") sys_swap ;;
      "4") sys_firewall ;;
      "5") sys_timezone ;;
      "6") sys_nodejs ;;
      "7") sys_docker ;;
      "8") sys_all ;;
      "←") return ;;
    esac
  done
}

sys_update() {
  clear
  echo -e "${BOLD}${CYAN}━━ System aktualisieren ━━${NC}\n"
  info "apt-get update..."
  sudo apt-get update 2>&1 | tail -3
  info "apt-get upgrade..."
  sudo apt-get upgrade -y 2>&1 | tail -5
  sudo apt-get autoremove -y -qq
  ok "System ist aktuell"
  pause
}

sys_packages() {
  clear
  echo -e "${BOLD}${CYAN}━━ Pakete installieren ━━${NC}\n"
  local PKGS=(git curl wget nano lsb-release ca-certificates gnupg ufw htop net-tools)
  info "Installiere: ${PKGS[*]}"
  sudo apt-get install -y "${PKGS[@]}" 2>&1 | tail -5
  ok "Pakete installiert"
  pause
}

sys_swap() {
  clear
  echo -e "${BOLD}${CYAN}━━ Swap-Speicher ━━${NC}\n"
  local CURRENT_SWAP; CURRENT_SWAP=$(free -m | awk '/Swap:/{print $2}')
  info "Aktueller Swap: ${CURRENT_SWAP} MB"

  SWAP_SIZE=$(whiptail --title "Swap-Größe" --inputbox \
    "Swap-Größe in MB (empfohlen: 1024 für Pi 3, 2048 für Pi 4):" \
    8 $W "1024" 3>&1 1>&2 2>&3) || return

  [[ "$SWAP_SIZE" =~ ^[0-9]+$ ]] || { err "Ungültige Eingabe"; pause; return; }

  sudo dphys-swapfile swapoff 2>/dev/null || true
  sudo sed -i "s/CONF_SWAPSIZE=.*/CONF_SWAPSIZE=$SWAP_SIZE/" /etc/dphys-swapfile 2>/dev/null || \
    echo "CONF_SWAPSIZE=$SWAP_SIZE" | sudo tee /etc/dphys-swapfile >/dev/null
  sudo dphys-swapfile setup
  sudo dphys-swapfile swapon
  ok "Swap auf ${SWAP_SIZE}MB gesetzt"
  free -h
  pause
}

sys_firewall() {
  clear
  echo -e "${BOLD}${CYAN}━━ Firewall (ufw) ━━${NC}\n"

  command -v ufw >/dev/null 2>&1 || sudo apt-get install -y ufw -qq

  PORTS=$(whiptail --title "Firewall konfigurieren" --inputbox \
    "Ports freigeben (kommagetrennt).\nStandard: 22 (SSH), $BOT_PORT (Bot-Web), $KUMA_PORT (Uptime Kuma):" \
    10 $W "22,${BOT_PORT},${KUMA_PORT}" 3>&1 1>&2 2>&3) || return

  sudo ufw --force reset >/dev/null 2>&1
  sudo ufw default deny incoming >/dev/null 2>&1
  sudo ufw default allow outgoing >/dev/null 2>&1

  IFS=',' read -ra PORT_LIST <<< "$PORTS"
  for PORT in "${PORT_LIST[@]}"; do
    PORT=$(echo "$PORT" | tr -d ' ')
    [[ "$PORT" =~ ^[0-9]+$ ]] && sudo ufw allow "$PORT"/tcp >/dev/null 2>&1 && ok "Port $PORT freigegeben"
  done

  sudo ufw --force enable >/dev/null 2>&1
  ok "Firewall aktiv"
  sudo ufw status
  pause
}

sys_timezone() {
  clear
  echo -e "${BOLD}${CYAN}━━ Zeitzone setzen ━━${NC}\n"
  info "Aktuelle Zeitzone: $(timedatectl show -p Timezone --value 2>/dev/null || cat /etc/timezone)"
  TZ=$(whiptail --title "Zeitzone" --inputbox \
    "Zeitzone eingeben (z.B. Europe/Berlin, Europe/Vienna, Europe/Zurich):" \
    8 $W "Europe/Berlin" 3>&1 1>&2 2>&3) || return

  sudo timedatectl set-timezone "$TZ" && ok "Zeitzone gesetzt: $TZ" || err "Ungültige Zeitzone: $TZ"
  timedatectl
  pause
}

sys_nodejs() {
  clear
  echo -e "${BOLD}${CYAN}━━ Node.js LTS installieren ━━${NC}\n"

  if command -v node >/dev/null 2>&1; then
    info "Installiert: Node.js $(node -v)"
    if node -e "process.exit(parseInt(process.version.slice(1)) < 18 ? 1 : 0)" 2>/dev/null; then
      ok "Version ist aktuell (≥ 18) — kein Update nötig"
      pause; return
    fi
    info "Version zu alt — wird auf LTS aktualisiert..."
  fi

  info "NodeSource-Repo einrichten..."
  curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash - 2>&1 | tail -3
  sudo apt-get install -y nodejs 2>&1 | tail -3
  ok "Node.js $(node -v) installiert"
  ok "npm $(npm -v) verfügbar"
  pause
}

sys_docker() {
  clear
  echo -e "${BOLD}${CYAN}━━ Docker installieren ━━${NC}\n"

  if command -v docker >/dev/null 2>&1; then
    ok "Docker bereits installiert: $(docker --version)"
    pause; return
  fi

  if ! whiptail --title "Docker installieren" --yesno \
    "Docker wird über das offizielle Skript (get.docker.com) installiert.\n\nFortfahren?" \
    10 $W; then return; fi

  info "Docker installieren..."
  curl -fsSL https://get.docker.com | sudo sh 2>&1 | tail -10
  sudo usermod -aG docker "$USER"
  ok "Docker installiert: $(docker --version)"
  ok "Benutzer '$USER' zur docker-Gruppe hinzugefügt"
  echo ""
  echo -e "  ${YELLOW}⚠  Bitte einmal aus- und einloggen (oder 'newgrp docker'), damit die Gruppenrechte aktiv werden.${NC}"
  pause
}

sys_all() {
  if ! whiptail --title "Vollständige Vorbereitung" --yesno \
    "Alle Vorbereitungsschritte werden jetzt ausgeführt:\n\n  1. System aktualisieren\n  2. Pakete installieren\n  3. Node.js LTS installieren\n  4. Docker installieren\n\nFortfahren?" \
    15 $W; then return; fi
  sys_update
  sys_packages
  sys_nodejs
  sys_docker
  local NEXT
  NEXT=$(whiptail --title "✓ Vorbereitung abgeschlossen" --menu \
    "Das System ist bereit!\n\nWas möchtest du als nächstes tun?" \
    14 $W 3 \
    "1" "Uptime Kuma lokal installieren  (Docker, auf diesem Raspi)" \
    "2" "Externe Uptime Kuma URL konfigurieren  (Unraid, NAS, Cloud ...)" \
    "3" "Weiter  →  direkt zum Bot installieren" \
    3>&1 1>&2 2>&3) || return

  case "$NEXT" in
    "1") menu_kuma ;;
    "2") kuma_external_setup ;;
    "3") ;;
  esac
}

# ════════════════════════════════════════════════════════════════════════════════
# MODUL 2 — UPTIME KUMA
# ════════════════════════════════════════════════════════════════════════════════

menu_kuma() {
  while true; do
    # Status ermitteln
    local KUMA_STATUS="INAKTIV"
    if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
      KUMA_STATUS="AKTIV (Docker)"
    elif systemctl is-active --quiet uptime-kuma 2>/dev/null; then
      KUMA_STATUS="AKTIV (systemd)"
    fi

    # Zeige ob extern konfiguriert
    local KUMA_MODE_LABEL="lokal / Docker"
    if [[ -f "$BOT_DIR/.env" ]] && grep -q 'UPTIME_KUMA_URL=' "$BOT_DIR/.env" 2>/dev/null; then
      local KUMA_CONF; KUMA_CONF=$(grep 'UPTIME_KUMA_URL=' "$BOT_DIR/.env" | cut -d'=' -f2- | tr -d '"')
      [[ -n "$KUMA_CONF" ]] && KUMA_MODE_LABEL="→ $KUMA_CONF"
    fi

    CHOICE=$(whiptail --title "📊 Uptime Kuma  [$KUMA_STATUS]" --menu \
      "Uptime Kuma Monitoring-Plattform verwalten:\n($KUMA_MODE_LABEL)" $H $W 9 \
      "1" "Status & Verbindung prüfen" \
      "2" "Lokal installieren  (Docker, empfohlen für Raspi)" \
      "3" "Externe Instanz konfigurieren  (Unraid, NAS, Cloud ...)" \
      "4" "Uptime Kuma starten" \
      "5" "Uptime Kuma stoppen" \
      "6" "Uptime Kuma aktualisieren" \
      "7" "Logs anzeigen" \
      "8" "Deinstallieren  (nur lokale Instanz)" \
      "←" "Zurück zum Hauptmenü" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1") kuma_status ;;
      "2") kuma_install_docker ;;
      "3") kuma_external_setup ;;
      "4") kuma_start ;;
      "5") kuma_stop ;;
      "6") kuma_update ;;
      "7") kuma_logs ;;
      "8") kuma_uninstall ;;
      "←") return ;;
    esac
  done
}

kuma_status() {
  clear
  echo -e "${BOLD}${CYAN}━━ Uptime Kuma Status ━━${NC}\n"

  local IP; IP=$(hostname -I | awk '{print $1}')

  # Konfigurierte URL aus .env lesen (falls vorhanden)
  local KUMA_URL_ENV=""
  if [[ -f "$BOT_DIR/.env" ]]; then
    KUMA_URL_ENV=$(grep 'UPTIME_KUMA_URL=' "$BOT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
  fi

  # Lokale Instanz prüfen
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    ok "Lokale Instanz: Container läuft (Docker)"
    docker ps --filter "name=uptime-kuma" --format "  Image: {{.Image}}  |  Status: {{.Status}}  |  Ports: {{.Ports}}"
    echo ""
  elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    err "Lokale Instanz: Container gestoppt"
    echo "  Starten via: Menü → Uptime Kuma → Starten"
    echo ""
  elif systemctl is-active --quiet uptime-kuma 2>/dev/null; then
    ok "Lokale Instanz: systemd-Service aktiv"
    echo ""
  else
    info "Keine lokale Uptime Kuma Instanz gefunden"
    echo ""
  fi

  # Erreichbarkeit testen: externe URL bevorzugen, sonst localhost
  local CHECK_URL="http://localhost:${KUMA_PORT}"
  if [[ -n "$KUMA_URL_ENV" ]]; then
    CHECK_URL="$KUMA_URL_ENV"
    echo -e "  ${BOLD}Konfigurierte URL (Bot .env):${NC}  $CHECK_URL"
    echo ""
  fi

  info "Prüfe Verbindung zu $CHECK_URL ..."
  if curl -sf --max-time 8 "$CHECK_URL" >/dev/null 2>&1; then
    ok "$CHECK_URL antwortet → Verbindung OK"
  else
    err "$CHECK_URL nicht erreichbar"
    if [[ -n "$KUMA_URL_ENV" ]]; then
      echo -e "  ${DIM}Prüfe ob die externe Instanz läuft und die URL stimmt.${NC}"
    else
      echo -e "  ${DIM}Uptime Kuma lokal installieren oder externe URL konfigurieren.${NC}"
    fi
  fi
  pause
}

kuma_install_docker() {
  clear
  echo -e "${BOLD}${CYAN}━━ Uptime Kuma via Docker installieren ━━${NC}\n"

  command -v docker >/dev/null 2>&1 || { err "Docker ist nicht installiert!  →  Menü: System vorbereiten → Docker installieren"; pause; return; }

  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    err "Uptime Kuma Container existiert bereits"
    info "Zum Starten: Menü → Uptime Kuma → Starten"
    pause; return
  fi

  KUMA_PORT=$(whiptail --title "Uptime Kuma Port" --inputbox \
    "Auf welchem Port soll Uptime Kuma laufen?\n(Standard: 3001 — nicht mit dem Bot auf 3000 kollidieren)" \
    9 $W "3001" 3>&1 1>&2 2>&3) || return

  KUMA_DATA=$(whiptail --title "Uptime Kuma Datenpfad" --inputbox \
    "Wo sollen die Daten gespeichert werden?" \
    8 $W "$HOME/uptime-kuma-data" 3>&1 1>&2 2>&3) || return

  mkdir -p "$KUMA_DATA"

  info "Ziehe louislam/uptime-kuma Image..."
  docker pull louislam/uptime-kuma:latest 2>&1 | tail -5

  info "Starte Container..."
  docker run -d \
    --name uptime-kuma \
    --restart=unless-stopped \
    -p "${KUMA_PORT}:3001" \
    -v "${KUMA_DATA}:/app/data" \
    louislam/uptime-kuma:latest

  local IP; IP=$(hostname -I | awk '{print $1}')
  echo ""
  ok "Uptime Kuma installiert und gestartet!"
  ok "Weboberfläche: http://${IP}:${KUMA_PORT}"
  echo ""
  echo -e "  ${YELLOW}Beim ersten Aufruf wird ein Admin-Konto erstellt.${NC}"
  echo -e "  ${YELLOW}API-Key und Slug dann im Bot-Installer eintragen.${NC}"
  pause
}

kuma_start() {
  clear
  info "Starte Uptime Kuma..."
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    docker start uptime-kuma && ok "Container gestartet" || err "Fehler beim Starten"
  elif systemctl list-units --type=service 2>/dev/null | grep -q "uptime-kuma"; then
    sudo systemctl start uptime-kuma && ok "Service gestartet"
  else
    err "Uptime Kuma nicht gefunden — bitte zuerst installieren"
  fi
  pause
}

kuma_stop() {
  clear
  if ! whiptail --title "Uptime Kuma stoppen" --yesno "Uptime Kuma wirklich stoppen?" 8 $W; then return; fi
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    docker stop uptime-kuma && ok "Container gestoppt"
  elif systemctl is-active --quiet uptime-kuma 2>/dev/null; then
    sudo systemctl stop uptime-kuma && ok "Service gestoppt"
  else
    err "Uptime Kuma läuft nicht"
  fi
  pause
}

kuma_update() {
  clear
  echo -e "${BOLD}${CYAN}━━ Uptime Kuma aktualisieren ━━${NC}\n"
  command -v docker >/dev/null 2>&1 || { err "Docker nicht installiert"; pause; return; }

  info "Aktuelles Image sichern..."
  docker stop uptime-kuma 2>/dev/null || true

  info "Neues Image holen..."
  docker pull louislam/uptime-kuma:latest 2>&1 | tail -5

  info "Container neu erstellen..."
  local PORTS; PORTS=$(docker inspect --format='{{range $p,$conf := .NetworkSettings.Ports}}{{(index $conf 0).HostPort}}{{end}}' uptime-kuma 2>/dev/null || echo "$KUMA_PORT")
  local VOLUME; VOLUME=$(docker inspect --format='{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}{{end}}{{end}}' uptime-kuma 2>/dev/null || echo "$HOME/uptime-kuma-data")

  docker rm uptime-kuma 2>/dev/null || true
  docker run -d \
    --name uptime-kuma \
    --restart=unless-stopped \
    -p "${PORTS}:3001" \
    -v "${VOLUME}:/app/data" \
    louislam/uptime-kuma:latest

  docker image prune -f >/dev/null 2>&1
  ok "Uptime Kuma aktualisiert und neu gestartet"
  pause
}

kuma_logs() {
  clear
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    local LOGS; LOGS=$(docker logs --tail "$LOG_LINES" uptime-kuma 2>&1)
    show_output "Uptime Kuma Logs (letzte $LOG_LINES Zeilen)" "$LOGS"
  else
    err "Uptime Kuma Container läuft nicht"; pause
  fi
}

kuma_uninstall() {
  whiptail --title "⚠ Deinstallieren" --yesno \
    "Uptime Kuma Container und Image entfernen?\n\nDie Datendateien bleiben erhalten." 10 $W || return
  docker stop uptime-kuma 2>/dev/null || true
  docker rm uptime-kuma 2>/dev/null || true
  docker rmi louislam/uptime-kuma:latest 2>/dev/null || true
  ok "Uptime Kuma deinstalliert"
  pause
}

kuma_external_setup() {
  clear
  echo -e "${BOLD}${CYAN}━━ Externe Uptime Kuma Instanz konfigurieren ━━${NC}\n"

  echo -e "  ${CYAN}ℹ${NC}  Diese Option verbindet den Bot mit einer bereits laufenden"
  echo -e "     Uptime Kuma Instanz (z.B. auf Unraid, NAS, VPS oder Heimserver)."
  echo -e "     Auf dem Raspberry Pi wird ${BOLD}keine${NC} lokale Instanz installiert.\n"

  # Aktuellen Wert aus .env lesen
  local CURRENT_URL="http://192.168.x.x:3001"
  if [[ -f "$BOT_DIR/.env" ]]; then
    local FROM_ENV; FROM_ENV=$(grep 'UPTIME_KUMA_URL=' "$BOT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    [[ -n "$FROM_ENV" ]] && CURRENT_URL="$FROM_ENV"
  fi

  local NEW_URL
  NEW_URL=$(whiptail --title "Uptime Kuma URL" --inputbox \
    "URL der externen Uptime Kuma Instanz:\n\nBeispiele:\n  http://192.168.1.50:3001\n  https://uptime.deinedomain.de\n  http://unraid.local:3001" \
    13 $W "$CURRENT_URL" 3>&1 1>&2 2>&3) || return

  [[ -z "$NEW_URL" ]] && { err "Keine URL eingegeben"; pause; return; }

  # Grundlegende URL-Validierung
  if ! echo "$NEW_URL" | grep -qE '^https?://'; then
    whiptail --title "Ungültige URL" --msgbox \
      "Die URL muss mit http:// oder https:// beginnen.\n\nEingabe: $NEW_URL" 9 $W
    return
  fi

  # Verbindung testen
  info "Teste Verbindung zu $NEW_URL ..."
  if curl -sf --max-time 8 "$NEW_URL" >/dev/null 2>&1; then
    ok "Verbindung erfolgreich!"
  else
    if ! whiptail --title "⚠ Verbindung fehlgeschlagen" --yesno \
      "$NEW_URL ist nicht erreichbar.\n\nMögliche Ursachen:\n  • Instanz läuft nicht\n  • Falsche IP/Port\n  • Netzwerk/Firewall blockiert\n  • Bei CG-NAT: Cloudflare Tunnel nötig\n\nURL trotzdem speichern?" \
      14 $W; then
      return
    fi
  fi

  # In .env schreiben (Bot-Konfiguration)
  if [[ -f "$BOT_DIR/.env" ]]; then
    # Vorhandenen Wert ersetzen
    if grep -q 'UPTIME_KUMA_URL=' "$BOT_DIR/.env"; then
      sed -i "s|^UPTIME_KUMA_URL=.*|UPTIME_KUMA_URL=${NEW_URL}|" "$BOT_DIR/.env"
    else
      echo "UPTIME_KUMA_URL=${NEW_URL}" >> "$BOT_DIR/.env"
    fi
    ok "UPTIME_KUMA_URL in $BOT_DIR/.env gespeichert"

    # Bot neu starten wenn er läuft
    if systemctl is-active --quiet bockis-bot 2>/dev/null; then
      info "Bot-Service neu starten..."
      sudo systemctl restart bockis-bot 2>/dev/null && ok "Bot neu gestartet" || err "Neustart fehlgeschlagen"
    fi
  else
    echo ""
    err ".env nicht gefunden (Bot noch nicht installiert)"
    info "Merke URL vor — nach der Installation in install.js eintragen:"
    echo -e "  ${BOLD}$NEW_URL${NC}"
    info "Oder: UPTIME_KUMA_URL=$NEW_URL manuell in $BOT_DIR/.env einfügen"
  fi

  pause
}

# ════════════════════════════════════════════════════════════════════════════════
# MODUL 3 — BOT-VERWALTUNG
# ════════════════════════════════════════════════════════════════════════════════

menu_bot() {
  while true; do
    local BOT_STATUS="NICHT INSTALLIERT"
    if systemctl is-active --quiet bockis-bot 2>/dev/null; then
      BOT_STATUS="AKTIV (systemd)"
    elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q "bot"; then
      BOT_STATUS="AKTIV (Docker)"
    elif [[ -f "$BOT_DIR/bot.js" ]]; then
      BOT_STATUS="INSTALLIERT, gestoppt"
    fi

    CHOICE=$(whiptail --title "🤖 Bot-Verwaltung  [$BOT_STATUS]" --menu \
      "Bockis Discord Bot verwalten:" $H $W 9 \
      "1" "Bot installieren  (start-bot.sh + install.js)" \
      "2" "Bot aktualisieren  (git pull + npm ci)" \
      "3" "Bot starten" \
      "4" "Bot stoppen" \
      "5" "Bot neu starten" \
      "6" "Bot-Logs anzeigen" \
      "7" "Service-Status anzeigen" \
      "8" "Bot deinstallieren" \
      "←" "Zurück zum Hauptmenü" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1") bot_install ;;
      "2") bot_update ;;
      "3") bot_start ;;
      "4") bot_stop ;;
      "5") bot_restart ;;
      "6") bot_logs ;;
      "7") bot_service_status ;;
      "8") bot_uninstall ;;
      "←") return ;;
    esac
  done
}

bot_install() {
  clear
  echo -e "${BOLD}${CYAN}━━ Bot installieren ━━${NC}\n"

  if [[ -f "$BOT_DIR/bot.js" ]]; then
    if ! whiptail --title "Bot bereits vorhanden" --yesno \
      "Bot-Dateien in $BOT_DIR gefunden.\nTrotzdem neu installieren?" 9 $W; then return; fi
  fi

  INSTALL_MODE=$(whiptail --title "Installationsquelle" --menu \
    "Woher sollen die Bot-Dateien kommen?" 12 $W 3 \
    "git"  "Von GitHub klonen  (empfohlen)" \
    "local" "Über start-bot.sh aus aktuellem Verzeichnis" \
    "←"    "Abbrechen" \
    3>&1 1>&2 2>&3) || return

  case "$INSTALL_MODE" in
    "git")
      BOT_DIR_INPUT=$(whiptail --title "Installationspfad" --inputbox \
        "Bot-Verzeichnis:" 8 $W "$BOT_DIR" 3>&1 1>&2 2>&3) || return
      BOT_DIR="$BOT_DIR_INPUT"
      info "Klone Repository..."
      git clone https://github.com/ReXx09/Bockis_Discord-Bot.git "$BOT_DIR" && ok "Geklont nach $BOT_DIR"
      bash "$BOT_DIR/start-bot.sh" --bot-dir "$BOT_DIR"
      ;;
    "local")
      bash "$SCRIPT_DIR/start-bot.sh" --bot-dir "$BOT_DIR"
      ;;
  esac
}

bot_update() {
  check_bot_installed || return
  clear

  local UPDATE_MODE
  UPDATE_MODE=$(whiptail --title "Update-Modus" --menu \
    "Wie soll der Bot aktualisiert werden?" 12 $W 3 \
    "native" "systemd  (git pull + npm ci + service restart)" \
    "docker" "Docker   (docker compose pull + up --build)" \
    "auto"   "Automatisch erkennen" \
    3>&1 1>&2 2>&3) || return

  local SKIP_FLAG=""
  if ! whiptail --title "npm-Abhaengigkeiten" --yesno \
    "npm-Pakete ebenfalls aktualisieren?\n\n  Ja  = git pull + npm ci  (langsam, sqlite3 neu kompiliert)\n  Nein = nur git pull       (schnell, fuer reine Code-Updates)" \
    11 $W; then
    SKIP_FLAG="--skip-npm"
  fi

  bash "$SCRIPT_DIR/update.sh" --bot-dir "$BOT_DIR" --mode "$UPDATE_MODE" --yes $SKIP_FLAG
  pause
}

bot_start() {
  clear
  if systemctl list-unit-files --type=service 2>/dev/null | grep -q "bockis-bot"; then
    sudo systemctl start bockis-bot && ok "Service 'bockis-bot' gestartet" || err "Fehler"
  else
    err "Systemd-Service 'bockis-bot' nicht gefunden"
    info "Manuell: node $BOT_DIR/bot.js"
  fi
  pause
}

bot_stop() {
  clear
  whiptail --title "Bot stoppen" --yesno "Bot wirklich stoppen?" 8 $W || return
  sudo systemctl stop bockis-bot 2>/dev/null && ok "Bot gestoppt" || err "Service nicht aktiv"
  pause
}

bot_restart() {
  clear
  sudo systemctl restart bockis-bot 2>/dev/null && ok "Bot neu gestartet" || err "Fehler"
  pause
}

bot_logs() {
  LOG_SOURCE=$(whiptail --title "Log-Quelle" --menu "Welche Logs anzeigen?" 12 $W 3 \
    "journal" "journalctl  (systemd)" \
    "file"    "Logdatei    ($BOT_DIR/logs/)" \
    "docker"  "Docker Logs" \
    3>&1 1>&2 2>&3) || return

  case "$LOG_SOURCE" in
    "journal")
      LOGS=$(sudo journalctl -u bockis-bot -n "$LOG_LINES" --no-pager 2>&1)
      show_output "Bot-Logs (journalctl)" "$LOGS"
      ;;
    "file")
      local LOG_FILE; LOG_FILE=$(find "$BOT_DIR/logs" -name "*.log" -newer /tmp 2>/dev/null | head -1)
      [[ -f "$LOG_FILE" ]] || LOG_FILE=$(find "$BOT_DIR/logs" -name "*.log" 2>/dev/null | sort -r | head -1)
      if [[ -f "$LOG_FILE" ]]; then
        LOGS=$(tail -"$LOG_LINES" "$LOG_FILE" 2>&1)
        show_output "Bot-Logs ($(basename "$LOG_FILE"))" "$LOGS"
      else
        err "Keine Logdateien in $BOT_DIR/logs gefunden"; pause
      fi
      ;;
    "docker")
      LOGS=$(docker compose -f "$BOT_DIR/docker-compose.yml" logs --tail "$LOG_LINES" 2>&1)
      show_output "Bot-Logs (Docker)" "$LOGS"
      ;;
  esac
}

bot_service_status() {
  clear
  echo -e "${BOLD}${CYAN}━━ Service-Status ━━${NC}\n"
  sudo systemctl status bockis-bot --no-pager -l 2>&1 || err "Service nicht gefunden"
  echo ""
  local IP; IP=$(hostname -I | awk '{print $1}')
  local PORT; PORT=$(grep -oP '(?<=WEB_PORT=)\d+' "$BOT_DIR/.env" 2>/dev/null || echo "$BOT_PORT")
  info "Prüfe Health-Endpoint..."
  if curl -sf --max-time 5 "http://localhost:${PORT}/health" >/dev/null 2>&1; then
    ok "http://localhost:${PORT}/health antwortet"
  else
    err "Health-Endpoint http://localhost:${PORT}/health nicht erreichbar"
  fi
  pause
}

bot_uninstall() {
  local BOT_PORT_VAL
  BOT_PORT_VAL=$(grep -oP '(?<=WEB_PORT=)\d+' "$BOT_DIR/.env" 2>/dev/null || echo "$BOT_PORT")

  # ── Stufe wählen ─────────────────────────────────────────────────────────
  local MODE
  MODE=$(whiptail --title "🗑  Bot deinstallieren — Stufe wählen" --menu \
"Wähle den Umfang der Deinstallation:

  ╔══════════════════════════════════════════════════════╗
  ║  Stufe 1 — Soft-Uninstall  (Konfiguration behalten) ║
  ║    • systemd-Service stoppen & entfernen             ║
  ║    • Docker-Container & Image entfernen              ║
  ║    • UFW-Firewall-Regel entfernen                    ║
  ║    • Bot-Ordner BLEIBT erhalten                      ║
  ║      (.env, Datenbank, Logs bleiben gesichert)       ║
  ╠══════════════════════════════════════════════════════╣
  ║  Stufe 2 — Full-Uninstall  (alles löschen)          ║
  ║    • Alles wie Stufe 1, PLUS:                        ║
  ║    • Bot-Ordner komplett löschen                     ║
  ║      (inkl. .env, Datenbank, Logs, node_modules)     ║
  ╚══════════════════════════════════════════════════════╝" \
    22 $W 3 \
    "1" "Stufe 1 — Soft-Uninstall  (Konfiguration behalten)" \
    "2" "Stufe 2 — Full-Uninstall  (alles löschen)" \
    "←" "Abbrechen" \
    3>&1 1>&2 2>&3) || return

  [[ "$MODE" == "←" ]] && return

  # ── Bestätigung Stufe 1 ───────────────────────────────────────────────────
  if [[ "$MODE" == "1" ]]; then
    local S1_INFO
    S1_INFO="Folgendes wird entfernt:\n\n"
    S1_INFO+="  • systemd-Service  bockis-bot\n"
    command -v ufw >/dev/null 2>&1 && S1_INFO+="  • UFW-Firewall-Regel  Port ${BOT_PORT_VAL}/tcp\n"
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Eq "^bot$|bockis" && \
      S1_INFO+="  • Docker-Container & Image  (bockis-bot)\n"
    S1_INFO+="\nDas Bot-Verzeichnis $BOT_DIR wird NICHT gelöscht.\n"
    S1_INFO+="Deine .env (Token, Channel-IDs) und die Datenbank bleiben erhalten.\n"
    S1_INFO+="Eine Neuinstallation kann danach direkt mit install.js fortgesetzt werden."

    whiptail --title "Stufe 1 — Soft-Uninstall bestätigen" --yesno \
      "$S1_INFO" 20 $W || return

  # ── Bestätigung Stufe 2 ───────────────────────────────────────────────────
  elif [[ "$MODE" == "2" ]]; then
    local S2_INFO
    S2_INFO="⚠  ACHTUNG — alles wird gelöscht:\n\n"
    S2_INFO+="  • systemd-Service  bockis-bot\n"
    command -v ufw >/dev/null 2>&1 && S2_INFO+="  • UFW-Firewall-Regel  Port ${BOT_PORT_VAL}/tcp\n"
    docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Eq "^bot$|bockis" && \
      S2_INFO+="  • Docker-Container & Image  (bockis-bot)\n"
    S2_INFO+="  • Bot-Ordner  $BOT_DIR\n"
    S2_INFO+="       (inkl. .env, Datenbank, Logs, node_modules)\n"
    S2_INFO+="\nDiese Aktion kann NICHT rückgängig gemacht werden!"

    whiptail --title "⚠  Stufe 2 — Full-Uninstall bestätigen" --yesno \
      "$S2_INFO" 20 $W || return

    # Zweite Bestätigung per eingetippter Phrase
    local CONFIRM
    CONFIRM=$(whiptail --title "Sicherheitsabfrage" --inputbox \
      "Zur Bestätigung bitte  LÖSCHEN  eingeben:" \
      8 $W "" 3>&1 1>&2 2>&3) || return

    if [[ "$CONFIRM" != "LÖSCHEN" ]]; then
      whiptail --title "Abgebrochen" --msgbox "Falsche Eingabe — Deinstallation abgebrochen." 8 $W
      return
    fi
  fi

  # ── Gemeinsame Schritte (Stufe 1 + 2) ────────────────────────────────────
  clear
  local TITLE="Stufe 1 — Soft-Uninstall"
  [[ "$MODE" == "2" ]] && TITLE="Stufe 2 — Full-Uninstall"
  echo -e "${BOLD}${RED}━━ Bot deinstallieren: $TITLE ━━${NC}\n"

  # systemd-Service stoppen & entfernen
  info "Stoppe und entferne systemd-Service..."
  sudo systemctl stop bockis-bot 2>/dev/null || true
  sudo systemctl disable bockis-bot 2>/dev/null || true
  sudo rm -f /etc/systemd/system/bockis-bot.service
  sudo systemctl daemon-reload
  ok "systemd-Service entfernt"

  # UFW-Firewall-Regel entfernen
  if command -v ufw >/dev/null 2>&1; then
    info "Entferne UFW-Regel für Port ${BOT_PORT_VAL}..."
    sudo ufw delete allow "${BOT_PORT_VAL}"/tcp 2>/dev/null && \
      ok "UFW-Regel Port ${BOT_PORT_VAL} entfernt" || true
  fi

  # Docker-Container & Image entfernen (falls vorhanden)
  if command -v docker >/dev/null 2>&1; then
    if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -Eq "^bot$|bockis"; then
      info "Stoppe und entferne Docker-Container..."
      docker compose -f "$BOT_DIR/docker-compose.yml" down --rmi all --volumes 2>/dev/null || true
      ok "Docker-Container und Image entfernt"
    fi
  fi

  # ── Stufe 2: Bot-Ordner löschen ───────────────────────────────────────────
  if [[ "$MODE" == "2" ]]; then
    if [[ -d "$BOT_DIR" ]]; then
      info "Lösche Bot-Ordner $BOT_DIR ..."
      rm -rf "$BOT_DIR"
      ok "Bot-Ordner gelöscht"
    else
      info "Bot-Ordner $BOT_DIR nicht gefunden — wird übersprungen"
    fi
  fi

  # ── Abschluss-Hinweis ─────────────────────────────────────────────────────
  echo ""
  if [[ "$MODE" == "1" ]]; then
    ok "Soft-Uninstall abgeschlossen."
    echo -e "  ${GREEN}Deine Konfiguration ist erhalten unter:  ${BOLD}$BOT_DIR/.env${NC}"
    echo -e "  ${YELLOW}Für eine Neuinstallation:  bash start-bot.sh --bot-dir $BOT_DIR${NC}"
  else
    ok "Bot vollständig deinstalliert."
  fi
  echo -e "  ${YELLOW}Node.js und Docker wurden NICHT entfernt (Systemkomponenten).${NC}"
  echo -e "  ${YELLOW}Uptime Kuma läuft weiterhin — bei Bedarf separat deinstallieren.${NC}"
  pause
}

# ════════════════════════════════════════════════════════════════════════════════
# MODUL 4 — STATUS & PRÜFUNGEN
# ════════════════════════════════════════════════════════════════════════════════

menu_status() {
  while true; do
    CHOICE=$(whiptail --title "🔍 Status & Prüfungen" --menu \
      "Systemzustand und laufende Dienste prüfen:" $H $W 9 \
      "1" "Übersicht aller relevanten Services  ★" \
      "2" "Laufende Docker-Container" \
      "3" "Systemressourcen  (CPU, RAM, Disk)" \
      "4" "Offene Ports & Dienste" \
      "5" "Netzwerk & IP-Adressen" \
      "6" "Bot Health-Check" \
      "7" "Systemd-Journal (letzte Fehler)" \
      "8" "Node.js & npm Versionen" \
      "←" "Zurück zum Hauptmenü" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1") status_overview ;;
      "2") status_docker ;;
      "3") status_resources ;;
      "4") status_ports ;;
      "5") status_network ;;
      "6") status_health ;;
      "7") status_journal ;;
      "8") status_versions ;;
      "←") return ;;
    esac
  done
}

status_overview() {
  clear
  echo -e "${BOLD}${CYAN}━━ Dienste-Übersicht ━━${NC}\n"

  badge "bockis-bot (systemd)"      "systemctl is-active --quiet bockis-bot"
  badge "uptime-kuma (systemd)"     "systemctl is-active --quiet uptime-kuma"
  badge "uptime-kuma (Docker)"      "docker ps --format '{{.Names}}' 2>/dev/null | grep -q uptime-kuma"
  badge "bockis-bot (Docker)"       "docker ps --format '{{.Names}}' 2>/dev/null | grep -q bot"
  badge "Docker Daemon"             "systemctl is-active --quiet docker"
  badge "SSH (sshd)"                "systemctl is-active --quiet ssh || systemctl is-active --quiet sshd"
  badge "ufw Firewall"              "sudo ufw status 2>/dev/null | grep -q 'Status: active'"

  echo ""
  local IP; IP=$(hostname -I | awk '{print $1}')
  info "Lokale IP: ${BOLD}$IP${NC}"
  info "Hostname:  ${BOLD}$(hostname)${NC}"
  info "Uptime:    ${BOLD}$(uptime -p)${NC}"
  pause
}

status_docker() {
  clear
  echo -e "${BOLD}${CYAN}━━ Docker Container ━━${NC}\n"
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker ist nicht installiert"; pause; return
  fi
  echo -e "${BOLD}Laufende Container:${NC}"
  docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>&1
  echo ""
  echo -e "${BOLD}Alle Container (inkl. gestoppte):${NC}"
  docker ps -a --format "table {{.Names}}\t{{.Status}}" 2>&1 | tail -10
  echo ""
  echo -e "${BOLD}Images:${NC}"
  docker images --format "table {{.Repository}}\t{{.Tag}}\t{{.Size}}" 2>&1 | head -15
  pause
}

status_resources() {
  clear
  echo -e "${BOLD}${CYAN}━━ Systemressourcen ━━${NC}\n"

  echo -e "${BOLD}Arbeitsspeicher:${NC}"
  free -h

  echo ""
  echo -e "${BOLD}CPU-Last (1/5/15 min):${NC}"
  uptime

  echo ""
  echo -e "${BOLD}Festplatte:${NC}"
  df -h --total 2>/dev/null | grep -E "(Filesystem|/dev|total)" | head -6

  echo ""
  echo -e "${BOLD}Temperatur:${NC}"
  if [[ -f /sys/class/thermal/thermal_zone0/temp ]]; then
    TEMP=$(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 ))
    if [[ $TEMP -ge 70 ]]; then
      echo -e "  ${RED}${TEMP}°C  ⚠  Überhitzungsgefahr!${NC}"
    elif [[ $TEMP -ge 60 ]]; then
      echo -e "  ${YELLOW}${TEMP}°C  (warm)${NC}"
    else
      echo -e "  ${GREEN}${TEMP}°C  (normal)${NC}"
    fi
  else
    echo "  Nicht verfügbar"
  fi

  echo ""
  echo -e "${BOLD}Top-Prozesse (CPU):${NC}"
  ps aux --sort=-%cpu 2>/dev/null | head -8
  pause
}

status_ports() {
  clear
  echo -e "${BOLD}${CYAN}━━ Offene Ports ━━${NC}\n"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnp 2>/dev/null | grep -v "^State" | head -20
  else
    netstat -tlnp 2>/dev/null | head -20
  fi
  echo ""
  echo -e "${BOLD}Firewall-Regeln (ufw):${NC}"
  sudo ufw status 2>/dev/null | head -15 || echo "  ufw nicht aktiv"
  pause
}

status_network() {
  clear
  echo -e "${BOLD}${CYAN}━━ Netzwerk ━━${NC}\n"

  echo -e "${BOLD}IP-Adressen:${NC}"
  ip -o addr show 2>/dev/null | awk '{print "  " $2 ": " $4}' | grep -v "^  lo"

  echo ""
  echo -e "${BOLD}Standard-Gateway:${NC}"
  ip route show default 2>/dev/null | awk '{print "  " $0}'

  echo ""
  echo -e "${BOLD}DNS:${NC}"
  cat /etc/resolv.conf 2>/dev/null | grep nameserver | head -3

  echo ""
  info "Internetverbindung prüfen..."
  if curl -sf --max-time 5 https://1.1.1.1 >/dev/null 2>&1 || ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1; then
    ok "Internetverbindung vorhanden"
  else
    err "Keine Internetverbindung"
  fi
  pause
}

status_health() {
  clear
  echo -e "${BOLD}${CYAN}━━ Bot Health-Check ━━${NC}\n"

  local PORT; PORT=$(grep -oP '(?<=WEB_PORT=)\d+' "$BOT_DIR/.env" 2>/dev/null || echo "$BOT_PORT")

  info "Teste http://localhost:${PORT}/health ..."
  local HEALTH; HEALTH=$(curl -sf --max-time 5 "http://localhost:${PORT}/health" 2>&1)
  if [[ $? -eq 0 ]]; then
    ok "Health-Endpunkt antwortet:"
    echo "  $HEALTH"
  else
    err "Health-Endpunkt nicht erreichbar"
    echo ""

    # ── Auto-Diagnose ────────────────────────────────────────────────────────
    local SVC_STATE; SVC_STATE=$(systemctl is-active bockis-bot 2>/dev/null || echo "inactive")

    if [[ "$SVC_STATE" != "active" ]]; then
      err "Bot-Service ist nicht aktiv  (Status: ${SVC_STATE})"
      echo ""
      info "Letzte Journal-Einträge (bockis-bot):"
      sudo journalctl -u bockis-bot -n 20 --no-pager 2>/dev/null | tail -20
      echo ""
      if whiptail --title "Bot starten?" --yesno \
        "Der Bot-Service ist nicht aktiv (${SVC_STATE}).\n\nJetzt starten?" 8 $W; then
        sudo systemctl start bockis-bot
        sleep 3
        if curl -sf --max-time 5 "http://localhost:${PORT}/health" >/dev/null; then
          ok "Bot gestartet – Health-Check OK auf Port ${PORT}"
        else
          err "Bot gestartet, antwortet aber noch nicht auf Port ${PORT}"
          info "Logs: sudo journalctl -u bockis-bot -f"
        fi
      fi
    else
      ok "Service bockis-bot ist aktiv"
      # Prüfen ob der Bot auf einem anderen Port läuft (Port-Mismatch nach Portänderung)
      local ACTUAL_PORT
      ACTUAL_PORT=$(ss -tlnp 2>/dev/null | grep -oP '(?<=:)\d+(?=.*node)' | head -1)
      if [[ -n "$ACTUAL_PORT" && "$ACTUAL_PORT" != "$PORT" ]]; then
        err "Port-Konflikt: Bot läuft auf Port ${ACTUAL_PORT}, .env hat WEB_PORT=${PORT}"
        info "Der Port wurde geändert, aber der Service läuft noch mit dem alten Port."
        echo ""
        if whiptail --title "Service neu starten?" --yesno \
          "Bot läuft auf Port ${ACTUAL_PORT}, .env hat aber WEB_PORT=${PORT}.\n\nService neu starten um Port ${PORT} zu aktivieren?" \
          10 $W; then
          sudo systemctl restart bockis-bot && ok "Bot neu gestartet (Port ${PORT})" || err "Neustart fehlgeschlagen"
        fi
      else
        err "Service aktiv, aber Port ${PORT} antwortet nicht"
        echo ""
        info "Letzte Journal-Einträge (bockis-bot):"
        sudo journalctl -u bockis-bot -n 20 --no-pager 2>/dev/null | tail -20
      fi
    fi
  fi
  pause
}

status_journal() {
  clear
  LOGS=$(sudo journalctl -p err -n 30 --no-pager 2>&1)
  show_output "Systemd-Fehler (letzte 30)" "$LOGS"
}

status_versions() {
  clear
  echo -e "${BOLD}${CYAN}━━ Versionen ━━${NC}\n"

  if command -v node >/dev/null 2>&1; then
    ok "Node.js:  $(node -v)"
  else err "Node.js:  nicht installiert"; fi

  if command -v npm >/dev/null 2>&1; then
    ok "npm:      $(npm -v)"
  else err "npm:      nicht installiert"; fi

  if command -v docker >/dev/null 2>&1; then
    ok "Docker:   $(docker --version | cut -d' ' -f3 | tr -d ',')"
  else info "Docker:   nicht installiert"; fi

  if command -v git >/dev/null 2>&1; then
    ok "git:      $(git --version | cut -d' ' -f3)"
  fi

  if [[ -f "$BOT_DIR/package.json" ]]; then
    BOT_VER=$(node -e "const p=require('$BOT_DIR/package.json'); console.log(p.version)" 2>/dev/null || echo "?")
    ok "Bot:      v$BOT_VER"
  fi

  echo ""
  info "OS: $(lsb_release -ds 2>/dev/null || uname -sr)"
  info "Kernel: $(uname -r)"
  pause
}

# ════════════════════════════════════════════════════════════════════════════════
# UPDATE-PRÜFUNG
# ════════════════════════════════════════════════════════════════════════════════

# Gibt 0 zurück wenn Updates verfügbar, 1 wenn aktuell, 2 wenn kein Git-Repo
check_update_available() {
  command -v git >/dev/null 2>&1 || return 2
  [[ -d "$BOT_DIR/.git" ]] || return 2

  # Nur fetch, kein pull — timeout 5s damit das Menü nicht hängt
  git -C "$BOT_DIR" fetch origin main --quiet 2>/dev/null || return 2

  local BEHIND
  BEHIND=$(git -C "$BOT_DIR" rev-list HEAD..origin/main --count 2>/dev/null || echo "0")
  [[ "$BEHIND" -gt 0 ]] && return 0 || return 1
}

menu_update_check() {
  clear
  echo -e "${BOLD}${CYAN}━━ Update-Prüfung ━━${NC}\n"

  command -v git >/dev/null 2>&1 || { err "git ist nicht installiert"; pause; return; }
  [[ -d "$BOT_DIR/.git" ]] || { err "Bot-Verzeichnis $BOT_DIR ist kein Git-Repository"; pause; return; }

  info "Verbinde mit GitHub..."
  if ! git -C "$BOT_DIR" fetch origin main --quiet 2>/dev/null; then
    err "Kein Netzwerkzugriff auf GitHub — Prüfung nicht möglich"
    pause; return
  fi

  local LOCAL REMOTE BEHIND AHEAD
  LOCAL=$(git -C "$BOT_DIR" rev-parse HEAD 2>/dev/null || echo "?")
  REMOTE=$(git -C "$BOT_DIR" rev-parse origin/main 2>/dev/null || echo "?")
  BEHIND=$(git -C "$BOT_DIR" rev-list HEAD..origin/main --count 2>/dev/null || echo "0")
  AHEAD=$(git -C "$BOT_DIR" rev-list origin/main..HEAD --count 2>/dev/null || echo "0")

  local LOCAL_VER REMOTE_VER
  LOCAL_VER=$(git -C "$BOT_DIR" describe --tags --always HEAD 2>/dev/null || echo "${LOCAL:0:7}")
  REMOTE_VER=$(git -C "$BOT_DIR" describe --tags --always origin/main 2>/dev/null || echo "${REMOTE:0:7}")

  echo -e "  Lokale Version:   ${BOLD}$LOCAL_VER${NC}  (${LOCAL:0:7})"
  echo -e "  Remote Version:   ${BOLD}$REMOTE_VER${NC}  (${REMOTE:0:7})"
  echo ""

  if [[ "$BEHIND" -eq 0 && "$AHEAD" -eq 0 ]]; then
    ok "Bot ist auf dem aktuellen Stand — kein Update nötig"
    pause; return
  fi

  if [[ "$BEHIND" -gt 0 ]]; then
    echo -e "  ${YELLOW}⚠  $BEHIND neue Commit(s) auf GitHub verfügbar:${NC}"
    echo ""
    # Letzte Commits anzeigen
    git -C "$BOT_DIR" log HEAD..origin/main --oneline --format="    %C(yellow)%h%Creset  %s  %C(dim)(%cr)%Creset" 2>/dev/null | head -10
    echo ""
  fi

  if [[ "$AHEAD" -gt 0 ]]; then
    echo -e "  ${CYAN}ℹ  $AHEAD lokale Commit(s) noch nicht auf GitHub gepusht${NC}"
    echo ""
  fi

  if [[ "$BEHIND" -gt 0 ]]; then
    if whiptail --title "Update verfügbar" --yesno \
      "$BEHIND neue Version(en) verfügbar.\n\nJetzt updaten?" 9 $W; then

      if [[ ! -d "$BOT_DIR" ]]; then
        # Bot-Code noch gar nicht vorhanden → Installer anbieten
        whiptail --title "Bot noch nicht installiert" --msgbox \
          "Das Bot-Verzeichnis existiert noch nicht:\n  $BOT_DIR\n\nBitte zuerst den Bot installieren (Option 3 → Bot installieren)." \
          11 $W
      elif [[ ! -f "$BOT_DIR/.env" ]]; then
        # Code vorhanden, aber noch nicht konfiguriert → git pull + npm install, kein Service-Restart
        clear
        echo -e "${BOLD}${CYAN}━━ Code-Update (ohne Neustart) ━━${NC}\n"
        info "git pull..."
        git -C "$BOT_DIR" pull origin main 2>&1 && ok "Code aktualisiert" || { err "git pull fehlgeschlagen"; pause; return; }
        echo ""
        # npm ci braucht package-lock.json → bei Erstinstallation npm install verwenden
        if [[ -f "$BOT_DIR/package-lock.json" ]]; then
          info "Abhängigkeiten installieren (npm ci)..."
          npm ci --prefix "$BOT_DIR" 2>&1 && ok "npm ci abgeschlossen" || err "npm ci fehlgeschlagen"
        else
          info "Abhängigkeiten installieren (npm install — erstmalig)..."
          npm install --prefix "$BOT_DIR" 2>&1 && ok "npm install abgeschlossen" || err "npm install fehlgeschlagen"
        fi
        echo ""
        echo -e "  ${YELLOW}ℹ  Bot-Konfiguration fehlt noch (.env).${NC}"
        echo -e "  ${YELLOW}   Bitte anschließend 'node install.js' ausführen.${NC}"
        pause
      else
        # Vollständige Installation → normales Update
        bash "$SCRIPT_DIR/update.sh" --bot-dir "$BOT_DIR" --mode auto --yes
        pause
      fi
    fi
  fi
  pause
}

# ════════════════════════════════════════════════════════════════════════════════
# HAUPTMENÜ
# ════════════════════════════════════════════════════════════════════════════════

main_menu() {
  while true; do
    # Update-Status im Hintergrund prüfen (non-blocking via tmpfile)
    local UPDATE_HINT=""
    local UPDATE_TMP; UPDATE_TMP=$(mktemp)
    { check_update_available; echo $? > "$UPDATE_TMP"; } 2>/dev/null &
    local UPDATE_PID=$!

    # Status-Zeile für Banner
    systemctl is-active --quiet bockis-bot 2>/dev/null && BOT_ST="aktiv" || BOT_ST="gestoppt"
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma" && KUMA_ST="aktiv" || KUMA_ST="gestoppt"

    # Auf Update-Check warten (max 6s)
    local WAITED=0
    while kill -0 "$UPDATE_PID" 2>/dev/null && [[ $WAITED -lt 6 ]]; do
      sleep 0.5; WAITED=$(( WAITED + 1 ))
    done
    kill "$UPDATE_PID" 2>/dev/null || true
    local UPDATE_RC=2
    [[ -s "$UPDATE_TMP" ]] && UPDATE_RC=$(cat "$UPDATE_TMP")
    rm -f "$UPDATE_TMP"

    case "$UPDATE_RC" in
      0) UPDATE_HINT="⚠  Update verfügbar → Option 7" ;;
      1) UPDATE_HINT="✓  Bot ist aktuell" ;;
      *) UPDATE_HINT="–  Update-Status unbekannt" ;;
    esac

    LIST_H=$(( H - 11 ))
    [ "$LIST_H" -lt 9 ] && LIST_H=9

    CHOICE=$(whiptail \
      --title "🤖 Bockis Discord Bot — Raspberry Pi Manager" \
      --menu "$(printf "Bot: %-8s | Uptime Kuma: %-8s | %s\n\nWas möchtest du tun?" \
              "$BOT_ST" "$KUMA_ST" "$UPDATE_HINT")" \
      $H $W $LIST_H \
      "1" "🍓   System vorbereiten     (apt, Node.js, Docker, Firewall, ...)" \
      "2" "📊   Uptime Kuma            (installieren, starten, aktualisieren)" \
      "3" "🤖   Bot-Verwaltung         (installieren, starten, Logs, Update)" \
      "4" "🔍   Status & Prüfungen     (Services, Ressourcen, Health-Check)" \
      "5" "🌐   Netzwerk & Cloudflare  (CG-NAT, Tunnel, DNS-Prüfung)" \
      "6" "🔄   Schnell-Update         (Bot + Docker in einem Schritt)" \
      "7" "🔎   Update-Prüfung         (GitHub vergleichen, neue Commits anzeigen)" \
      "8" "⚙    Einstellungen          (Bot-Verzeichnis, Ports)" \
      "9" "✗    Beenden" \
      3>&1 1>&2 2>&3) || break

    case "$CHOICE" in
      "1") menu_system ;;
      "2") menu_kuma ;;
      "3") menu_bot ;;
      "4") menu_status ;;
      "5") menu_network ;;
      "6") quick_update ;;
      "7") menu_update_check ;;
      "8") menu_settings ;;
      "9") break ;;
    esac
  done
}

# ── Hilfsfunktion: Bot-Installation prüfen ───────────────────────────────────
check_bot_installed() {
  if [[ ! -d "$BOT_DIR" ]]; then
    whiptail --title "⚠ Bot nicht installiert" --msgbox \
      "Das Bot-Verzeichnis wurde nicht gefunden:\n\n  $BOT_DIR\n\nBitte zuerst den Bot installieren:\n  → Option 3 → Bot installieren\n\n(Verzeichnis in den Einstellungen ändern → Option 8)" \
      14 $W
    return 1
  fi
  if [[ ! -f "$BOT_DIR/.env" ]]; then
    whiptail --title "⚠ Bot nicht konfiguriert" --msgbox \
      "Die Konfigurationsdatei fehlt:\n\n  $BOT_DIR/.env\n\nDer Bot-Code ist vorhanden, aber noch nicht eingerichtet.\nBitte den Installer ausführen:\n  node install.js" \
      13 $W
    return 1
  fi
  return 0
}

quick_update() {
  check_bot_installed || return

  local UPDATE_SCOPE
  UPDATE_SCOPE=$(whiptail --title "Schnell-Update" --menu \
    "Was soll aktualisiert werden?" 12 $W 2 \
    "code" "Nur Code     (git pull, schnell – kein npm)" \
    "full" "Code + npm   (git pull + npm ci, dauert laenger)" \
    3>&1 1>&2 2>&3) || return

  local SKIP_FLAG=""
  [[ "$UPDATE_SCOPE" == "code" ]] && SKIP_FLAG="--skip-npm"

  clear
  echo -e "${BOLD}${CYAN}━━ Schnell-Update ━━${NC}\n"
  bash "$SCRIPT_DIR/update.sh" --bot-dir "$BOT_DIR" --mode auto --yes $SKIP_FLAG
  pause
}

# ════════════════════════════════════════════════════════════════════════════════
# MODUL 5 — NETZWERK & CLOUDFLARE
# ════════════════════════════════════════════════════════════════════════════════

menu_network() {
  while true; do
    CHOICE=$(whiptail --title "🌐 Netzwerk & Cloudflare Tunnel" --menu \
      "CG-NAT-Erkennung, Cloudflare Tunnel, DNS-Prüfung:" $H $W 8 \
      "1" "🔍  Netzwerk & CG-NAT analysieren" \
      "2" "🔑  Cloudflare Token prüfen  (API-Validierung)" \
      "3" "🚇  Cloudflare Tunnel einrichten  (cloudflared)" \
      "4" "▶   Tunnel-Service starten / stoppen" \
      "5" "📋  Tunnel-Service Status & Logs" \
      "6" "🌍  Domain / DNS prüfen" \
      "7" "🗑   Tunnel deinstallieren" \
      "←" "Zurück zum Hauptmenü" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1") net_cgnat_check ;;
      "2") net_cf_token_check ;;
      "3") net_cf_tunnel_setup ;;
      "4") net_tunnel_startstop ;;
      "5") net_tunnel_status ;;
      "6") net_dns_check ;;
      "7") net_tunnel_uninstall ;;
      "←") return ;;
    esac
  done
}

# ── Hilfsfunktion: Öffentliche IP ermitteln ────────────────────────────────────
get_public_ip() {
  curl -sf --max-time 6 https://ifconfig.me 2>/dev/null || \
  curl -sf --max-time 6 https://api.ipify.org 2>/dev/null || \
  curl -sf --max-time 6 https://checkip.amazonaws.com 2>/dev/null || \
  echo ""
}

# ── Hilfsfunktion: IP im CG-NAT-Bereich? (100.64.0.0/10) ─────────────────────
is_cgnat_ip() {
  local IP="$1"
  python3 -c "
import sys, ipaddress
try:
    ip = ipaddress.ip_address('$IP')
    cgnat = ipaddress.ip_network('100.64.0.0/10')
    sys.exit(0 if ip in cgnat else 1)
except:
    sys.exit(1)
" 2>/dev/null
}

# ── 1. CG-NAT-Analyse ─────────────────────────────────────────────────────────
net_cgnat_check() {
  clear
  echo -e "${BOLD}${CYAN}━━ Netzwerk & CG-NAT Analyse ━━${NC}\n"

  # Lokale IPs
  echo -e "${BOLD}Lokale Netzwerk-Interfaces:${NC}"
  ip -o addr show 2>/dev/null | awk '{print "  " $2 ": " $4}' | grep -v "^  lo"
  echo ""

  # Öffentliche IP
  info "Ermittle öffentliche IP-Adresse..."
  local PUBLIC_IP
  PUBLIC_IP=$(get_public_ip)

  if [[ -z "$PUBLIC_IP" ]]; then
    err "Öffentliche IP nicht ermittelbar — keine Internetverbindung?"
    pause; return
  fi

  echo -e "  ${BOLD}Öffentliche IP:${NC}  ${BOLD}${PUBLIC_IP}${NC}"
  echo ""

  # CG-NAT-Erkennung
  if is_cgnat_ip "$PUBLIC_IP"; then
    echo -e "  ${RED}${BOLD}⚠  CG-NAT erkannt!${NC}"
    echo -e "  ${YELLOW}Die öffentliche IP ${PUBLIC_IP} liegt im RFC-6598-Bereich (100.64.0.0/10).${NC}"
    echo -e "  ${YELLOW}Das bedeutet: Dein ISP verwendet Carrier-Grade NAT.${NC}"
    echo ""
    echo -e "  Port-Weiterleitungen am Router funktionieren NICHT."
    echo -e "  Lösung: Cloudflare Tunnel (Option 3 in diesem Menü)."
  else
    # Prüfen ob normales NAT (öffentliche IP ≠ lokale IPs)
    local LOCAL_IPS
    LOCAL_IPS=$(ip -o addr show 2>/dev/null | awk '{print $4}' | cut -d'/' -f1 | grep -v '^127\.' | grep -v '^::1')
    if echo "$LOCAL_IPS" | grep -qF "$PUBLIC_IP"; then
      ok "Direkte öffentliche IP — kein NAT erkannt"
    else
      ok "Standard-NAT (kein CG-NAT) — Public IP: ${PUBLIC_IP}"
      echo -e "  ${CYAN}Port-Weiterleitung am Router ist grundsätzlich möglich.${NC}"
      echo -e "  ${CYAN}Für dynamische IPs trotzdem DynDNS oder Cloudflare Tunnel empfohlen.${NC}"
    fi
  fi

  echo ""

  # Discord-Erreichbarkeit prüfen
  info "Prüfe Discord-API Erreichbarkeit..."
  if curl -sf --max-time 8 https://discord.com/api/v10/gateway >/dev/null 2>&1; then
    ok "discord.com ist erreichbar"
  else
    err "discord.com nicht erreichbar — Internetverbindung prüfen"
  fi

  # Cloudflare erreichbar?
  info "Prüfe Cloudflare-Erreichbarkeit..."
  if curl -sf --max-time 5 https://1.1.1.1 >/dev/null 2>&1; then
    ok "Cloudflare (1.1.1.1) erreichbar"
  else
    err "Cloudflare nicht erreichbar"
  fi

  pause
}

# ── 2. Cloudflare Token prüfen ────────────────────────────────────────────────
net_cf_token_check() {
  clear
  echo -e "${BOLD}${CYAN}━━ Cloudflare API-Token prüfen ━━${NC}\n"

  echo -e "  ${CYAN}ℹ${NC}  Token erstellen unter:"
  echo -e "  ${CYAN}   https://dash.cloudflare.com/profile/api-tokens${NC}"
  echo -e "  ${DIM}   Vorlage: 'Edit zone DNS' oder eigene Berechtigungen${NC}"
  echo ""

  local CF_TOKEN
  CF_TOKEN=$(whiptail --title "Cloudflare API-Token" --passwordbox \
    "Cloudflare API-Token eingeben:\n(wird nicht gespeichert — nur zur Prüfung)" \
    10 $W "" 3>&1 1>&2 2>&3) || return

  [[ -z "$CF_TOKEN" ]] && { err "Kein Token eingegeben"; pause; return; }

  info "Prüfe Token bei Cloudflare API..."

  local RESULT HTTP_CODE
  RESULT=$(curl -sf --max-time 8 \
    -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
    -H "Authorization: Bearer ${CF_TOKEN}" \
    -H "Content-Type: application/json" 2>/dev/null)

  if [[ -z "$RESULT" ]]; then
    err "Keine Antwort von der Cloudflare API — Internetverbindung prüfen"
    pause; return
  fi

  local SUCCESS STATUS
  SUCCESS=$(echo "$RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('success',False)).lower())" 2>/dev/null)
  STATUS=$(echo "$RESULT"  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('result',{}).get('status','unbekannt'))" 2>/dev/null)

  echo ""
  if [[ "$SUCCESS" == "true" && "$STATUS" == "active" ]]; then
    ok "Token ist GÜLTIG und aktiv"

    # Zugehörige Account-ID und E-Mail anzeigen
    local ACCT_RESULT
    ACCT_RESULT=$(curl -sf --max-time 8 \
      -X GET "https://api.cloudflare.com/client/v4/accounts" \
      -H "Authorization: Bearer ${CF_TOKEN}" \
      -H "Content-Type: application/json" 2>/dev/null)

    local ACCT_NAME ACCT_ID
    ACCT_NAME=$(echo "$ACCT_RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin).get('result',[]); print(r[0]['name'] if r else '–')" 2>/dev/null || echo "–")
    ACCT_ID=$(echo "$ACCT_RESULT"   | python3 -c "import sys,json; r=json.load(sys.stdin).get('result',[]); print(r[0]['id']   if r else '–')" 2>/dev/null || echo "–")

    echo -e "  ${BOLD}Account:${NC}     $ACCT_NAME"
    echo -e "  ${BOLD}Account-ID:${NC}  $ACCT_ID"
    echo ""
    echo -e "  ${DIM}Die Account-ID wird für die Tunnel-Einrichtung benötigt.${NC}"
  else
    err "Token ungültig oder inaktiv (Status: $STATUS)"
    echo -e "  ${DIM}Antwort: $RESULT${NC}"
  fi

  pause
}

# ── 3. Cloudflare Tunnel einrichten ──────────────────────────────────────────
net_cf_tunnel_setup() {
  clear
  echo -e "${BOLD}${CYAN}━━ Cloudflare Tunnel einrichten ━━${NC}\n"

  # cloudflared installieren?
  if ! command -v cloudflared >/dev/null 2>&1; then
    if ! whiptail --title "cloudflared installieren" --yesno \
      "cloudflared ist nicht installiert.\n\nJetzt über das offizielle Cloudflare-Repository installieren?" \
      10 $W; then return; fi

    info "Füge Cloudflare APT-Repository hinzu..."
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | \
      sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null 2>&1
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | \
      sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    sudo apt-get update -qq 2>/dev/null
    sudo apt-get install -y cloudflared 2>&1 | tail -3
    ok "cloudflared installiert: $(cloudflared --version 2>/dev/null | head -1)"
  else
    ok "cloudflared bereits installiert: $(cloudflared --version 2>/dev/null | head -1)"
  fi

  echo ""

  # Einrichtungsmethode wählen
  local METHOD
  METHOD=$(whiptail --title "Einrichtungsmethode" --menu \
"Wie soll der Tunnel eingerichtet werden?\n
  Methode A (empfohlen für Einsteiger):
    Tunnel im Cloudflare Zero Trust Dashboard anlegen,
    Token kopieren → hier einfügen → fertig.

  Methode B (für Fortgeschrittene):
    cloudflared führt Browser-Login durch,
    Tunnel wird lokal per CLI verwaltet." \
    18 $W 2 \
    "A" "Token-Methode  (Zero Trust Dashboard → Token einfügen)" \
    "B" "CLI-Methode    (cloudflared tunnel login via Browser)" \
    3>&1 1>&2 2>&3) || return

  case "$METHOD" in
    "A") _cf_tunnel_token_method ;;
    "B") _cf_tunnel_cli_method ;;
  esac
}

_cf_tunnel_token_method() {
  clear
  echo -e "${BOLD}${CYAN}━━ Tunnel via Token (Zero Trust) ━━${NC}\n"
  echo -e "  ${CYAN}Schritt-für-Schritt:${NC}"
  echo -e "  1. Öffne: ${BOLD}https://one.dash.cloudflare.com/${NC}"
  echo -e "  2. Networks → Tunnels → 'Create a Tunnel'"
  echo -e "  3. Wähle 'cloudflared' → Tunnel benennen (z.B. 'bockis-bot')"
  echo -e "  4. Betriebssystem: Debian, Architektur: arm64 (für Raspi) oder amd64"
  echo -e "  5. Den langen Token aus dem Installations-Befehl kopieren"
  echo -e "     (nur den Teil nach --token)"
  echo -e "  6. Public Hostnames konfigurieren:"
  echo -e "     Subdomain: uptime.deinedomain.de → Service: http://localhost:3001"
  echo ""
  read -rp "  Enter drücken wenn Token bereit ist..."

  local TUNNEL_TOKEN
  TUNNEL_TOKEN=$(whiptail --title "Tunnel-Token einfügen" --passwordbox \
    "Tunnel-Token aus dem Zero Trust Dashboard einfügen:" \
    10 $W "" 3>&1 1>&2 2>&3) || return

  [[ -z "$TUNNEL_TOKEN" ]] && { err "Kein Token eingegeben"; pause; return; }

  clear
  echo -e "${BOLD}${CYAN}━━ cloudflared Service installieren ━━${NC}\n"

  info "Installiere cloudflared als systemd-Service..."
  if sudo cloudflared service install "$TUNNEL_TOKEN" 2>&1 | tail -5; then
    sudo systemctl enable cloudflared 2>/dev/null
    sudo systemctl start cloudflared 2>/dev/null
    sleep 2
    if systemctl is-active --quiet cloudflared; then
      ok "Cloudflare Tunnel läuft als systemd-Service!"
      ok "Public Hostnames sind jetzt erreichbar."
    else
      err "Service gestartet, aber Status prüfen:"
      sudo systemctl status cloudflared --no-pager -l | tail -10
    fi
  else
    err "Installation fehlgeschlagen — Token korrekt?"
  fi
  pause
}

_cf_tunnel_cli_method() {
  clear
  echo -e "${BOLD}${CYAN}━━ Tunnel via CLI-Login ━━${NC}\n"

  local TUNNEL_NAME
  TUNNEL_NAME=$(whiptail --title "Tunnel benennen" --inputbox \
    "Name für den Cloudflare Tunnel:" \
    8 $W "bockis-bot" 3>&1 1>&2 2>&3) || return

  info "Starte cloudflared Tunnel Login..."
  echo -e "  ${YELLOW}⚠  Ein Browser-Link wird angezeigt — bitte im Browser öffnen und autorisieren.${NC}"
  echo ""
  cloudflared tunnel login

  if [[ ! -f "$HOME/.cloudflared/cert.pem" ]]; then
    err "Login fehlgeschlagen — cert.pem nicht gefunden"
    pause; return
  fi
  ok "Login erfolgreich"

  info "Erstelle Tunnel: $TUNNEL_NAME ..."
  cloudflared tunnel create "$TUNNEL_NAME" 2>&1 | tail -5

  local TUNNEL_ID
  TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
  [[ -z "$TUNNEL_ID" ]] && { err "Tunnel-ID nicht ermittelbar"; pause; return; }
  ok "Tunnel erstellt — ID: $TUNNEL_ID"

  # Uptime Kuma Domain routen
  local DOMAIN
  DOMAIN=$(whiptail --title "Domain für Uptime Kuma" --inputbox \
    "Subdomain für Uptime Kuma eingeben:\n(z.B. uptime.deinedomain.de)" \
    9 $W "" 3>&1 1>&2 2>&3) || return

  if [[ -n "$DOMAIN" ]]; then
    info "Richte DNS-Route ein: $DOMAIN → localhost:3001"
    cloudflared tunnel route dns "$TUNNEL_NAME" "$DOMAIN" 2>&1 | tail -3
    ok "DNS-Route eingerichtet"
  fi

  # Config-Datei schreiben
  local CF_CONFIG="$HOME/.cloudflared/config.yml"
  info "Schreibe Konfigurationsdatei $CF_CONFIG ..."
  sudo mkdir -p /etc/cloudflared
  cat > "$CF_CONFIG" <<EOF
tunnel: ${TUNNEL_ID}
credentials-file: ${HOME}/.cloudflared/${TUNNEL_ID}.json
ingress:
  - hostname: ${DOMAIN}
    service: http://localhost:${KUMA_PORT}
  - service: http_status:404
EOF
  sudo cp "$CF_CONFIG" /etc/cloudflared/config.yml
  ok "Konfiguration gespeichert"

  # Service installieren
  info "Installiere als systemd-Service..."
  sudo cloudflared service install 2>&1 | tail -3
  sudo systemctl start cloudflared 2>/dev/null
  systemctl is-active --quiet cloudflared && \
    ok "Cloudflare Tunnel Service läuft!" || \
    err "Service prüfen: sudo systemctl status cloudflared"

  pause
}

# ── 4. Tunnel starten / stoppen ───────────────────────────────────────────────
net_tunnel_startstop() {
  command -v cloudflared >/dev/null 2>&1 || { err "cloudflared nicht installiert"; pause; return; }

  local ACTION
  ACTION=$(whiptail --title "Tunnel-Service" --menu "Aktion wählen:" 10 $W 3 \
    "start"   "Tunnel starten" \
    "stop"    "Tunnel stoppen" \
    "restart" "Tunnel neu starten" \
    3>&1 1>&2 2>&3) || return

  clear
  sudo systemctl "$ACTION" cloudflared 2>&1 && \
    ok "cloudflared $ACTION erfolgreich" || \
    err "Fehler bei: systemctl $ACTION cloudflared"
  pause
}

# ── 5. Tunnel Status & Logs ───────────────────────────────────────────────────
net_tunnel_status() {
  clear
  echo -e "${BOLD}${CYAN}━━ Cloudflare Tunnel Status ━━${NC}\n"

  command -v cloudflared >/dev/null 2>&1 || { err "cloudflared nicht installiert"; pause; return; }

  echo -e "${BOLD}cloudflared Version:${NC}"
  echo "  $(cloudflared --version 2>/dev/null | head -1)"
  echo ""

  echo -e "${BOLD}Service-Status:${NC}"
  if systemctl is-active --quiet cloudflared 2>/dev/null; then
    ok "cloudflared Service läuft"
  else
    err "cloudflared Service gestoppt"
  fi
  echo ""

  echo -e "${BOLD}Tunnel-Liste:${NC}"
  cloudflared tunnel list 2>/dev/null | head -10 || echo "  (keine Tunnel oder nicht eingeloggt)"
  echo ""

  # Logs anzeigen
  local LOGS
  LOGS=$(sudo journalctl -u cloudflared -n 40 --no-pager 2>&1)
  show_output "cloudflared Logs (letzte 40 Zeilen)" "$LOGS"
}

# ── 6. DNS / Domain prüfen ────────────────────────────────────────────────────
net_dns_check() {
  clear
  echo -e "${BOLD}${CYAN}━━ Domain & DNS Prüfung ━━${NC}\n"

  local DOMAIN
  DOMAIN=$(whiptail --title "Domain eingeben" --inputbox \
    "Domain oder Subdomain prüfen:\n(z.B. uptime.deinedomain.de)" \
    9 $W "" 3>&1 1>&2 2>&3) || return

  [[ -z "$DOMAIN" ]] && { err "Keine Domain eingegeben"; pause; return; }

  clear
  echo -e "${BOLD}${CYAN}━━ DNS-Prüfung: $DOMAIN ━━${NC}\n"

  # DNS-Auflösung
  info "DNS-Auflösung..."
  local RESOLVED_IPS
  if command -v dig >/dev/null 2>&1; then
    RESOLVED_IPS=$(dig +short "$DOMAIN" 2>/dev/null | grep -E '^[0-9]+\.' | head -5)
  elif command -v host >/dev/null 2>&1; then
    RESOLVED_IPS=$(host "$DOMAIN" 2>/dev/null | grep 'has address' | awk '{print $NF}' | head -5)
  elif command -v nslookup >/dev/null 2>&1; then
    RESOLVED_IPS=$(nslookup "$DOMAIN" 2>/dev/null | awk '/^Address: / {print $2}' | grep -v '#' | head -5)
  else
    RESOLVED_IPS=""
    err "Kein DNS-Tool verfügbar (dig/host/nslookup) — installieren: sudo apt-get install -y dnsutils"
  fi

  if [[ -n "$RESOLVED_IPS" ]]; then
    ok "Domain löst auf:"
    echo "$RESOLVED_IPS" | while read -r IP; do echo "    → $IP"; done
  else
    err "Domain nicht auflösbar — DNS-Eintrag prüfen"
  fi
  echo ""

  # CNAME-Check (Cloudflare Tunnel)
  info "CNAME-Prüfung (Cloudflare Tunnel)..."
  local CNAME
  if command -v dig >/dev/null 2>&1; then
    CNAME=$(dig +short CNAME "$DOMAIN" 2>/dev/null | head -1)
  fi
  if [[ -n "$CNAME" ]]; then
    ok "CNAME gefunden: $CNAME"
    echo "$CNAME" | grep -qi "cloudflare\|cfargotunnel\|trycloudflare" && \
      ok "→ Cloudflare Tunnel CNAME erkannt ✓" || \
      info "→ CNAME zeigt nicht auf Cloudflare"
  else
    info "Kein CNAME-Eintrag (A-Record oder direkter Eintrag)"
  fi
  echo ""

  # HTTP-Erreichbarkeit
  info "HTTP-Erreichbarkeit prüfen (https://$DOMAIN)..."
  local HTTP_CODE
  HTTP_CODE=$(curl -o /dev/null -sf -w "%{http_code}" --max-time 10 "https://$DOMAIN" 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "301" || "$HTTP_CODE" == "302" ]]; then
    ok "HTTPS erreichbar → HTTP-Status: $HTTP_CODE"
  elif [[ "$HTTP_CODE" == "000" ]]; then
    err "Domain nicht erreichbar (Timeout / kein TLS)"
  else
    info "HTTP-Status: $HTTP_CODE (z.B. Auth-geschützt oder Redirect)"
  fi
  echo ""

  # Öffentliche IP vs. aufgelöste IP vergleichen
  info "Vergleiche mit öffentlicher IP..."
  local PUBLIC_IP
  PUBLIC_IP=$(get_public_ip)
  if [[ -n "$PUBLIC_IP" && -n "$RESOLVED_IPS" ]]; then
    if echo "$RESOLVED_IPS" | grep -qF "$PUBLIC_IP"; then
      ok "Aufgelöste IP stimmt mit öffentlicher IP überein ($PUBLIC_IP)"
    else
      info "Aufgelöste IP stimmt NICHT mit öffentlicher IP überein"
      info "→ Öffentliche IP:   $PUBLIC_IP"
      info "→ Aufgelöste IP(s): $(echo "$RESOLVED_IPS" | tr '\n' ' ')"
      info "→ Das ist normal bei Cloudflare Proxy / Tunnel"
    fi
  fi

  pause
}

# ── 7. Tunnel deinstallieren ──────────────────────────────────────────────────
net_tunnel_uninstall() {
  command -v cloudflared >/dev/null 2>&1 || { err "cloudflared nicht installiert"; pause; return; }

  whiptail --title "⚠ Tunnel deinstallieren" --yesno \
    "cloudflared Service und apt-Paket entfernen?\n\nTunnel-Konfigurationen unter ~/.cloudflared/ bleiben erhalten." \
    10 $W || return

  clear
  info "Stoppe und entferne cloudflared Service..."
  sudo cloudflared service uninstall 2>/dev/null || true
  sudo systemctl stop cloudflared 2>/dev/null || true
  sudo systemctl disable cloudflared 2>/dev/null || true
  sudo rm -f /etc/systemd/system/cloudflared.service
  sudo systemctl daemon-reload

  info "Entferne cloudflared Paket..."
  sudo apt-get remove -y cloudflared 2>&1 | tail -3
  sudo rm -f /etc/apt/sources.list.d/cloudflared.list
  sudo rm -f /usr/share/keyrings/cloudflare-main.gpg

  ok "cloudflared vollständig entfernt"
  info "Konfigurationen unter ~/.cloudflared/ sind noch vorhanden."
  pause
}



# ─────────────────────────────────────────────────────────────────────────────
# Discord-Konfiguration nachträglich ändern
# ─────────────────────────────────────────────────────────────────────────────
menu_discord_config() {
  if [[ ! -f "$BOT_DIR/.env" ]]; then
    whiptail --title "⚠ .env nicht gefunden" --msgbox \
      "Die Datei $BOT_DIR/.env existiert nicht.\n\nBitte zuerst den Bot über Schritt 3 (Bot-Verwaltung → Installieren) einrichten." \
      10 $W
    return
  fi

  # Aktuelle Werte aus .env lesen (Token maskieren)
  _dc_get() { grep -E "^${1}=" "$BOT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'"; }
  local CUR_TOKEN CUR_STATUS CUR_NOTIF CUR_KUMA CUR_TOKEN_SHOW
  CUR_TOKEN=$(_dc_get DISCORD_TOKEN)
  CUR_STATUS=$(_dc_get STATUS_CHANNEL_ID)
  CUR_NOTIF=$(_dc_get DISCORD_NOTIFICATION_CHANNEL)
  CUR_KUMA=$(_dc_get UPTIME_KUMA_URL)

  # Token maskieren: erste 6 + *** + letzte 4 Zeichen
  if [[ ${#CUR_TOKEN} -gt 10 ]]; then
    CUR_TOKEN_SHOW="${CUR_TOKEN:0:6}$(printf '%0.s*' $(seq 1 $((${#CUR_TOKEN}-10))))${CUR_TOKEN: -4}"
  else
    CUR_TOKEN_SHOW="${CUR_TOKEN:0:3}***"
  fi

  while true; do
    local SUBMENU_CHOICE
    SUBMENU_CHOICE=$(whiptail --title "🔑 Discord-Konfiguration" \
      --menu "Aktuell gespeicherte Werte:\n  Token: $CUR_TOKEN_SHOW\n  Status-Ch: ${CUR_STATUS:-nicht gesetzt}\n  Notif-Ch:  ${CUR_NOTIF:-nicht gesetzt}\n  Kuma-URL:  ${CUR_KUMA:-nicht gesetzt}" \
      18 $W 5 \
      "1" "Discord Bot-Token ändern" \
      "2" "Status-Channel-ID ändern      (aktuell: ${CUR_STATUS:-nicht gesetzt})" \
      "3" "Benachrichtigungs-Channel-ID  (aktuell: ${CUR_NOTIF:-nicht gesetzt})" \
      "4" "Uptime Kuma URL ändern        (aktuell: ${CUR_KUMA:-nicht gesetzt})" \
      "←" "Zurück" \
      3>&1 1>&2 2>&3) || return

    case "$SUBMENU_CHOICE" in
      "1")
        local NEW_TOKEN
        NEW_TOKEN=$(whiptail --title "Discord Bot-Token" --passwordbox \
          "Neuen Bot-Token eingeben:\n(Discord Developer Portal → Deine App → Bot → Token)" \
          10 $W 3>&1 1>&2 2>&3) || continue
        NEW_TOKEN=$(echo "$NEW_TOKEN" | tr -d '[:space:]')
        [[ -z "$NEW_TOKEN" ]] && { whiptail --title "Abgebrochen" --msgbox "Kein Token eingegeben — keine Änderung." 7 $W; continue; }
        _dc_write DISCORD_TOKEN "$NEW_TOKEN"
        CUR_TOKEN="$NEW_TOKEN"
        CUR_TOKEN_SHOW="${NEW_TOKEN:0:6}$(printf '%0.s*' $(seq 1 $((${#NEW_TOKEN}-10))))${NEW_TOKEN: -4}"
        ok "DISCORD_TOKEN aktualisiert"
        _dc_restart_bot
        ;;
      "2")
        local NEW_STATUS
        NEW_STATUS=$(whiptail --title "Status-Channel-ID" --inputbox \
          "Channel-ID für die gepinnte Status-Nachricht:\n(Discord: Entwicklermodus → Rechtsklick auf Channel → ID kopieren)" \
          10 $W "$CUR_STATUS" 3>&1 1>&2 2>&3) || continue
        NEW_STATUS=$(echo "$NEW_STATUS" | tr -d '[:space:]')
        if ! echo "$NEW_STATUS" | grep -qE '^[0-9]+$'; then
          whiptail --title "Ungültige ID" --msgbox "Channel-IDs bestehen nur aus Zahlen." 7 $W; continue
        fi
        _dc_write STATUS_CHANNEL_ID "$NEW_STATUS"
        CUR_STATUS="$NEW_STATUS"
        ok "STATUS_CHANNEL_ID aktualisiert"
        _dc_restart_bot
        ;;
      "3")
        local NEW_NOTIF
        NEW_NOTIF=$(whiptail --title "Benachrichtigungs-Channel-ID" --inputbox \
          "Channel-ID für Statusänderungs-Benachrichtigungen:\n(Kann dieselbe ID wie der Status-Channel sein.)" \
          10 $W "$CUR_NOTIF" 3>&1 1>&2 2>&3) || continue
        NEW_NOTIF=$(echo "$NEW_NOTIF" | tr -d '[:space:]')
        if ! echo "$NEW_NOTIF" | grep -qE '^[0-9]+$'; then
          whiptail --title "Ungültige ID" --msgbox "Channel-IDs bestehen nur aus Zahlen." 7 $W; continue
        fi
        _dc_write DISCORD_NOTIFICATION_CHANNEL "$NEW_NOTIF"
        CUR_NOTIF="$NEW_NOTIF"
        ok "DISCORD_NOTIFICATION_CHANNEL aktualisiert"
        _dc_restart_bot
        ;;
      "4")
        local NEW_KUMA
        NEW_KUMA=$(whiptail --title "Uptime Kuma URL" --inputbox \
          "URL der Uptime Kuma Instanz:\n(z.B. http://192.168.1.50:3001 oder https://uptime.deinedomain.de)" \
          10 $W "$CUR_KUMA" 3>&1 1>&2 2>&3) || continue
        NEW_KUMA=$(echo "$NEW_KUMA" | tr -d '[:space:]')
        if ! echo "$NEW_KUMA" | grep -qE '^https?://'; then
          whiptail --title "Ungültige URL" --msgbox "URL muss mit http:// oder https:// beginnen." 7 $W; continue
        fi
        _dc_write UPTIME_KUMA_URL "$NEW_KUMA"
        CUR_KUMA="$NEW_KUMA"
        ok "UPTIME_KUMA_URL aktualisiert"
        _dc_restart_bot
        ;;
      "←") return ;;
    esac
  done
}

# Hilfsfunktion: Wert in .env schreiben oder ergänzen
_dc_write() {
  local KEY="$1" VAL="$2"
  if grep -q "^${KEY}=" "$BOT_DIR/.env"; then
    sed -i "s|^${KEY}=.*|${KEY}=${VAL}|" "$BOT_DIR/.env"
  else
    echo "${KEY}=${VAL}" >> "$BOT_DIR/.env"
  fi
}

# Hilfsfunktion: Bot neu starten wenn er läuft
_dc_restart_bot() {
  if systemctl is-active --quiet bockis-bot 2>/dev/null; then
    info "Bot-Service wird neu gestartet..."
    sudo systemctl restart bockis-bot 2>/dev/null && ok "Bot neu gestartet" || err "Neustart fehlgeschlagen"
  else
    info "Bot läuft nicht — Änderung wird beim nächsten Start aktiv."
  fi
  sleep 1
}

menu_settings() {
  while true; do
    # Werte live aus .env lesen wenn vorhanden
    local ENV_WEB_PORT ENV_KUMA_URL
    if [[ -f "$BOT_DIR/.env" ]]; then
      ENV_WEB_PORT=$(grep -E '^WEB_PORT=' "$BOT_DIR/.env" 2>/dev/null | cut -d'=' -f2 | tr -d '"' | tr -d "'")
      [[ -n "$ENV_WEB_PORT" ]] && WEB_PORT="$ENV_WEB_PORT"
      ENV_KUMA_URL=$(grep -E '^UPTIME_KUMA_URL=' "$BOT_DIR/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    fi

    local IP; IP=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "<IP>")
    local WEB_LABEL="http://${IP}:${WEB_PORT}/dashboard"
    local KUMA_LABEL="Port ${KUMA_PORT}"
    [[ -n "${ENV_KUMA_URL:-}" ]] && KUMA_LABEL="extern: $ENV_KUMA_URL"

    CHOICE=$(whiptail --title "⚙ Einstellungen" --menu "Konfiguration anpassen:" 17 $W 6 \
      "1" "Bot-Verzeichnis ändern      (aktuell: $BOT_DIR)" \
      "2" "Bot-Port ändern             (aktuell: $BOT_PORT)" \
      "3" "Uptime-Kuma-Port ändern    (aktuell: $KUMA_LABEL)" \
      "4" "Web-Dashboard-Port ändern  (aktuell: $WEB_PORT  →  $WEB_LABEL)" \
      "5" "🔑  Discord-Token / Channel-IDs ändern" \
      "←" "Zurück" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1")
        NEW=$(whiptail --title "Bot-Verzeichnis" --inputbox "Pfad:" 8 $W "$BOT_DIR" 3>&1 1>&2 2>&3) && BOT_DIR="$NEW"
        ;;
      "2")
        NEW=$(whiptail --title "Bot-Port" --inputbox \
          "Port des Bot-Prozesses (intern, für systemd/Docker):" \
          8 $W "$BOT_PORT" 3>&1 1>&2 2>&3) && BOT_PORT="$NEW"
        ;;
      "3")
        NEW=$(whiptail --title "Kuma-Port" --inputbox \
          "Port der lokalen Uptime Kuma Instanz:\n(Externe URL ändern via: Uptime Kuma → Externe Instanz konfigurieren)" \
          9 $W "$KUMA_PORT" 3>&1 1>&2 2>&3) && KUMA_PORT="$NEW"
        ;;
      "4")
        NEW=$(whiptail --title "Web-Dashboard-Port" --inputbox \
          "Port des Bot-Webinterface / Dashboards:\n(Standard: 3000  →  erreichbar unter http://<IP>:PORT/dashboard)" \
          9 $W "$WEB_PORT" 3>&1 1>&2 2>&3) || continue
        # Nur Zahlen akzeptieren
        if ! echo "$NEW" | grep -qE '^[0-9]+$' || [[ "$NEW" -lt 1024 || "$NEW" -gt 65535 ]]; then
          whiptail --title "Ungültiger Port" --msgbox \
            "Bitte einen Port zwischen 1024 und 65535 eingeben." 8 $W
          continue
        fi
        WEB_PORT="$NEW"
        BOT_PORT="$NEW"   # beide sind identisch (WEB_PORT steuert den Express-Server)
        # In .env schreiben wenn vorhanden
        if [[ -f "$BOT_DIR/.env" ]]; then
          if grep -q '^WEB_PORT=' "$BOT_DIR/.env"; then
            sed -i "s|^WEB_PORT=.*|WEB_PORT=${WEB_PORT}|" "$BOT_DIR/.env"
          else
            echo "WEB_PORT=${WEB_PORT}" >> "$BOT_DIR/.env"
          fi
          ok "WEB_PORT=${WEB_PORT} in .env gespeichert"
          # UFW-Regel aktualisieren wenn UFW aktiv
          if command -v ufw >/dev/null 2>&1 && sudo ufw status 2>/dev/null | grep -q 'Status: active'; then
            info "Aktualisiere UFW-Regel..."
            sudo ufw allow "${WEB_PORT}/tcp" >/dev/null 2>&1 && \
              ok "UFW: Port ${WEB_PORT}/tcp freigegeben"
          fi
          # Bot-Service neu starten wenn aktiv
          if systemctl is-active --quiet bockis-bot 2>/dev/null; then
            info "Bot-Service neu starten (neuer Port wird aktiv)..."
            sudo systemctl restart bockis-bot 2>/dev/null && ok "Bot neu gestartet" || err "Neustart fehlgeschlagen"
          fi
          local IP2; IP2=$(hostname -I | awk '{print $1}' 2>/dev/null || echo "<IP>")
          whiptail --title "✔ Dashboard-Port geändert" --msgbox \
            "Web-Dashboard erreichbar unter:\n\n  http://${IP2}:${WEB_PORT}/dashboard" \
            9 $W
        else
          info ".env noch nicht vorhanden — Port-Änderung wird bei nächstem Start aktiv"
          pause
        fi
        ;;
      "5") menu_discord_config ;;
      "←") return ;;
    esac
  done
}

# ── Einstiegspunkt ────────────────────────────────────────────────────────────
main_menu
clear
echo -e "${GREEN}Bis bald! 👋${NC}"
