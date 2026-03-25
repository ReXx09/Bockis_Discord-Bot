## 🚀 Was ist neu in v1.1.0

### 🖥️ Web-Dashboard (komplett neu)
Das bisherige Minimal-Dashboard wurde vollständig neu gestaltet – Dark Theme, kein externes CSS/JS, keine CDN-Abhängigkeit.

- **Bot-Status-Karte** – Discord-Tag, Online/Offline-Badge, WebSocket-Ping (farbkodiert grün/gelb/rot), Prozess-Laufzeit
- **System-Karte** – Node.js-Version, RAM- und Heap-Auslastung
- **Service-Monitor-Grid** – eine Karte pro Uptime-Kuma-Monitor mit Uptime-Balken, Ping, letztem Check-Zeitstempel und Farbindikator
- **Log-Viewer** – letzte 100 Zeilen der aktuellen Bot-Logdatei, farbkodiert (ERROR/WARN/INFO), scrollbar
- **Auto-Refresh** alle 30 Sekunden mit Countdown-Anzeige
- **Discord-Refresh-Button** – triggert sofortigen Status-Update in Discord

Erreichbar unter: `http://<raspi-ip>:3000/dashboard`

---

### 🔄 Update-Prüfung & Live-Update (neu)

**raspi-menu.sh**
- Beim Öffnen des Hauptmenüs wird automatisch im Hintergrund `git fetch` ausgeführt (max. 6s Timeout)
- Statuszeile zeigt **⚠ Bot-Update verfügbar!** oder **✓ Bot ist aktuell**
- Neuer Menüpunkt **6 – Update-Prüfung**: zeigt neue Commits (Hash, Message, Zeitstempel) und bietet direkten Update-Start an

**Web-Dashboard**
- Gelbes Update-Banner erscheint automatisch beim Laden, wenn neue Commits auf GitHub verfügbar sind
- Commit-Liste mit Hash, Nachricht und relativem Zeitstempel
- **"Update jetzt starten"**-Button: streamt den kompletten `update.sh`-Output live als Terminal im Browser (Server-Sent Events), ANSI-Codes werden bereinigt

**Neue API-Routen in `bot.js`** (alle mit `dashboardAuth` geschützt)

| Route | Methode | Funktion |
|---|---|---|
| `/api/bot-info` | GET | Discord-Tag, WS-Ping, Laufzeit, RAM, Node-Version |
| `/api/status` | GET | Live-Monitor-Daten von Uptime Kuma |
| `/api/logs` | GET | Letzte 100 Zeilen der aktuellen Logdatei |
| `/api/refresh` | POST | Sofortiger Discord Status-Update |
| `/api/update-check` | GET | git fetch + Commit-Vergleich mit origin/main |
| `/api/update-run` | POST | Startet update.sh, streamt Output per SSE |

---

### 🗑️ Zweistufiger Bot-Uninstall (neu)

**Stufe 1 – Soft-Uninstall** *(Konfiguration behalten)*
- systemd-Service stoppen & entfernen
- UFW-Firewall-Regel entfernen
- Docker-Container & Image entfernen
- ✅ Bot-Ordner **bleibt erhalten** (inkl. `.env`, Datenbank, Logs)
- Ideal für temporäre Deinstallation oder Neuaufsetzen mit vorhandener Konfiguration

**Stufe 2 – Full-Uninstall** *(alles löschen)*
- Alles wie Stufe 1, plus vollständiges Löschen des Bot-Ordners
- Doppelte Bestätigung: Ja/Nein-Dialog + manuelle Eingabe von `LÖSCHEN`

---

### 🔧 Weitere Änderungen
- `express.json()` Middleware ergänzt (JSON Body-Parsing für POST-Routen)
- `path` Modul-Import in `bot.js` ergänzt
- Dashboard-Route vereinfacht: Daten kommen per API, kein serverseitiges EJS-Rendering mehr nötig
