# 🚀 Was ist neu in v1.2.0

## 🎨 Grafische Discord-Karten

Die wichtigsten Bot-Informationen können jetzt als moderne, automatisch gerenderte Grafiken in Discord angezeigt werden.

- Grafische Befehlsübersicht als SVG-Rendergrafik
- SVG wird für Discord automatisch als PNG eingebettet
- Kategorien für Info, Fun sowie Admin/Debug
- Anzeige der Anzahl aktivierter Commands
- Automatische Aktualisierung der angehefteten Nachricht
- Automatische Wiederherstellung, falls die Nachricht gelöscht wird
- Fallback auf ein normales Embed, falls `rsvg-convert` nicht verfügbar ist
- Einstellbare Grafikgröße:
  - `compact`
  - `normal`
  - `large`

Neue Einstellung:

```env
DISCORD_COMMAND_TILE_SCALE=large
```

Für die grafische Darstellung auf Raspberry Pi:

```bash
sudo apt-get install -y librsvg2-bin
```

---

## 👁️ Dashboard-Vorschauen

Das Bot-Dashboard enthält jetzt Vorschauen für die grafischen Discord-Karten.

- Vorschau der Befehlsansicht
- Vorschau der GitHub-Release-Ansicht
- PNG-Vorschauen werden ohne Browser-Cache geladen
- Vorschauen sind durch den Dashboard-Zugriffsschutz geschützt
- Release-Vorschau verwendet das eingetragene `owner/repo`

Neue Endpunkte:

| Route | Funktion |
|---|---|
| `/api/previews/commands.png` | Vorschau der Befehlsansicht |
| `/api/previews/github-release.png?repo=owner/repo` | Vorschau eines GitHub-Releases |

---

## 🐙 GitHub-Release-Watcher

Der GitHub-Watcher kann neue Releases mit ihren Release Notes automatisch erkennen und in einem Discord-Kanal veröffentlichen.

- Überwachung mehrerer `owner/repo`-Repositories
- Persistenter Baseline-State verhindert historische Meldungen beim ersten Start
- Neue Releases werden nur einmal gemeldet
- Release-Name, Tag, Veröffentlichungszeit und Notes werden übernommen
- Grafische Release-Notes-Karte im gleichen Stil wie die Befehlsansicht
- Release-Link bleibt im Discord-Embed anklickbar
- Keine unerwünschten Erwähnungen aus Release Notes
- Text-Embed als Fallback, wenn die Grafik nicht erzeugt werden kann

Konfiguration:

```env
DISCORD_GITHUB_WATCH_ENABLED=true
DISCORD_GITHUB_CHANNEL_ID=123456789012345678
DISCORD_GITHUB_REPOS=ReXx09/Bockis_Discord-Bot
DISCORD_GITHUB_POLL_INTERVAL_MS=300000
GITHUB_TOKEN=
```

---

## 📢 Individuelle Service-Kanäle

Statusänderungen können jetzt in den jeweiligen Service-Kanal gesendet werden.

- Zuordnung über `SERVICE_CHANNEL_MAP`
- Automatisch erzeugte Service-Kanäle werden ebenfalls erkannt
- Gemeinsamer `DISCORD_NOTIFICATION_CHANNEL` bleibt Fallback
- Ungültige oder nicht erreichbare Service-Kanäle werden protokolliert
- Der zentrale `STATUS_CHANNEL_ID` wird nicht als Benachrichtigungskanal verwendet

Beispiel:

```env
SERVICE_CHANNEL_MAP=VPN-Thomas=123456789012345678;Next-Cloud=234567890123456789
```

---

## 🧹 Nachrichten-Cleanup

Das automatische Cleanup kann Nutzer jetzt über seine Funktion informieren.

- Optionale Info-Nachricht pro Cleanup-Kanal
- Info nennt die aktive Aufbewahrungsregel
- Nachricht wird angeheftet und persistent gespeichert
- Bei Löschung wird sie automatisch wiederhergestellt
- Die Info-Nachricht wird vom eigenen Cleanup geschützt
- Der zentrale Statuskanal bleibt ausgeschlossen

Neue Einstellung:

```env
MESSAGE_CLEANUP_INFO_ENABLED=true
```

---

## 📋 Dashboard und Konfiguration

- Channel-ID für die öffentliche Befehls-Kachel direkt im Dashboard eintragbar
- Vorschau der Befehls- und Release-Grafiken im Dashboard
- Anzeige der tatsächlichen ungespeicherten Konfigurationsänderungen
- Falsche Dirty-Markierungen nach einem Dashboard-Reload behoben
- Alte und neue Werte ungespeicherter Felder werden angezeigt
- Sensible Werte werden in der Änderungsübersicht maskiert
- Anwendungslogs und Reparatur-Logs getrennt dargestellt
- Bot- und Reparatur-Logs können aus dem Dashboard geleert werden
- Das systemd-Journal bleibt beim Log-Reset erhalten

---

## 🔧 Technische Verbesserungen

- Persistente State-Erweiterungen für Befehls-Kachel, Cleanup-Info und GitHub-Releases
- Geschützte Dashboard-API für Vorschau-Grafiken
- Validierung von Discord-Kanal-IDs und Grafikgrößen
- SVG-Texte werden vor dem Rendern XML-sicher escaped
- Release Notes werden für die Grafikdarstellung bereinigt und begrenzt
- Bestehende Status-, WigiDash- und Reparaturfunktionen bleiben kompatibel

---

## ⚠️ Hinweise zum Update

1. Abhängigkeiten aktualisieren:

   ```bash
   npm install
   ```

2. Auf Raspberry Pi den SVG-Renderer installieren:

   ```bash
   sudo apt-get install -y librsvg2-bin
   ```

3. Neue Einstellungen im Dashboard oder in `.env` prüfen.
4. Bot neu starten:

   ```bash
   sudo systemctl restart bockis-bot
   ```

5. Die GitHub-Release-Funktion sendet beim ersten Poll keine alte Release-Meldung. Sie beginnt mit dem aktuellen Release als Baseline.
