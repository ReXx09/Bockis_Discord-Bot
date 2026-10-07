#!/usr/bin/env bash
# repair-bot.sh - Diagnose und sichere Reparatur fuer eine native systemd-Installation
set -u

BOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="check"
AUTO_YES=false

usage() {
  cat <<'EOF'
Verwendung: bash repair-bot.sh [Optionen]

  --bot-dir PFAD   Bot-Verzeichnis (Standard: Verzeichnis dieses Skripts)
  --repair         erkannte Reparaturen nach Bestaetigung ausfuehren
  --yes            Bestaetigungen automatisch bestaetigen
  --check          nur pruefen (Standard)
  --help           Hilfe anzeigen
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-dir) [[ $# -ge 2 ]] || { echo "--bot-dir benoetigt einen Pfad" >&2; exit 2; }; BOT_DIR="$2"; shift 2 ;;
    --repair) MODE="repair"; shift ;;
    --yes) AUTO_YES=true; shift ;;
    --check) MODE="check"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unbekannte Option: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ "$BOT_DIR" != /* ]]; then
  BOT_DIR="$(cd "$BOT_DIR" 2>/dev/null && pwd)" || { echo "Bot-Verzeichnis nicht gefunden" >&2; exit 1; }
fi

SERVICE="bockis-bot"
ENV_FILE="$BOT_DIR/.env"
NODE_PROCS=()

info()  { printf '[INFO] %s\n' "$*"; }
ok()    { printf '[ OK ] %s\n' "$*"; }
warn()  { printf '[WARN] %s\n' "$*"; }
fail()  { printf '[FAIL] %s\n' "$*"; }

confirm() {
  $AUTO_YES && return 0
  printf '%s [j/N] ' "$1"
  read -r answer
  [[ "${answer,,}" =~ ^(j|ja|y|yes)$ ]]
}

run_sudo() {
  if [[ "$EUID" -eq 0 ]]; then "$@"; else sudo "$@"; fi
}

port_from_env() {
  local key="$1" fallback="$2" value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\"' | tr -d "'" | tr -d '\r' || true)"
  [[ "$value" =~ ^[0-9]+$ ]] && printf '%s' "$value" || printf '%s' "$fallback"
}

service_state="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
web_port="$(port_from_env WEB_PORT 3000)"
wigi_port="$(port_from_env WIGIDASH_API_PORT 47900)"

printf '\nBockis Bot - Diagnose und Reparatur\n'
printf 'Bot-Verzeichnis: %s\n\n' "$BOT_DIR"

[[ -f "$BOT_DIR/bot.js" ]] && ok "bot.js vorhanden" || fail "bot.js fehlt"
[[ -f "$BOT_DIR/package.json" ]] && ok "package.json vorhanden" || fail "package.json fehlt"
[[ -f "$ENV_FILE" ]] && ok ".env vorhanden" || fail ".env fehlt"

if command -v node >/dev/null 2>&1; then
  node_version="$(node -v 2>/dev/null || true)"
  ok "Node.js ${node_version} gefunden"
else
  fail "Node.js nicht gefunden"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v 2>/dev/null || true) gefunden"
else
  fail "npm nicht gefunden"
fi

if [[ -d "$BOT_DIR/node_modules" ]]; then
  ok "node_modules vorhanden"
else
  warn "node_modules fehlt"
fi

if [[ "$service_state" == "active" ]]; then
  ok "systemd-Service ist aktiv"
else
  warn "systemd-Service ist nicht stabil aktiv: ${service_state:-unbekannt}"
fi

for port in "$web_port" "$wigi_port"; do
  listeners="$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p"$" {print}' || true)"
  if [[ -n "$listeners" ]]; then
    printf '%s\n' "$listeners"
  else
    warn "Kein Listener auf Port $port"
  fi
done

mapfile -t NODE_PROCS < <(pgrep -af "node .*${BOT_DIR}/bot\.js" 2>/dev/null | awk '{print $1}' || true)
if (( ${#NODE_PROCS[@]} > 1 )); then
  warn "Mehrere Bot-Prozesse gefunden: ${NODE_PROCS[*]}"
else
  ok "Keine doppelte Bot-Instanz erkannt"
fi

if [[ -f "$ENV_FILE" ]]; then
  grep -q '^WIGIDASH_API_ENABLED=true' "$ENV_FILE" && ok "WigiDash-API aktiviert" || warn "WigiDash-API nicht aktiviert"
  grep -q '^WIGIDASH_API_HOST=0.0.0.0' "$ENV_FILE" && ok "WigiDash-API ist im LAN gebunden" || warn "WigiDash-API ist nicht auf 0.0.0.0 gebunden"
fi

if [[ "$MODE" != "repair" ]]; then
  printf '\nNur Diagnose ausgefuehrt. Fuer Reparatur: bash repair-bot.sh --repair\n'
  exit 0
fi

printf '\nReparaturmodus\n'

if [[ ! -f "$ENV_FILE" || ! -f "$BOT_DIR/package.json" ]]; then
  fail "Grundlegende Dateien fehlen; automatische Reparatur abgebrochen"
  exit 1
fi

if ! confirm "Erkannte Reparaturen ausfuehren?"; then
  info "Abgebrochen"
  exit 0
fi

# Nur passende Bot-Prozesse stoppen, niemals beliebige Node-Prozesse.
run_sudo systemctl stop "$SERVICE" >/dev/null 2>&1 || true
for pid in "${NODE_PROCS[@]}"; do
  [[ "$pid" =~ ^[0-9]+$ ]] || continue
  if [[ "$pid" != "$$" ]]; then
    run_sudo kill "$pid" >/dev/null 2>&1 || true
  fi
done

if command -v dpkg >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
  info "Pruefe apt/dpkg"
  run_sudo dpkg --configure -a || warn "dpkg meldet einen Fehler"
  run_sudo apt-get -f install -y || warn "apt-get -f install meldet einen Fehler"
fi

if ! command -v node >/dev/null 2>&1; then
  fail "Node.js fehlt; bitte Node.js ueber die Systeminstallation reparieren"
  exit 1
fi

if [[ ! -d "$BOT_DIR/node_modules" ]]; then
  info "Installiere fehlende npm-Abhaengigkeiten"
  npm install --omit=dev --prefix "$BOT_DIR" || { fail "npm install fehlgeschlagen"; exit 1; }
else
  ok "npm-Abhaengigkeiten vorhanden; keine destruktive Neuinstallation notwendig"
fi

if [[ -f "$ENV_FILE" ]] && grep -q '^WIGIDASH_API_ENABLED=true' "$ENV_FILE"; then
  if command -v ufw >/dev/null 2>&1 && run_sudo ufw status 2>/dev/null | grep -q '^Status: active'; then
    lan_cidr="$(ip -4 route show scope link 2>/dev/null | awk '$1 ~ /^[0-9]+\./ {print $1; exit}')"
    if [[ -n "$lan_cidr" ]]; then
      run_sudo ufw allow from "$lan_cidr" to any port "$wigi_port" proto tcp comment 'WigiDash Status API' >/dev/null 2>&1 || warn "UFW-Regel konnte nicht gesetzt werden"
      ok "WigiDash-Firewallregel geprueft"
    else
      warn "Lokales LAN-Subnetz konnte nicht erkannt werden"
    fi
  fi
fi

run_sudo systemctl daemon-reload
run_sudo systemctl start "$SERVICE"

if systemctl is-active --quiet "$SERVICE"; then
  ok "systemd-Service aktiv"
else
  fail "systemd-Service ist nicht aktiv"
  run_sudo journalctl -u "$SERVICE" -n 30 --no-pager || true
  exit 1
fi

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 5 "http://127.0.0.1:${wigi_port}/status" >/dev/null; then
    ok "WigiDash-Status-Endpunkt antwortet"
  else
    warn "WigiDash-Status-Endpunkt antwortet nicht"
  fi
fi

printf '\nReparatur abgeschlossen.\n'
