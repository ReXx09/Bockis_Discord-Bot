#!/bin/bash

# Installations-Skript für Bockis Discord Uptime Bot
# Getestet auf Raspberry Pi OS / Ubuntu / Debian
# Ausführung: bash start-bot.sh

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_status()  { echo -e "${YELLOW}[+]${NC} $1"; }
print_success() { echo -e "${GREEN}[✓]${NC} $1"; }
handle_error()  { echo -e "${RED}[!] Fehler in Schritt $1${NC}"; exit 1; }

# 1. Systemaktualisierung
print_status "Aktualisiere Systempakete..."
sudo apt update && sudo apt full-upgrade -y || handle_error 1
print_success "Systempakete aktualisiert"

# 2. Node.js 18 installieren
print_status "Installiere Node.js 18..."
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs || handle_error 2
print_success "Node.js $(node -v) installiert"

# 3. Bot-Verzeichnis anlegen
BOT_DIR="$HOME/bockis-bot"
print_status "Richte Bot-Verzeichnis unter $BOT_DIR ein..."
mkdir -p "$BOT_DIR/data" || handle_error 3
print_success "Verzeichnis erstellt"

# 4. Dateien kopieren
print_status "Erwartete Dateistruktur:"
echo -e "${YELLOW}
$BOT_DIR/
├── bot.js
├── package.json
├── .env
├── config/
│   └── config.js
├── models/
│   └── MonitorStatus.js
└── views/
    └── dashboard.ejs
${NC}"
echo "Bitte die Dateien manuell in $BOT_DIR kopieren und Enter drücken..."
read -p "Bereit zum Fortfahren? (Enter)"

# 5. Abhängigkeiten installieren
print_status "Installiere Node-Abhängigkeiten..."
cd "$BOT_DIR" || handle_error 5
npm install || handle_error 5
print_success "Abhängigkeiten installiert"

# 6. .env prüfen
if [ ! -f "$BOT_DIR/.env" ]; then
  echo -e "${RED}[!] .env Datei fehlt! Bitte .env.example kopieren und ausfüllen:${NC}"
  echo "    cp .env.example .env && nano .env"
  handle_error 6
fi
print_success ".env Datei gefunden"

# 7. Systemd-Service einrichten
print_status "Richte systemd-Service ein..."
sudo tee /etc/systemd/system/bockis-bot.service > /dev/null <<EOF
[Unit]
Description=Bockis Discord Uptime Bot
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$BOT_DIR
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=bockis-bot

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable bockis-bot
sudo systemctl start bockis-bot || handle_error 7
print_success "Systemd-Service gestartet und aktiviert"

# 8. Abschluss
BOT_IP=$(hostname -I | awk '{print $1}')
WEB_PORT=$(grep -oP '(?<=WEB_PORT=)\d+' "$BOT_DIR/.env" 2>/dev/null || echo 3000)

echo ""
echo -e "${GREEN}========================================"
echo -e "  Bockis Bot erfolgreich installiert!  "
echo -e "========================================${NC}"
echo ""
echo "Nützliche Befehle:"
echo "  Status:   sudo systemctl status bockis-bot"
echo "  Logs:     sudo journalctl -u bockis-bot -f"
echo "  Neustart: sudo systemctl restart bockis-bot"
echo "  Stoppen:  sudo systemctl stop bockis-bot"
echo ""
echo "Web-Dashboard: http://${BOT_IP}:${WEB_PORT}/dashboard"
echo "Health-Check:  http://${BOT_IP}:${WEB_PORT}/health"
echo "Prometheus:    http://${BOT_IP}:${WEB_PORT}/metrics"
