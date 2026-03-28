# Discord Kanal-Setup Anleitung

Stand: 28.03.2026

## Ziel dieser Anleitung

Mit dieser Anleitung richtest du den Bot so ein, dass er:

1. Eine Kategorie fuer Uptime-Dienste nutzt (oder automatisch erstellt).
2. Fuer jeden konfigurierten Dienst einen eigenen Kanal erstellt.
3. Den Status pro Dienst direkt in der Kanalleiste anzeigt (`🟢`, `🟡`, `🔴`).
4. Deinen Status-Hauptkanal (Name + Topic) automatisch aktualisiert.

## Wichtig vorab

Ja, das ist mit dem aktuellen Bot moeglich.

Du musst nicht jeden Dienst-Kanal manuell erstellen.
Der Bot kann Kategorie und Dienst-Kanaele selbst anlegen und bei Statusaenderungen umbenennen.

## Voraussetzungen

1. Der Bot ist auf deinem Server eingeladen.
2. Der Bot hat die noetigen Rechte.
3. Du hast die IDs fuer Server und Status-Kanal.
4. Uptime Kuma liefert die Monitore, die du anzeigen willst.

## 1. Discord vorbereiten

### 1.1 Developer Mode aktivieren

1. Discord -> Benutzereinstellungen -> Erweitert.
2. `Entwicklermodus` aktivieren.

### 1.2 Bot-Rechte pruefen

Der Bot braucht mindestens:

- View Channels
- Send Messages
- Embed Links
- Attach Files
- Manage Channels
- Read Message History

Empfohlen zusaetzlich:

- Manage Messages

## 2. Benoetigte IDs sammeln

1. Rechtsklick auf deinen Server -> `ID kopieren` -> `GUILD_ID`.
2. Rechtsklick auf den Status-Hauptkanal -> `ID kopieren` -> `STATUS_CHANNEL_ID`.

## 3. .env konfigurieren

Trage mindestens folgende Werte in deine `.env` ein:

```env
STATUS_CHANNEL_ID=123456789012345678
CHANNEL_STATUS_INDICATOR=true
GUILD_ID=123456789012345678
SERVICE_CATEGORY_NAME=Service Status
MONITORED_SERVICES=Ark-ASA Svartaltheim,Next-Cloud,Pi-VPN,VPN-Mutti,VPN-Andy,VPN-Thomas
```

## 4. Bedeutung der wichtigsten Variablen

1. `STATUS_CHANNEL_ID`
   Der bestehende Hauptkanal fuer die Status-Nachricht.

2. `CHANNEL_STATUS_INDICATOR`
   Wenn `true`, setzt der Bot im Hauptkanal Emoji + Topic automatisch.

3. `GUILD_ID`
   Pflicht fuer die automatische Dienst-Kanal-Funktion.

4. `SERVICE_CATEGORY_NAME`
   Name der Kategorie fuer Dienst-Kanaele.
   Wenn die Kategorie nicht existiert, erstellt der Bot sie.

5. `MONITORED_SERVICES`
   Kommagetrennte Whitelist mit exakten Uptime-Dienstnamen.
   Nur diese Dienste werden als eigene Kanaele erstellt/aktualisiert.

## 5. Was der Bot automatisch macht

1. Sucht den Server per `GUILD_ID`.
2. Sucht oder erstellt die Kategorie `SERVICE_CATEGORY_NAME`.
3. Erstellt pro Dienst in `MONITORED_SERVICES` einen Textkanal.
4. Setzt Kanalnamen im Format `🟢-dienstname`, `🟡-dienstname`, `🔴-dienstname`.
5. Aktualisiert den Namen bei Statuswechseln (mit Rate-Limit-Schutz).
6. Aktualisiert den Hauptkanal (`STATUS_CHANNEL_ID`) mit Gesamtstatus im Namen und Topic.

## 6. Wichtige aktuelle Einschraenkung

Wenn `MONITORED_SERVICES` leer ist, ist die automatische Dienst-Kanal-Funktion aktuell deaktiviert.

Hinweis:
In Teilen der Konfigurationsbeschreibung steht "leer = alle aktiven". Das entspricht derzeit nicht dem Laufzeitverhalten. Fuer die automatische Erstellung muss die Liste aktuell befuellt sein.

## 7. Einrichtung testen

1. Bot neu starten.
2. Im Discord-Server pruefen, ob die Kategorie vorhanden ist.
3. Pruefen, ob Dienst-Kanaele erstellt wurden.
4. Einen Monitor in Uptime Kuma auf `down` bringen.
5. Auf den naechsten Update-Zyklus warten.
6. Pruefen, ob der Kanalname auf `🔴-...` wechselt.
7. Pruefen, ob im Hauptkanal Name/Topic aktualisiert werden.

## 8. Fehlerbehebung (kurz)

### Problem: Keine Dienst-Kanaele werden erstellt

Pruefen:

1. `GUILD_ID` korrekt?
2. `MONITORED_SERVICES` nicht leer?
3. Namen exakt wie in Uptime Kuma geschrieben?
4. Bot hat `Manage Channels`?

### Problem: Hauptkanal bekommt keine Emoji/Topic-Aenderung

Pruefen:

1. `CHANNEL_STATUS_INDICATOR=true`?
2. `STATUS_CHANNEL_ID` korrekt?
3. Cooldown aktiv? (Umbenennungen sind rate-limitiert)

### Problem: Nach Update kurz Verbindungsfehler im Web-UI

Das kann waehrend Service-Neustart kurz normal sein. Die Reconnect-Logik im Dashboard faengt das inzwischen ab.

## 9. Schnell-Checkliste fuer neue Nutzer

1. IDs holen (`GUILD_ID`, `STATUS_CHANNEL_ID`).
2. Bot-Rechte setzen (`Manage Channels` wichtig).
3. `.env` mit `MONITORED_SERVICES` befuellen.
4. Bot starten.
5. Kategorie/Kanaele und Status-Emoji im Discord pruefen.
