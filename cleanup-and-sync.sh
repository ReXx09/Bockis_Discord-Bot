#!/bin/bash

#################################################################
# Bockis Discord Bot - Cleanup & Auto-Sync Script
# Behebt Docker-Konflikte und aktualisiert den Bot automatisch
#################################################################

set -e  # Stoppe bei Fehlern

# Farben für Output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}  Bockis Discord Bot - Cleanup & Auto-Sync${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

# ─────────────────────────────────────────────────────────────
# 📊 SCHRITT 1: Vorbedingungen prüfen
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[1/5] Vorbedingungen prüfen...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${YELLOW}  ⚠️  Docker nicht installiert - überspringe Docker-Cleanup${NC}"
    SKIP_DOCKER=1
else
    SKIP_DOCKER=0
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}  ❌ Git nicht installiert - FEHLER${NC}"
    exit 1
fi

if ! command -v pm2 &> /dev/null; then
    echo -e "${RED}  ❌ PM2 nicht installiert - FEHLER${NC}"
    exit 1
fi

echo -e "${GREEN}  ✅ Alle Vorbedingungen erfüllt${NC}\n"

# ─────────────────────────────────────────────────────────────
# 🐳 SCHRITT 2: Docker aufräumen (wenn vorhanden)
# ─────────────────────────────────────────────────────────────
if [ "$SKIP_DOCKER" -eq 0 ]; then
    echo -e "${YELLOW}[2/5] Docker-Cleanup...${NC}"
    
    # Stoppe alle laufenden Container
    if [ $(docker ps -q | wc -l) -gt 0 ]; then
        echo -e "  Stoppe laufende Container..."
        docker stop $(docker ps -q) 2>/dev/null || true
    fi
    
    # Entferne alte Images
    echo -e "  Entferne alte Docker-Images..."
    docker system prune -a --volumes -f > /dev/null 2>&1 || true
    
    # Spezifische Bot-Images löschen
    docker image rm discord-bot-discord-bot discord-bot 2>/dev/null || true
    
    echo -e "${GREEN}  ✅ Docker-Cleanup abgeschlossen${NC}\n"
else
    echo -e "${YELLOW}[2/5] Docker-Cleanup übersprungen${NC}\n"
fi

# ─────────────────────────────────────────────────────────────
# 🔄 SCHRITT 3: Git synchronisieren
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[3/5] Git synchronisieren...${NC}"

BOT_DIR="/opt/Bockis_Discord-Bot"

if [ ! -d "$BOT_DIR" ]; then
    echo -e "${RED}  ❌ Bot-Verzeichnis nicht gefunden: $BOT_DIR${NC}"
    exit 1
fi

cd "$BOT_DIR"

# Git-Konfiguration setzen
echo -e "  Setze Git-Pull-Strategie..."
git config pull.rebase false

# Merge-Konflikte abbrechen (falls vorhanden)
if git merge --abort 2>/dev/null; then
    echo -e "  ⚠️  Git-Merge abgebrochen"
fi

# Aktuelle Änderungen verwerfen und neu pullen
echo -e "  Hole neueste Version von GitHub..."
git fetch origin
git reset --hard origin/main
git pull

# Aktuelle Version anzeigen
CURRENT_VERSION=$(git log --oneline -1)
echo -e "${GREEN}  ✅ Aktuelle Version: $CURRENT_VERSION${NC}\n"

# ─────────────────────────────────────────────────────────────
# 📦 SCHRITT 4: Abhängigkeiten aktualisieren
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[4/5] NPM-Abhängigkeiten überprüfen...${NC}"

if [ -f "package.json" ]; then
    npm install --omit=dev > /dev/null 2>&1 || {
        echo -e "${YELLOW}  ⚠️  npm install mit Warnungen abgeschlossen${NC}"
    }
    echo -e "${GREEN}  ✅ NPM-Abhängigkeiten aktualisiert${NC}\n"
else
    echo -e "${YELLOW}  ⚠️  package.json nicht gefunden - überspringe npm${NC}\n"
fi

# ─────────────────────────────────────────────────────────────
# 🚀 SCHRITT 5: Bot neustarten
# ─────────────────────────────────────────────────────────────
echo -e "${YELLOW}[5/5] Bot neustarten...${NC}"

# PM2 Status prüfen
if pm2 id Bockis_Discord-Bot > /dev/null 2>&1; then
    echo -e "  Starte Bot neu..."
    pm2 restart Bockis_Discord-Bot --silent
    sleep 2
else
    echo -e "  Starte Bot neu (erste Ausführung)..."
    pm2 start bot.js --name Bockis_Discord-Bot --silent
fi

# Status anzeigen
echo -e "  ${BLUE}PM2 Status:${NC}"
pm2 status | tail -n +3

# PM2 Config speichern
pm2 save --silent

echo -e "${GREEN}  ✅ Bot erfolgreich neu gestartet${NC}\n"

# ─────────────────────────────────────────────────────────────
# 📋 ZUSAMMENFASSUNG
# ─────────────────────────────────────────────────────────────
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Cleanup & Sync erfolgreich abgeschlossen!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

echo -e "📊 ${BLUE}System-Status:${NC}"
echo -e "  Bot-Version: $(git log --oneline -1 | cut -d' ' -f2-)"
echo -e "  Bot-Status: $(pm2 status | grep 'Bockis_Discord-Bot' | awk '{print $NF}')"
echo -e "  Uptime: $(pm2 info Bockis_Discord-Bot | grep -i uptime | awk '{print $NF}')"
echo -e "  RAM-Nutzung: $(pm2 info Bockis_Discord-Bot | grep -i memory | awk '{print $NF}')"
echo ""
echo -e "🔄 ${BLUE}Nächste automatische Sync: in 10 Minuten${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}\n"

exit 0
