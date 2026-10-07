# WigiDash Discord-Integration

Diese Integration ermöglicht es, den Discord-Status eines Benutzers über ein lokales HTTP-API in Hardware-Monitor-Widgets (wie WigiDash mit HWiNFO) anzuzeigen.

## Überblick

Der Bot stellt einen HTTP-Endpunkt bereit, der aktuelle Discord-Status-Daten liefert:
- **Username**: Anzeigename des Benutzers
- **Status**: Online/Idle/DND/Offline
- **Activity**: Aktuelle Aktivität/Spielname
- **VoiceChannel**: Name des aktuellen Sprachkanals
- **Guild**: Name des Discord-Servers

## Aktivierung & Konfiguration

### 1. Konfigurationsvariablen in `.env` hinzufügen

```env
# ── WigiDash Hardware-Monitor Integration ──────────────────────────────────────
# WigiDash Status-API aktivieren
WIGIDASH_API_ENABLED=true

# Nur localhost (127.0.0.1) oder im Netzwerk erreichbar (0.0.0.0)
WIGIDASH_API_HOST=127.0.0.1

# Port für den Status-Endpunkt (Standard: 47900)
WIGIDASH_API_PORT=47900

# URL-Pfad (Standard: /status)
WIGIDASH_API_PATH=/status

# Discord-Benutzer-ID des zu verfolgenden Nutzers (leer = nicht konfiguriert)
WIGIDASH_TARGET_USER_ID=

# Optionale Guild-ID zum Filtern (leer = beliebiger Server)
WIGIDASH_TARGET_GUILD_ID=

# API-Schlüssel für Netzwerk-Zugriff (nur falls WIGIDASH_API_HOST=0.0.0.0)
WIGIDASH_API_KEY=
```

### 2. Benutzer-ID ermitteln

Wenn `WIGIDASH_TARGET_USER_ID` leer ist, versucht die Integration automatisch, einen geeigneten Benutzer zu finden.

Um die ID eines bestimmten Benutzers zu ermitteln:
- In Discord: `@username` schreiben → Rechtsklick → "User ID kopieren"
- Oder: `WIGIDASH_TARGET_USER_ID=123456789012345678`

### 3. Bot neustarten

```bash
npm start
```

Beim Start sollte dies in den Logs erscheinen:
```
[INFO] WigiDash Status-API verfügbar unter http://127.0.0.1:47900/status
[INFO] WigiDash Status-Cache initialisiert
```

## API-Endpunkte

### Hauptanwendungs-Endpunkt
```
GET http://localhost:3000/status
```
JSON-Response (optional, nur wenn auf Hauptserver aktiviert):
```json
{
  "Username": "ReXx09",
  "Status": "online",
  "Activity": "Minecraft",
  "VoiceChannel": "Gaming",
  "Guild": "Meine Community"
}
```

### Separater WigiDash-Server (empfohlen)
```
GET http://127.0.0.1:47900/status
```

Wenn `WIGIDASH_API_HOST=0.0.0.0`:
```
GET http://<IP>:47900/status?apiKey=dein_api_schluessel
```
oder mit Header:
```
GET http://<IP>:47900/status
X-API-Key: dein_api_schluessel
```

## Netzwerk-Konfiguration

### Lokal (Standard: nur localhost)
```env
WIGIDASH_API_HOST=127.0.0.1
WIGIDASH_API_PORT=47900
WIGIDASH_API_KEY=     # Nicht nötig
```
- Nur auf dem Bot-Computer erreichbar
- Keine Authentifizierung nötig

### Im Netzwerk (mit API-Key Sicherheit)
```env
WIGIDASH_API_HOST=0.0.0.0
WIGIDASH_API_PORT=47900
WIGIDASH_API_KEY=geheim123
```
- Von anderen Computern im Netzwerk erreichbar
- Requires: `X-API-Key: geheim123` Header oder `?apiKey=geheim123` Query-Parameter

## Intents und Discord-Privilegien

Diese Integration benötigt folgende Discord Intents:
- ✅ `Guilds` – Server-Informationen
- ✅ `GuildMessages` – Nachrichten lesen
- ✅ `MessageContent` – Nachrichteninhalt
- ✅ `GuildPresences` – **User-Status (online/idle/dnd/offline)**
- ✅ `GuildMembers` – **Member-Informationen**
- ✅ `GuildVoiceStates` – **Voice-Kanal-Info**

### Privileged Intents aktivieren

Diese müssen im [Discord Developer Portal](https://discord.com/developers/applications) aktiviert werden:

1. Gehe zu deiner Bot-Anwendung
2. Scrolle zu "Intent" Bereich
3. Aktiviere:
   - ✅ **Presence Intent**
   - ✅ **Server Members Intent**
   - ✅ **Message Content Intent**

## Fehlerbehandlung

### Fehler: "Port bereits in Verwendung"
```
WigiDash Port 47900 ist bereits in Verwendung.
```
**Lösung:**
- Port freigeben: `netstat -ano | findstr :47900` (Windows) oder `lsof -i :47900` (Linux)
- Oder anderen Port in `.env` setzen: `WIGIDASH_API_PORT=47901`

### Keine Discord-Daten verfügbar
Die Integration gibt folgende "Offline-Fallback" Response:
```json
{
  "Username": "",
  "Status": "offline",
  "Activity": "",
  "VoiceChannel": "",
  "Guild": ""
}
```
Dies ist kein Fehler, sondern normales Verhalten wenn der Bot noch keine Daten hat.

### API-Key wird nicht akzeptiert
Stelle sicher, dass:
1. `WIGIDASH_API_HOST=0.0.0.0` ist (nicht `127.0.0.1`)
2. Der API-Key in `WIGIDASH_API_KEY` gespeichert ist
3. Du den Key im Request mitsendet (Header oder Query-Parameter)

## Testing

### Mit PowerShell
```powershell
# Lokal testen
Invoke-RestMethod http://127.0.0.1:47900/status | ConvertTo-Json

# Mit API-Key (Netzwerk)
Invoke-RestMethod "http://<IP>:47900/status" `
  -Headers @{"X-API-Key" = "geheim123"} | ConvertTo-Json
```

### Mit curl
```bash
# Lokal
curl http://127.0.0.1:47900/status

# Mit API-Key
curl -H "X-API-Key: geheim123" http://<IP>:47900/status
```

### Mit JavaScript/Node.js
```javascript
const fetch = require('node-fetch');

async function getDiscordStatus() {
  const response = await fetch('http://127.0.0.1:47900/status');
  const data = await response.json();
  console.log(data);
}

getDiscordStatus();
```

## WigiDash HWiNFO Widget Konfiguration

Das Standard-WigiDash-Widget nutzt diese Einstellungen:
- **Default URL**: `http://127.0.0.1:47900/status`
- **Default Button**: `discord://-/`

Diese können in WigiDash-Widget-Seiten-Einstellungen angepasst werden.

## Performance & Caching

- **Cache-Update**: Ereignisbasiert bei Discord-Events (presenceUpdate, voiceStateUpdate, guildMemberUpdate)
- **Fallback-Cache**: Aktualisiert die Daten, damit keine REST-Calls nötig sind
- **Response-Time**: Typischerweise < 10ms
- **Thread-Safety**: Interner Status ist thread-sicher

Der HTTP-Endpunkt blockiert niemals und wartet nicht auf Discord-Events – er liefert immer den zuletzt bekannten Status.

## Sicherheit

⚠️ **Lokales Setup (127.0.0.1)**:
- Nur der Bot-Computer kann zugreifen
- Keine Authentifizierung nötig
- Discord-Tokens werden **NICHT** gesendet

⚠️ **Netzwerk-Setup (0.0.0.0)**:
- Setze ein starkes `WIGIDASH_API_KEY`
- Sende den Key **NICHT** im Klartextformular, verwende Headers
- Der Status selbst ist öffentlich (nur nicht-sensible Daten)
- Tokens werden **NIEMALS** gesendet

## Datenfluss

```
┌─────────────┐
│ Discord API │
└──────┬──────┘
       │
    [Events: presenceUpdate, voiceStateUpdate, guildMemberUpdate]
       │
       ▼
┌─────────────────────────────────┐
│ Bot: updateWigiDashCache()      │
│ - Liest Member-Präsenzen        │
│ - Liest Voice-Kanal-Info        │
│ - Cache aktualisiert            │
└─────────────┬───────────────────┘
       │
       ▼
┌─────────────────────────────────┐
│ HTTP-Endpunkt /status           │
│ - Gibt Cache zurück (< 10ms)    │
│ - Keine REST-Calls nötig        │
└─────────────┬───────────────────┘
       │
       ▼
┌──────────────────────┐
│ WigiDash / HWiNFO    │
│ Zeigt Status an      │
└──────────────────────┘
```

## Changelog

### v1.0.0 (Initial Release)
- ✅ Status-Cache mit Discord-Events
- ✅ HTTP-Endpunkt auf Hauptserver
- ✅ Separater WigiDash-Server (Port 47900)
- ✅ API-Key Authentifizierung
- ✅ Offline-Fallback
- ✅ Thread-safe Cache
- ✅ Vollständige Logging

## Troubleshooting

| Problem | Lösung |
|---------|--------|
| Cache wird nicht aktualisiert | Prüfe Discord Intents im Portal → Presence, Members aktivieren |
| WigiDash zeigt keine Daten | Prüfe `WIGIDASH_TARGET_USER_ID` oder lass leer für Auto-Detect |
| Port-Konflikt | Änder `WIGIDASH_API_PORT` auf einen freien Port |
| API-Key funktioniert nicht | Verwende Header `X-API-Key:` nicht Query-Parameter `?apiKey=` |
| Nur "offline" Status | Bot hat keine Guild-Presences → Intents überprüfen |

## Support

Bei Fragen oder Problemen:
1. Prüfe die Logs: `logs/bot-YYYY-MM-DD.log`
2. Teste den Endpunkt: `curl http://127.0.0.1:47900/status`
3. Verifiziere die Discord Intents im Developer Portal
4. Stelle sicher, dass `WIGIDASH_ENABLED=true`
