# Discord Kanal-Integration Check

Stand: 28.03.2026

## Kurzantwort

Ja, dein gewünschtes Setup ist möglich:
- Eine Kategorie für Uptime-Dienste
- Ein eigener Kanal pro Dienst
- Sichtbarer Live-Status pro Dienst direkt in der Kanalleiste (über Emoji im Kanalnamen)

Nein, du musst die einzelnen Service-Kanäle nicht manuell vorbereiten.
Der Bot kann die Service-Kategorie und die einzelnen Dienst-Kanäle selbst erstellen und später automatisch umbenennen.

Was du manuell setzen musst:
- Einen bestehenden Status-Channel für `STATUS_CHANNEL_ID`
- Korrekte Rechte für den Bot auf dem Server
- Die Konfiguration in `.env` (insbesondere `GUILD_ID` und `MONITORED_SERVICES`)

Pflichtbedingungen für die automatische Dienst-Kanal-Funktion:
- `GUILD_ID` muss gesetzt und korrekt sein
- `MONITORED_SERVICES` muss aktuell befüllt sein (Whitelist)
- Bot braucht `Manage Channels`

## Geprüfte Bot-Integration

### 1) Channel-Name + Topic des Status-Kanals

- Funktion: `updateChannelIndicator(...)` in `bot.js`
- Verhalten:
  - Setzt Präfix im Kanalnamen auf `🟢` / `🟡` / `🔴`
  - Aktualisiert Kanal-Topic mit Online/Offline-Zahlen + Zeit
  - Nutzt Cooldown (`MIN_CHANNEL_RENAME_MS = 6 min`) gegen Discord-Rate-Limits
- Voraussetzung:
  - `CHANNEL_STATUS_INDICATOR=true`
  - `STATUS_CHANNEL_ID` muss auf einen existierenden Kanal zeigen

### 2) Automatische Service-Kanäle pro Uptime-Dienst

- Funktion: `syncServiceChannels(...)` in `bot.js`
- Verhalten:
  - Nutzt `GUILD_ID`, um den Server zu finden
  - Erstellt Kategorie (Standardname `📊 Service Status`) automatisch, falls nicht vorhanden
  - Erstellt pro überwachten Dienst einen Textkanal automatisch
  - Kanalnamen enthalten den Live-Status (`🟢-dienst`, `🟡-dienst`, `🔴-dienst`)
  - Topic wird mit Uptime/Ping aktualisiert
  - Umbenennungen sind ebenfalls rate-limitiert

Wichtig:
- Der Bot verarbeitet hier nur Dienste aus `MONITORED_SERVICES` (Whitelist).
- Wenn `MONITORED_SERVICES` leer ist, wird das Feature aktuell deaktiviert.
- Hinweis: In der Config-Beschreibung steht zwar "leer = alle aktiven", der aktuelle Bot-Code deaktiviert das Feature bei leerer Liste.

## Was du auf Discord vorbereiten solltest

### A) Bot-Rechte

Der Bot braucht mindestens:
- View Channels
- Send Messages
- Embed Links
- Attach Files
- Manage Channels
- Read Message History

Empfohlen zusätzlich:
- Manage Messages (falls Aufräumen im Status-Channel nötig)

### B) Kanal/Server IDs

In Developer Mode in Discord kopieren:
- Server-ID -> `GUILD_ID`
- Status-Kanal-ID -> `STATUS_CHANNEL_ID`

### C) Uptime-Monitorliste

`MONITORED_SERVICES` muss zu den exakten Uptime-Namen passen (kommagetrennt), z. B.:

`MONITORED_SERVICES=Ark-ASA Svartaltheim,Next-Cloud,Pi-VPN,VPN-Mutti,VPN-Andy,VPN-Thomas`

### D) Beispiel `.env`-Block

```env
STATUS_CHANNEL_ID=123456789012345678
CHANNEL_STATUS_INDICATOR=true
GUILD_ID=123456789012345678
SERVICE_CATEGORY_NAME=📊 Service Status
MONITORED_SERVICES=Ark-ASA Svartaltheim,Next-Cloud,Pi-VPN,VPN-Mutti,VPN-Andy,VPN-Thomas
```

## Test-Checkliste

1. Bot starten oder neu starten.
2. Prüfen, ob im Status-Channel Name/Topic angepasst werden.
3. Prüfen, ob Kategorie `SERVICE_CATEGORY_NAME` automatisch erscheint.
4. Prüfen, ob Dienst-Kanäle automatisch erstellt werden.
5. Einen Dienst in Uptime auf Down setzen und auf nächsten Poll warten.
6. Prüfen, ob der zugehörige Kanalname auf `🔴-...` umspringt.

## Fehlerbilder und Ursachen

- Keine Service-Kanäle werden erstellt:
  - `GUILD_ID` fehlt/falsch
  - `MONITORED_SERVICES` leer oder Namen stimmen nicht exakt
  - Bot hat keine Rechte für `Manage Channels`

- Status-Channel ändert Name/Topic nicht:
  - `CHANNEL_STATUS_INDICATOR=false`
  - `STATUS_CHANNEL_ID` falsch
  - Cooldown aktiv (max. 1 Rename je Kanal innerhalb des internen Fensters)

- Alles korrekt in Git Pull, aber UI zeigt kurz Verbindungsfehler:
  - Erwartbar bei Service-Neustart; wurde im Dashboard bereits abgefangen (Reconnect-Logik)
