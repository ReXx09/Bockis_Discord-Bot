# Discord-Bot um lokale WigiDash-Status-API erweitern

## Ziel

Der bestehende Discord-Bot soll einen kleinen lokalen HTTP-Endpunkt bereitstellen. Das WigiDash-HWiNFO-Widget liest diesen Endpunkt regelmaessig aus und zeigt Discord-Statusdaten im linken 4x4-Bereich an.

Die Discord-Anmeldung und der Discord-Token bleiben ausschliesslich im Bot. Das WigiDash-Widget bekommt keinen Bot-Token und greift nicht direkt auf die Discord-API zu.

## Erwarteter Endpunkt

Der Bot soll standardmaessig diesen Endpunkt anbieten:

```text
GET http://127.0.0.1:47900/status
```

Der Port und der Pfad sollen nach Moeglichkeit ueber eine Konfiguration anpassbar sein.

### Erfolgsantwort

HTTP-Status `200` und JSON mit folgendem Format:

```json
{
  "Username": "ReXx09",
  "Status": "online",
  "Activity": "Minecraft",
  "VoiceChannel": "Gaming",
  "Guild": "Meine Community"
}
```

Alle Felder sind Strings. Wenn ein Wert nicht verfuegbar ist, soll ein leerer String zurueckgegeben werden.

Zulaessige Werte fuer `Status` sind vorzugsweise:

- `online`
- `idle`
- `dnd`
- `offline`

`Status` darf bei Bedarf auch als Discord-kompatibler anderer Statuswert geliefert werden. Das WigiDash-Widget behandelt unbekannte Werte als offline/neutral.

### Fehlerantwort

Wenn der Bot noch keine Discord-Daten hat, soll der Endpunkt trotzdem antworten:

```json
{
  "Username": "",
  "Status": "offline",
  "Activity": "",
  "VoiceChannel": "",
  "Guild": ""
}
```

Der HTTP-Endpunkt soll nicht bei jedem fehlenden Discord-Event mit `500` antworten. Ein temporaer nicht verfuegbarer Discord-Status ist ein normaler Zustand.

## Zu ermittelnde Discord-Daten

Der Bot soll aus seinem bestehenden Discord-Zustand folgende Werte ableiten:

- `Username`: Anzeigename des Zielbenutzers
- `Status`: Online-, Idle-, DND- oder Offline-Status
- `Activity`: aktuelle Aktivitaet bzw. Spielname; leer, wenn keine Aktivitaet vorhanden ist
- `VoiceChannel`: aktueller Sprachkanal; leer, wenn der Benutzer nicht in einem Sprachkanal ist
- `Guild`: Servername des relevanten Servers

Falls der Bot mehrere Server oder Benutzer verwaltet, soll der Zielbenutzer ueber die bestehende Bot-Konfiguration eindeutig festgelegt werden. Keine harte Benutzer-ID direkt im Quellcode einbauen, wenn bereits eine Konfigurationsdatei vorhanden ist.

## Discord-Intents

Pruefen, welche Intents der Bot bereits verwendet. Fuer Presence- und Member-Daten koennen je nach verwendeter Bibliothek erforderlich sein:

- `GuildPresences`
- `GuildMembers`
- gegebenenfalls `Guilds`
- gegebenenfalls `GuildVoiceStates`

Die notwendigen Privileged Intents muessen sowohl im Code als auch im Discord Developer Portal aktiviert werden. Nur die wirklich benoetigten Intents aktivieren.

## HTTP-Server

Die Implementierung soll zum bestehenden Bot-Framework passen.

Anforderungen:

- Server nur an `127.0.0.1` binden, wenn Bot und WigiDash auf demselben Rechner laufen.
- Nicht standardmaessig an `0.0.0.0` binden.
- Keine Discord-Tokens oder OAuth-Tokens in HTTP-Antworten ausgeben.
- Fuer lokale Nutzung ist keine CORS-Unterstuetzung erforderlich.
- `Content-Type: application/json; charset=utf-8` setzen.
- HTTP-Anfragen schnell beantworten und nicht auf neue Discord-Events warten.
- Den zuletzt bekannten Status thread-sicher aus einem Cache lesen.
- Der Bot darf nicht beendet werden, wenn der lokale HTTP-Server nicht gestartet werden kann. Der Fehler soll geloggt werden.
- Beim Herunterfahren des Bots den HTTP-Server sauber beenden.

Wenn der Endpunkt aus dem LAN erreichbar sein muss, soll mindestens ein konfigurierbarer API-Schluessel oder eine vergleichbare Zugriffskontrolle vorgesehen werden. Der API-Schluessel darf nicht im Repository committed werden.

## Konfiguration

Falls das Bot-Projekt bereits eine Konfigurationsdatei besitzt, dort einen Abschnitt ergaenzen, zum Beispiel:

```json
{
  "WigiDashApi": {
    "Enabled": true,
    "Host": "127.0.0.1",
    "Port": 47900,
    "Path": "/status",
    "TargetUserId": "DISCORD_USER_ID"
  }
}
```

Die genaue Konfigurationsstruktur an die bestehende Architektur anpassen. Keine zweite konkurrierende Konfigurationslogik einfuehren.

## Caching und Aktualisierung

Der Bot soll die Daten ereignisbasiert aktualisieren, wenn Discord Presence-, Voice- oder Member-Events eintreffen. Der HTTP-Endpunkt liefert immer den zuletzt bekannten konsistenten Snapshot.

Optional kann ein kurzer Fallback-Timer verwendet werden. Der Endpunkt selbst soll niemals fuer jede Anfrage Discord-REST-Aufrufe ausfuehren.

## Tests

Mindestens folgende Tests oder manuelle Pruefungen ergaenzen:

1. Bot startet mit aktivierter WigiDash-API.
2. `GET http://127.0.0.1:47900/status` liefert HTTP `200`.
3. JSON enthaelt alle fuenf Felder exakt mit den Namen `Username`, `Status`, `Activity`, `VoiceChannel` und `Guild`.
4. Ein Benutzer ohne Aktivitaet liefert `Activity: ""`.
5. Ein Benutzer ausserhalb eines Sprachkanals liefert `VoiceChannel: ""`.
6. Offline- oder noch nicht geladene Daten liefern einen gueltigen Offline-Snapshot statt HTTP `500`.
7. Mehrere parallele Statusanfragen verursachen keine Exception.
8. Der Bot beendet sich sauber und gibt den Port wieder frei.
9. Bei deaktivierter API wird kein HTTP-Port geoeffnet.
10. Es werden keine Tokens, Cookies oder geheimen Konfigurationswerte geloggt.

Beispieltest mit PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:47900/status | ConvertTo-Json
```

## WigiDash-Kompatibilitaet

Das vorhandene WigiDash-Widget verwendet standardmaessig:

```text
http://127.0.0.1:47900/status
```

Die URL kann im Widget unter den Seiten-Einstellungen angepasst werden. Das Widget erwartet keine Discord-Authentifizierung und keinen speziellen Header fuer die lokale Standardkonfiguration.

Der Discord-Button im Widget verwendet standardmaessig:

```text
discord://-/
```

Die Oeffnen-URL kann im Widget ebenfalls angepasst werden.

## Abschlusskriterien

Die Arbeit ist abgeschlossen, wenn:

- der Bot die lokale Status-API bereitstellt,
- der Status-Endpunkt das oben definierte JSON liefert,
- die Daten aus echten Discord-Events stammen,
- die Konfiguration dokumentiert ist,
- Start, Fehlerfall und Shutdown getestet sind,
- keine Geheimnisse im Repository oder in Logs landen,
- und das WigiDash-Widget die Antwort ohne weitere Codeaenderung anzeigen kann.

## Wichtiger Hinweis

Die API soll nur den Status liefern. Aktionen wie Discord oeffnen, Server wechseln, Mikrofon stummschalten oder Voice-Kanaele steuern sind ein separater Ausbauschritt und sollen nicht ungefragt in diesen ersten Status-Endpunkt eingebaut werden.
