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
SKIP_NPM=false
SKIP_GIT=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bot-dir)     BOT_DIR="$2"; shift 2 ;;
    --mode)        MODE="$2"; shift 2 ;;
    --yes|-y)      SKIP_CONFIRM=true; shift ;;
    --skip-npm)    SKIP_NPM=true; shift ;;
    --skip-git)    SKIP_GIT=true; shift ;;
    --help|-h)
      echo "Verwendung: bash update.sh [OPTIONEN]"
      echo ""
      echo "Optionen:"
      echo "  --bot-dir <pfad>             Bot-Verzeichnis (Standard: \$HOME/bockis-bot)"
      echo "  --mode <auto|native|docker>  Update-Modus (Standard: auto)"
      echo "  --yes, -y                    Alle Bestätigungen überspringen"
      echo "  --skip-npm                   npm-Abhängigkeiten NICHT aktualisieren"
      echo "  --skip-git                   Git pull NICHT ausführen"
      echo "  --help, -h                   Diese Hilfe anzeigen"
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

migrate_legacy_auto_replies() {
  local legacy_file="$BOT_DIR/auto-replies.json"
  local data_file="$BOT_DIR/data/auto-replies.json"
  if [[ -f "$legacy_file" ]]; then
    mkdir -p "$BOT_DIR/data"
    if [[ ! -e "$data_file" ]]; then
      cp -p "$legacy_file" "$data_file"
      print_status "Legacy-auto-replies.json nach data/ kopiert"
    elif ! cmp -s "$legacy_file" "$data_file"; then
      print_warn "Root- und data/auto-replies.json unterscheiden sich; beide bleiben erhalten, data/ wird verwendet"
    fi
  fi
}

initialize_auto_replies() {
  local data_file="$BOT_DIR/data/auto-replies.json"
  local example_file="$BOT_DIR/config/auto-replies.example.json"
  if [[ ! -e "$data_file" && -f "$example_file" ]]; then
    mkdir -p "$BOT_DIR/data"
    cp -p "$example_file" "$data_file"
    print_status "Auto-Reply-Beispiel nach data/ kopiert"
  fi
}

# ── .env Backup ──────────────────────────────────────────────────────────────
print_header "Backup"
BACKUP_FILE="$BOT_DIR/.env.backup.$(date +%Y%m%d_%H%M%S)"
cp "$BOT_DIR/.env" "$BACKUP_FILE"
print_success ".env gesichert als $(basename "$BACKUP_FILE")"

# ── UPDATE: Native (systemd) ─────────────────────────────────────────────────
update_native() {
  print_header "Bot-Update (native)"

  # System-Abhängigkeit für SVG-Rendering sicherstellen
  if ! command -v rsvg-convert >/dev/null 2>&1; then
    print_status "Installiere fehlende System-Abhaengigkeit: librsvg2-bin"
    sudo apt-get update -qq
    sudo apt-get install -y -qq librsvg2-bin
    print_success "librsvg2-bin installiert"
  fi

  # 1. git pull
  command -v git >/dev/null 2>&1 || die "git ist nicht installiert: sudo apt-get install -y git"
  cd "$BOT_DIR"

  if [[ "$SKIP_GIT" == "true" ]]; then
    print_warn "Git-Update übersprungen (--skip-git)"
  else
    if git -C "$BOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
      print_status "Lade neueste Version von GitHub..."
      STASH_DONE=false

      # Offene Merge/Rebase/Cherry-Pick-Vorgänge abbrechen, damit pull/stash nicht an Exit 128 scheitert.
      if [[ -f "$BOT_DIR/.git/MERGE_HEAD" ]]; then
        print_warn "Unfertiger Merge erkannt — versuche git merge --abort"
        git -C "$BOT_DIR" merge --abort >/dev/null 2>&1 || print_warn "git merge --abort fehlgeschlagen"
      fi
      if [[ -d "$BOT_DIR/.git/rebase-apply" || -d "$BOT_DIR/.git/rebase-merge" ]]; then
        print_warn "Unfertiger Rebase erkannt — versuche git rebase --abort"
        git -C "$BOT_DIR" rebase --abort >/dev/null 2>&1 || print_warn "git rebase --abort fehlgeschlagen"
      fi
      if [[ -f "$BOT_DIR/.git/CHERRY_PICK_HEAD" ]]; then
        print_warn "Unfertiger Cherry-Pick erkannt — versuche git cherry-pick --abort"
        git -C "$BOT_DIR" cherry-pick --abort >/dev/null 2>&1 || print_warn "git cherry-pick --abort fehlgeschlagen"
      fi
      if [[ -f "$BOT_DIR/.git/REVERT_HEAD" ]]; then
        print_warn "Unfertiger Revert erkannt — versuche git revert --abort"
        git -C "$BOT_DIR" revert --abort >/dev/null 2>&1 || print_warn "git revert --abort fehlgeschlagen"
      fi

      UNMERGED_FILES="$(git -C "$BOT_DIR" diff --name-only --diff-filter=U 2>/dev/null || true)"
      if [[ -n "$UNMERGED_FILES" ]]; then
        print_error "Unaufgelöste Merge-Konflikte gefunden. Bitte zuerst auflösen oder Merge abbrechen."
        while IFS= read -r f; do
          [[ -n "$f" ]] && print_error "Konflikt: $f"
        done <<< "$UNMERGED_FILES"
        die "Git-Update abgebrochen wegen unaufgelöster Konflikte"
      fi

      print_status "Prüfe Commit-Verlauf mit origin/main..."
      git -C "$BOT_DIR" fetch --quiet origin main || die "git fetch fehlgeschlagen; lokale Dateien wurden nicht gestasht"
      LOCAL_COMMIT="$(git -C "$BOT_DIR" rev-parse HEAD)"
      REMOTE_COMMIT="$(git -C "$BOT_DIR" rev-parse FETCH_HEAD)"
      PULL_NEEDED=true
      if git -C "$BOT_DIR" merge-base --is-ancestor "$LOCAL_COMMIT" "$REMOTE_COMMIT"; then
        :
      elif git -C "$BOT_DIR" merge-base --is-ancestor "$REMOTE_COMMIT" "$LOCAL_COMMIT"; then
        PULL_NEEDED=false
        print_warn "Lokaler Branch ist origin/main voraus; es gibt keine Fast-Forward-Änderungen zu übernehmen"
      else
        print_error "Lokaler Branch und origin/main sind auseinander gelaufen:"
        git -C "$BOT_DIR" log --oneline --left-right --graph --decorate "$LOCAL_COMMIT...$REMOTE_COMMIT" 2>/dev/null | while IFS= read -r line; do
          print_status "$line"
        done
        die "Fast-Forward nicht möglich. Keine Laufzeitdateien wurden gestasht oder überschrieben; lokale Commits müssen geprüft werden."
      fi

      # Alte Root-Regeln vor dem Entfernen der Legacy-Datei erhalten.
      migrate_legacy_auto_replies

      # Lokale Laufzeit-Dateien sichern (z. B. .env + Auto-Reply-Regeln)
      LOCAL_OVERRIDE_FILES=()
      for rel in .env auto-replies.json data/auto-replies.json; do
        if [[ -e "$BOT_DIR/$rel" ]]; then
          LOCAL_OVERRIDE_FILES+=("$rel")
        fi
      done

      if [[ ${#LOCAL_OVERRIDE_FILES[@]} -gt 0 ]]; then
        HAS_LOCAL_OVERRIDES="$(git -C "$BOT_DIR" status --porcelain -- "${LOCAL_OVERRIDE_FILES[@]}" 2>/dev/null || true)"
        if [[ -n "$HAS_LOCAL_OVERRIDES" ]]; then
          git -C "$BOT_DIR" stash push -u -m "update-backup" -- "${LOCAL_OVERRIDE_FILES[@]}" 2>/dev/null && STASH_DONE=true || true
        fi
      fi

      if [[ "$PULL_NEEDED" == "true" ]]; then
        if git -C "$BOT_DIR" merge --ff-only "$REMOTE_COMMIT" 2>&1 | while IFS= read -r line; do
          print_status "$line"
        done; then
          print_success "Code aktualisiert"
        else
          MERGE_STATUS=$?
          if [[ "$STASH_DONE" == "true" ]]; then
            if git -C "$BOT_DIR" stash pop; then
              print_success "Lokale Laufzeitdateien nach fehlgeschlagenem Update wiederhergestellt"
              STASH_DONE=false
            else
              print_warn "Update-Stash konnte nicht automatisch wiederhergestellt werden. Backup: $BACKUP_FILE"
            fi
          fi
          die "Fast-Forward fehlgeschlagen (Exit-Code $MERGE_STATUS)"
        fi
      else
        print_success "Code ist bereits auf dem neuesten Stand"
      fi

      if [[ "$STASH_DONE" == "true" ]]; then
        git -C "$BOT_DIR" stash pop 2>/dev/null || print_warn "Update-Stash (.env/Auto-Replies) konnte nicht automatisch wiederhergestellt werden. Backup: $BACKUP_FILE"
      fi
    else
      print_warn "Kein Git-Repository — Code-Update wird übersprungen (nur npm-Pakete werden aktualisiert)"
    fi
  fi

  initialize_auto_replies

  # 2. npm-Pakete aktualisieren
  if [[ "$SKIP_NPM" == "true" ]]; then
    print_warn "npm-Abhängigkeiten übersprungen (--skip-npm)"
  else
    print_status "Aktualisiere npm-Abhaengigkeiten..."
  echo ""

  _npm_spinner() {
    local CMD="$1"
    local FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
    local elapsed=0 frame=0 phase="download" pid_file
    pid_file=$(mktemp)

    # npm im Hintergrund starten, stdout+stderr in Tempfile
    local OUT; OUT=$(mktemp)
    eval "$CMD" > "$OUT" 2>&1 &
    local npm_pid=$!

    while kill -0 "$npm_pid" 2>/dev/null; do
      local spin="${FRAMES[frame % 10]}"
      ((frame++))
      local label="Pakete werden geladen…"
      # Letzten relevanten Output auslesen
      local last
      last=$(tail -1 "$OUT" 2>/dev/null | tr -d '\r')
      if echo "$last" | grep -qiE 'gyp|CXX|compil|SOLINK'; then
        phase="compile"
      elif echo "$last" | grep -qiE 'added [0-9]+|packages in'; then
        phase="finalize"
      fi
      case "$phase" in
        compile)  label="Kompiliere sqlite3 (C++) — normal, dauert 5-15 Min auf ARM…" ;;
        finalize) label="Finalisiere Pakete…" ;;
      esac
      local min=$(( elapsed / 60 )) sec=$(( elapsed % 60 ))
      local t="${min}m$(printf '%02d' $sec)s"
      printf "\x1b[2K\r  %s [%s]  %s" "$spin" "$t" "$label"
      # Alle 60s Lebenszeichen
      if (( elapsed > 0 && elapsed % 60 == 0 )); then
        printf "\n"
        print_status "${elapsed}s vergangen — sqlite3-Kompilierung laeuft noch (normal auf Raspberry Pi)"
      fi
      sleep 1
      (( elapsed++ ))
    done

    wait "$npm_pid"
    local rc=$?
    printf "\x1b[2K\r"
    rm -f "$OUT" "$pid_file"
    return $rc
  }

  if [[ -f "$BOT_DIR/package-lock.json" ]]; then
    if _npm_spinner "npm ci --omit=dev --prefix '$BOT_DIR'"; then
      print_success "npm-Pakete aktualisiert"
    else
      print_warn "npm ci fehlgeschlagen, versuche npm install..."
      if _npm_spinner "npm install --omit=dev --prefix '$BOT_DIR'"; then
        print_success "npm-Pakete aktualisiert (fallback)"
      else
        print_error "npm install fehlgeschlagen" || true
      fi
    fi
  else
    if _npm_spinner "npm install --omit=dev --prefix '$BOT_DIR'"; then
      print_success "npm-Pakete aktualisiert"
    else
      print_error "npm install fehlgeschlagen" || true
    fi
  fi
  fi  # end SKIP_NPM

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

  if [[ "$SKIP_GIT" == "true" || "$SKIP_NPM" == "true" ]]; then
    die "Separate git/npm-Aktionen werden im Docker-Modus nicht unterstützt. Bitte vollständiges Docker-Update nutzen."
  fi

  [[ -f "$BOT_DIR/docker-compose.yml" ]] || die "docker-compose.yml nicht gefunden in $BOT_DIR"
  command -v docker >/dev/null 2>&1 || die "Docker ist nicht installiert."
  docker compose version >/dev/null 2>&1 || die "docker compose (Plugin) nicht verfügbar. Bitte Docker Desktop oder das Compose-Plugin installieren."

  cd "$BOT_DIR"

  # 1. Code per git aktualisieren (falls verfügbar)
  if git -C "$BOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    print_status "Lade neueste Version von GitHub..."
    migrate_legacy_auto_replies
    LEGACY_STASH_DONE=false
    if [[ -n "$(git -C "$BOT_DIR" status --porcelain -- auto-replies.json 2>/dev/null || true)" ]]; then
      git -C "$BOT_DIR" stash push -u -m "docker-update-legacy-auto-replies" -- auto-replies.json \
        || die "Legacy-Auto-Reply-Datei konnte nicht gesichert werden"
      LEGACY_STASH_DONE=true
    fi

    if git -C "$BOT_DIR" pull --ff-only origin main 2>&1 | while IFS= read -r line; do
      print_status "$line"
    done; then
      print_success "Code aktualisiert"
    else
      PULL_STATUS=$?
      if [[ "$LEGACY_STASH_DONE" == "true" ]]; then
        git -C "$BOT_DIR" stash pop || print_warn "Legacy-Auto-Reply-Stash blieb zur Wiederherstellung erhalten"
      fi
      die "Git-Update fehlgeschlagen (Exit-Code $PULL_STATUS)"
    fi
    if [[ "$LEGACY_STASH_DONE" == "true" ]]; then
      git -C "$BOT_DIR" stash pop || print_warn "Legacy-Auto-Reply-Stash blieb zur Wiederherstellung erhalten"
    fi
  else
    print_warn "Kein Git-Repository — Code-Update wird übersprungen"
  fi

  initialize_auto_replies

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
