# AVE-Kiosk

Touch-Oberfläche über der lokal laufenden Audi Visualization Engine (AVE, UE5). Steuerung über das
EventInterface (`http://localhost:4242/events`), im Betrieb ohne Internet.
Ausführliche Architektur: technische Dokumentation (Claude Docs, „AVE-Kiosk – Technische Dokumentation“).

## Inhalt

| Datei | Zweck |
| --- | --- |
| `main.js` | Electron-Hauptprozess: Fenster, AVE-Steuerung, Katalog, Spots, Leerlauf |
| `frontend.html` | Walzen und Aktionsleiste (ein Fenster je Teil, `?part=`) |
| `touch.html` | Touch-Fläche über der AVE, Spot-Punkte |
| `katalog.json` | Gesamtkatalog (Modelle, Farben, Felgen, Exklusivfarben) |
| `tools/dcc-erfassen.js` | DCC-Sucher für neue Modelle (Laptop mit Internet) |
| `config.example.json` | Beispiel für die lokale `config.json` |
| `tests/` | Tests der Rechenfunktionen (PR-String, Optionen, Spot-Sichtbarkeit) |

Nicht im Repository, nur auf dem Kiosk-PC: `config.json`, `umgebungen.json`, `fahrzeuge.json`, `bilder/`,
`kiosk.bat` und die dortige `package.json`.

## Tests

Node 18 oder neuer, keine Abhängigkeiten:

```
npm test
```

Die Tests laden `main.js` unverändert in eine Umgebung ohne Electron (`tests/lade-main.js`) und rufen
die Funktionen direkt auf. Testfälle aus echten Logs stehen mit Datum im Testnamen.

## Auf den Kiosk-PC bringen

`main.js`, `frontend.html`, `touch.html`, `katalog.json` nach `C:\ave-kiosk\` kopieren, Kiosk neu starten.
