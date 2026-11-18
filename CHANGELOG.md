# Changelog

## Unreleased

- Dashboard speichert globale Einstellungen jetzt getrennt von Serverprofilen; unveränderte maskierte Geheimnisse werden nicht mehr als Änderungen angezeigt.
- GitHub-Watcher speichert Repository-Farben, Repository-Modi und Release-Darstellung jetzt korrekt im jeweiligen Serverprofil.
- Live-Kachel höher und dynamisch erweitert, damit alle Torschützen unter den jeweiligen Teams angezeigt werden.
- Die Live-Kachel zeigt das letzte beendete Spiel noch 24 Stunden, bevor sie zum nächsten anstehenden Spiel wechselt.
- Live-Kachel zeigt das Stadion an, sofern OpenLigaDB für die Partie einen Spielort liefert.
- OpenLigaDB-Kachelvorschau startet mit einer Live-Torschützenansicht; per Klick kann zwischen Live-Spiel, Countdown und Endstand gewechselt werden.
- Live-Spieldaten und Tabellenstand werden während laufender sowie kürzlich beendeter Partien regelmäßig neu geladen, auch wenn OpenLigaDBs Änderungszeitpunkt unverändert bleibt.
- Vorschauen und Grafikvorlagen-Aktionen im OpenLigaDB-Dashboard verbessert.

## [1.2.0] - 2026-10-26

- Grafische Discord-Karten für Befehlsübersicht und GitHub-Releases, inklusive PNG-Vorschauen im Dashboard.
- GitHub-Release-Watcher mit persistentem Baseline-State und Discord-Benachrichtigungen.
- Individuelle Service-Benachrichtigungskanäle und optionale Cleanup-Info-Nachrichten.
- Dashboard-Verbesserungen für Vorschauen, Konfigurationsänderungen und getrennte Logs.
- Technische Verbesserungen bei Validierung, SVG-Escaping und Release-Notes-Verarbeitung.

[Vollständige Release Notes](https://github.com/ReXx09/Bockis_Discord-Bot/releases/tag/v1.2.0)

## [1.1.0] - 2026-03-24

- Neues Dashboard mit Bot-, System-, Service- und Log-Übersicht sowie automatischer Aktualisierung.
- Update-Prüfung und Live-Update über das Raspberry-Pi-Menü und das Dashboard.
- Zweistufiger Bot-Uninstaller, der wahlweise die Konfiguration bewahrt oder vollständig entfernt.
- Verbesserungen bei API-Routen und JSON-Body-Parsing.

[Vollständige Release Notes](https://github.com/ReXx09/Bockis_Discord-Bot/releases/tag/v1.1.0)
