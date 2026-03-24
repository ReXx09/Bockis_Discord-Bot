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
LOG_LINES=50

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-dir) BOT_DIR="$2"; shift 2 ;;
    *) echo "Unbekannte Option: $1"; exit 1 ;;
  esac
done

# Fenstermaße
W=70; H=20

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
  whiptail --title "✓ Vorbereitung abgeschlossen" --msgbox \
    "Das System ist bereit!\n\nNächste Schritte:\n  • Uptime Kuma installieren (Menü → Uptime Kuma)\n  • Bot installieren (Menü → Bot-Verwaltung → Installieren)" \
    12 $W
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

    CHOICE=$(whiptail --title "📊 Uptime Kuma  [$KUMA_STATUS]" --menu \
      "Uptime Kuma Monitoring-Plattform verwalten:" $H $W 8 \
      "1" "Status & Verbindung prüfen" \
      "2" "Mit Docker installieren  (empfohlen)" \
      "3" "Uptime Kuma starten" \
      "4" "Uptime Kuma stoppen" \
      "5" "Uptime Kuma aktualisieren" \
      "6" "Logs anzeigen" \
      "7" "Deinstallieren" \
      "←" "Zurück zum Hauptmenü" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1") kuma_status ;;
      "2") kuma_install_docker ;;
      "3") kuma_start ;;
      "4") kuma_stop ;;
      "5") kuma_update ;;
      "6") kuma_logs ;;
      "7") kuma_uninstall ;;
      "←") return ;;
    esac
  done
}

kuma_status() {
  clear
  echo -e "${BOLD}${CYAN}━━ Uptime Kuma Status ━━${NC}\n"

  local IP; IP=$(hostname -I | awk '{print $1}')

  # Docker
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    ok "Container läuft (Docker)"
    docker ps --filter "name=uptime-kuma" --format "  Image: {{.Image}}\n  Status: {{.Status}}\n  Ports: {{.Ports}}"
    echo ""
    ok "Erreichbar unter: http://${IP}:${KUMA_PORT}"
  elif docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "uptime-kuma"; then
    err "Container existiert, ist aber gestoppt"
    echo "  Starten: docker start uptime-kuma"
  elif systemctl is-active --quiet uptime-kuma 2>/dev/null; then
    ok "systemd-Service aktiv"
  else
    err "Uptime Kuma ist nicht installiert oder nicht gestartet"
    echo ""
    echo "  Installieren über: Menü → Uptime Kuma → Mit Docker installieren"
  fi

  # HTTP-Erreichbarkeit prüfen
  echo ""
  info "Prüfe HTTP-Verbindung auf Port ${KUMA_PORT}..."
  if curl -sf --max-time 5 "http://localhost:${KUMA_PORT}" >/dev/null 2>&1; then
    ok "http://localhost:${KUMA_PORT} antwortet"
  else
    err "http://localhost:${KUMA_PORT} nicht erreichbar"
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
  clear
  [[ -f "$BOT_DIR/bot.js" ]] || { err "Bot nicht installiert"; pause; return; }

  UPDATE_MODE=$(whiptail --title "Update-Modus" --menu \
    "Wie soll der Bot aktualisiert werden?" 12 $W 3 \
    "native" "systemd  (git pull + npm ci + service restart)" \
    "docker" "Docker   (docker compose pull + up --build)" \
    "auto"   "Automatisch erkennen" \
    3>&1 1>&2 2>&3) || return

  bash "$SCRIPT_DIR/update.sh" --bot-dir "$BOT_DIR" --mode "$UPDATE_MODE" --yes
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
    info "Ist der Bot gestartet?  →  sudo systemctl status bockis-bot"
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
      bash "$SCRIPT_DIR/update.sh" --bot-dir "$BOT_DIR" --mode auto --yes
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
      0) UPDATE_HINT="  ⚠  Bot-Update verfügbar! → Option 5" ;;
      1) UPDATE_HINT="  ✓  Bot ist aktuell" ;;
      *) UPDATE_HINT="  –  Update-Status unbekannt (kein Git/Netz)" ;;
    esac

    CHOICE=$(whiptail \
      --title "🤖 Bockis Discord Bot — Raspberry Pi Manager" \
      --menu "$(printf "Bot: %-10s  |  Uptime Kuma: %-10s\n%s\nWas möchtest du tun?" \
              "$BOT_ST" "$KUMA_ST" "$UPDATE_HINT")" \
      $H $W 9 \
      "1" "🍓  System vorbereiten     (apt, Node.js, Docker, Firewall, ...)" \
      "2" "📊  Uptime Kuma            (installieren, starten, aktualisieren)" \
      "3" "🤖  Bot-Verwaltung         (installieren, starten, Logs, Update)" \
      "4" "🔍  Status & Prüfungen     (Services, Ressourcen, Health-Check)" \
      "5" "🔄  Schnell-Update         (Bot + Docker in einem Schritt)" \
      "6" "🔎  Update-Prüfung         (GitHub vergleichen, neue Commits anzeigen)" \
      "7" "⚙   Einstellungen          (Bot-Verzeichnis, Ports)" \
      "8" "✗   Beenden" \
      3>&1 1>&2 2>&3) || break

    case "$CHOICE" in
      "1") menu_system ;;
      "2") menu_kuma ;;
      "3") menu_bot ;;
      "4") menu_status ;;
      "5") quick_update ;;
      "6") menu_update_check ;;
      "7") menu_settings ;;
      "8") break ;;
    esac
  done
}

quick_update() {
  if ! whiptail --title "Schnell-Update" --yesno \
    "Bot und Docker-Container werden jetzt aktualisiert.\n\nFortfahren?" 9 $W; then return; fi
  clear
  echo -e "${BOLD}${CYAN}━━ Schnell-Update ━━${NC}\n"
  bash "$SCRIPT_DIR/update.sh" --bot-dir "$BOT_DIR" --mode auto --yes
  pause
}

menu_settings() {
  while true; do
    CHOICE=$(whiptail --title "⚙ Einstellungen" --menu "Konfiguration anpassen:" 12 $W 4 \
      "1" "Bot-Verzeichnis ändern  (aktuell: $BOT_DIR)" \
      "2" "Bot-Port ändern         (aktuell: $BOT_PORT)" \
      "3" "Uptime-Kuma-Port ändern (aktuell: $KUMA_PORT)" \
      "←" "Zurück" \
      3>&1 1>&2 2>&3) || return

    case "$CHOICE" in
      "1")
        NEW=$(whiptail --title "Bot-Verzeichnis" --inputbox "Pfad:" 8 $W "$BOT_DIR" 3>&1 1>&2 2>&3) && BOT_DIR="$NEW"
        ;;
      "2")
        NEW=$(whiptail --title "Bot-Port" --inputbox "Port:" 8 $W "$BOT_PORT" 3>&1 1>&2 2>&3) && BOT_PORT="$NEW"
        ;;
      "3")
        NEW=$(whiptail --title "Kuma-Port" --inputbox "Port:" 8 $W "$KUMA_PORT" 3>&1 1>&2 2>&3) && KUMA_PORT="$NEW"
        ;;
      "←") return ;;
    esac
  done
}

# ── Einstiegspunkt ────────────────────────────────────────────────────────────
main_menu
clear
echo -e "${GREEN}Bis bald! 👋${NC}"
