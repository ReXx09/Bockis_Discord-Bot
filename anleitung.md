# WigiDash-Integration: Aufgabenliste

Stand: 2026-10-11

Diese Datei ist die gemeinsame Arbeitsliste fuer das Bot-Repository und das
separate WigiDash-Widget-Repository. Erledigte Punkte bleiben dokumentiert,
damit die naechsten Arbeiten im Widget-Repository ohne Rueckfragen fortgesetzt
werden koennen.

## Architektur und Datenschutz

- [x] Der Discord-Token bleibt ausschliesslich im Bot.
- [x] Das WigiDash greift nicht direkt auf die Discord-API zu.
- [x] Der Bot stellt eine lokale HTTP-API bereit.
- [x] Standard-Endpunkt: `GET http://<PI-IP>:47900/status`.
- [x] Port und Pfad sind ueber `.env` konfigurierbar.
- [x] Die WigiDash-API ist optional und standardmaessig deaktiviert.
- [x] Nachrichten werden nur bei aktivierter Nachrichtenanzeige erfasst.
- [x] Nachrichtentexte werden lokal auf 500 Zeichen begrenzt.
- [ ] Im WigiDash-Widget eine sichtbare Datenschutz-/Lokalanzeige ergaenzen.

## Im Bot bereits abgeschlossen

### Statusdaten

- [x] `Username`: Discord-Anzeigename des Zielbenutzers.
- [x] `Status`: `online`, `idle`, `dnd` oder `offline`.
- [x] `Activity`: aktuelle Aktivitaet oder Spielname.
- [x] `VoiceChannel`: aktueller Sprachkanal.
- [x] `Guild`: Name der relevanten Discord-Guild.
- [x] Ereignisbasierte Aktualisierung bei Presence-, Voice- und Member-Events.
- [x] Stabiler Cache statt Discord-REST-Abfrage bei jeder HTTP-Anfrage.

### Mehrere Benutzer

- [x] `WIGIDASH_TARGET_USER_ID` fuer den persoenlichen Einzelstatus.
- [x] `WIGIDASH_TARGET_GUILD_ID` fuer anwesende Guild-Mitglieder.
- [x] `Users` mit online-, idle- und dnd-Mitgliedern.
- [x] `OnlineCount` als Anzahl der erkannten anwesenden Mitglieder.
- [x] Zieluser und Guild-Liste koennen gleichzeitig aktiv sein.
- [ ] `WIGIDASH_TARGET_CHANNEL_ID` als echte Sprachkanal-Mitgliederliste auswerten.

### Nachrichtenanzeige

- [x] `WIGIDASH_MESSAGE_ENABLED` als ausdruecklicher Aktivierungsschalter.
- [x] `WIGIDASH_TARGET_CHANNEL_ID` als Nachrichtenfilter.
- [x] Nachrichten des Zielusers koennen erfasst werden.
- [x] Nachrichten aus dem Zielkanal koennen erfasst werden.
- [x] Guild-Filter wird vor der Speicherung angewendet.
- [x] `LastMessage` wird ueber `/status` bereitgestellt.
- [x] Gespeichert werden Autor, Autor-ID, Kanal, Kanal-ID, Inhalt, Anhanganzeige
      und Zeitstempel.
- [x] Bot- und Systemnachrichten werden nicht als Benutzernachricht gespeichert.

Beispiel:

```json
{
  "LastMessage": {
    "Author": "Max",
    "AuthorId": "123456789012345678",
    "Channel": "allgemein",
    "ChannelId": "987654321098765432",
    "Content": "Hallo!",
    "AttachmentCount": 0,
    "Timestamp": "2026-10-11T18:30:00.000Z"
  }
}
```

## Aktuelle Konfiguration

```env
WIGIDASH_API_ENABLED=true
WIGIDASH_API_HOST=0.0.0.0
WIGIDASH_API_PORT=47900
WIGIDASH_API_PATH=/status

# Persoenlicher Status, optional
WIGIDASH_TARGET_USER_ID=

# Guild fuer die Benutzerliste und Nachrichtenbegrenzung
WIGIDASH_TARGET_GUILD_ID=

# Letzte passende Nachricht uebertragen
WIGIDASH_MESSAGE_ENABLED=false

# Optionaler Kanalfilter fuer Nachrichten
WIGIDASH_TARGET_CHANNEL_ID=

# Nur bei LAN-Zugriff setzen; niemals committen
WIGIDASH_API_KEY=
```

Hinweis: `WIGIDASH_TARGET_CHANNEL_ID` ist aktuell ein Nachrichtenfilter. Eine
separate Filterung der `Users`-Liste auf Mitglieder eines Sprachkanals ist noch
offen.

## Fuer das WigiDash-Widget-Repository offen

### API-Datenquelle

- [ ] URL-Feld auf `http://<PI-IP>:47900/status` konfigurieren.
- [ ] HTTP-Timeout von etwa 3 bis 5 Sekunden setzen.
- [ ] Polling-Intervall festlegen, empfohlen 5 bis 15 Sekunden.
- [ ] Fehlerzustand bei Timeout oder ungueltigem JSON anzeigen.
- [ ] Keine Discord-Zugangsdaten im Widget speichern.

### Mehrere Benutzer darstellen

- [ ] JSON-Feld `Users` auslesen.
- [ ] Pro Benutzer Name und Status anzeigen.
- [ ] Statusfarben fuer online, idle, dnd und offline definieren.
- [ ] `OnlineCount` als Zaehler anzeigen.
- [ ] Leere Benutzerliste als „Keine Benutzer online“ darstellen.
- [ ] Lange Namen und viele Benutzer ohne Layout-Spruenge darstellen.
- [ ] Benutzerliste fuer D-Pad-/Tastaturbedienung fokussierbar machen.

### Nachrichtendarstellung

- [ ] `LastMessage` auslesen.
- [ ] Autor, Kanal und relative Zeit anzeigen.
- [ ] Nachrichtentext in einem begrenzten Textfeld darstellen.
- [ ] Neue Nachricht optisch markieren, zum Beispiel Rahmen, Farbe oder kurze
      Animation.
- [ ] Alte Nachricht nach einem definierten Zeitraum ausblenden oder als alt
      markieren.
- [ ] Nachrichtenwechsel anhand von `Timestamp` erkennen.
- [ ] Fehlende `LastMessage` sauber als „Keine neue Nachricht“ behandeln.
- [ ] Sonderzeichen, Zeilenumbrueche und sehr lange Texte sicher darstellen.
- [ ] Keine HTML-Auswertung aus dem Nachrichtentext zulassen.

### Widget-Interaktion

- [ ] Bestehende Einzelstatusfelder weiter unterstuetzen.
- [ ] Mehrbenutzeransicht optional ein- und ausblendbar machen.
- [ ] Nachrichtenanzeige optional ein- und ausblendbar machen.
- [ ] WigiDash-Layout fuer 4x4-Anzeige testen.
- [ ] Darstellung bei Offline-Bot, leerer Antwort und API-Fehler testen.
- [ ] Discord-Schaltflaeche unveraendert mit `discord://-/` testen.

## Discord- und Bot-Voraussetzungen

- [x] `GuildPresences` im Bot aktiviert.
- [x] `GuildMembers` im Bot aktiviert.
- [x] `GuildVoiceStates` im Bot aktiviert.
- [x] `GuildMessages` und `MessageContent` im Bot aktiviert.
- [ ] Im Discord Developer Portal Presence Intent aktivieren.
- [ ] Im Discord Developer Portal Server Members Intent aktivieren.
- [ ] Im Discord Developer Portal Message Content Intent aktivieren.
- [ ] Bot-Berechtigungen fuer die Ziel-Guild und den Zielkanal pruefen.

## Testaufgaben

- [x] Bot-Syntax mit `node --check bot.js` pruefen.
- [x] API-Syntax mit `node --check web/routes.js` pruefen.
- [x] Dashboard-Template kompilieren.
- [x] Bei deaktivierter WigiDash-API wird kein Port geoeffnet.
- [ ] `curl http://127.0.0.1:47900/status` auf dem Pi testen.
- [ ] Antwort bei gesetzter Zieluser-ID pruefen.
- [ ] Antwort mit `Users` und `OnlineCount` pruefen.
- [ ] Nachricht vom Zieluser testen.
- [ ] Nachricht aus dem Zielkanal testen.
- [ ] Nachricht ausserhalb des Filters darf nicht erscheinen.
- [ ] Neustart des Bots und Cache-Verhalten pruefen.
- [ ] WigiDash-Widget mit leerem, fehlerhaftem und vollstaendigem JSON testen.
- [ ] Keine Tokens, API-Keys oder Cookies in der Antwort pruefen.

Beispieltests auf dem Pi:

```bash
curl -sS http://127.0.0.1:47900/status | jq
sudo ss -ltnp | grep 47900
sudo journalctl -u bockis-bot -n 80 --no-pager
```

## Abnahmekriterien

- [ ] Das Widget zeigt den persoenlichen Zieluser korrekt an.
- [ ] Das Widget zeigt die Guild-Mitgliederliste korrekt an.
- [ ] Das Widget zeigt neue passende Nachrichten optisch erkennbar an.
- [ ] Falsche oder nicht passende Nachrichten werden nicht angezeigt.
- [ ] API-Ausfall und Bot-Neustart fuehren zu einem definierten Fehlerzustand.
- [ ] Keine Geheimnisse werden an das Widget oder in Logs uebertragen.
- [ ] Die Anzeige funktioniert auf dem vorgesehenen 4x4-WigiDash-Layout.

## Bewusst nicht Bestandteil dieser Aufgabenliste

- Discord-Nachrichten senden oder loeschen.
- Server wechseln oder Discord-Aktionen aus dem Widget ausfuehren.
- Mikrofon- oder Voice-Steuerung.
- Weitergabe des Discord-Tokens an das WigiDash.
- Oeffentliche Bereitstellung der Nachrichten-API ueber Cloudflare.
