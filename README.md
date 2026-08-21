# Unternehmensrisiko-Analyse

Eine einzelne Seite, die zu einem eingegebenen Firmennamen eine strukturierte
360°-Risikorecherche ausführt: Identität des Unternehmens prüfen, öffentlich
zugängliche Quellen durchsuchen, sieben Risikofelder bewerten, SWOT und
Gesamturteil ableiten, Quellen verlinken.

**Die Ergebnisse sind KI-gestützte Einschätzungen und können falsch sein.** Sie
ersetzen keine Sicherheits-, Rechts- oder Anlageberatung, und sie sind keine
Auskunft über Kreditwürdigkeit oder Zuverlässigkeit im Sinne einer Auskunftei.
Was das Werkzeug leistet und was nicht, steht ausführlich in
[impressum.html](impressum.html).

## Was beim Start einer Analyse geschieht

Der eingegebene Name wird **nicht nur verarbeitet, sondern aktiv im Web
gesucht**. Wer das Werkzeug einsetzt, sollte das wissen: interne Projektnamen,
Vorhaben vor der Bekanntgabe und Geschäftsgeheimnisse gehören nicht in das Feld.

| Schritt | Was passiert |
|---|---|
| 1. Identitätsprüfung | Rechtsform, Sitz, Branche und offizielle Domain werden abgeglichen, damit Namensvetter nicht einfließen. Eine abweichende Rechtsform allein trennt kein Unternehmen — Umfirmierung und Konzernstruktur führen sonst zu falschen Trennungen. |
| 2. Zwei Recherchen | Eine breite Unternehmensrecherche und eine zweite, gezielt auf physische Sicherheitsvorfälle gerichtete. Die zweite folgt Standorten und Gerichtsvokabular, weil markante Gebäudenamen in der Berichterstattung oft der einzige Anker sind. |
| 3. Quellenprüfung | Arbeitgeberprofile werden gegen den Firmennamen validiert (siehe unten). |
| 4. Strukturierung | Aus den Rechercheprotokollen entsteht das JSON, das die Seite rendert. |

Die sieben Risikofelder, jeweils 0 (kein Risiko) bis 10 (existenzbedrohend):

| Feld | Gegenstand |
|---|---|
| `geopolitics` | Geopolitische Lage und Abhängigkeiten |
| `reputation` | Öffentliche Wahrnehmung |
| `crime` | Wirtschaftskriminalität **des** Unternehmens: Betrug, Korruption, Geldwäsche, Ermittlungen, Verfahren |
| `burglary` | Kriminalität **gegen** das Unternehmen: Einbruch, Diebstahl, Raub, Vandalismus, Angriffe auf Standorte |
| `protests` | Proteste und Aktionen gegen das Unternehmen |
| `terrorism` | Terrorismusbezug, links- wie rechtsextrem |
| `insider` | Innentäterrisiko, abgeleitet aus Arbeitgeberbewertungen |

## Aufbau

Kein Build-Schritt. `index.html`, `styles.css` und `app.js` liegen fertig im
Repository, Netlify veröffentlicht sie unverändert.

```
index.html                              Die Anwendung
impressum.html                          Anbieterangabe und Datenschutzerklärung
app.js                                  Formular, Statusabfrage, Darstellung
styles.css                              Gestaltung, einschließlich @font-face
fonts/                                  Inter, selbst ausgeliefert (OFL 1.1)
netlify/functions/analyzeRisk-background.mjs   Die eigentliche Analyse
netlify/functions/analyzeRiskStatus.mjs        Statusabfrage für den Browser
test/analysis-utils.test.mjs            Tests der reinen Hilfsfunktionen
```

### Warum Hintergrundfunktion und Abfrage statt einer Anfrage

Eine vollständige Recherche dauert mehrere Minuten und lief damit in die
Zeitgrenze synchroner Netlify-Functions — für die Nutzer sichtbar als
`504 Gateway Timeout`. Deshalb stößt der Browser `analyzeRisk-background` an,
das sofort mit `202` antwortet, und fragt anschließend `analyzeRiskStatus` mit
derselben Auftragskennung ab, bis das Ergebnis vorliegt. Jede einzelne Anfrage
bleibt so weit innerhalb der Grenze.

Die Kennung ist eine im Browser erzeugte UUID (Version 4). Zwischenstand und
Ergebnis liegen im Netlify-Objektspeicher unter dem Namen `risk-jobs`, mit
`consistency: 'strong'` — sonst meldet die Abfrage gelegentlich noch
„in Bearbeitung", obwohl die Hintergrundfunktion längst geschrieben hat.

### Modell und Suche

Die Analyse läuft über **Google Gemini** (`gemini-2.5-flash`, Paket
`@google/genai`) mit Google-Suche als Grounding. Erforderlich ist die
Umgebungsvariable `GEMINI_API_KEY` (alternativ `GOOGLE_API_KEY`); ohne sie
startet keine Analyse.

Ein Detail, das beim Umbau leicht verlorengeht: Die Grounding-Metadaten — also
die tatsächlich konsultierten Seiten — kommen nur bei einer *gegroundeten*
Antwort zurück. Wer die Suche abschaltet oder das Ergebnis aus einem zweiten,
ungegroundeten Aufruf zusammensetzt, verliert die Quellenliste, ohne dass ein
Fehler auftritt.

## Entwicklung

```bash
npm install
npm test
```

Acht Tests, alle auf reine Hilfsfunktionen ohne Netzzugriff: Zusammenführen und
Neunummerieren der Quellen, die Zuordnung von Arbeitgeberprofilen und das
Aussortieren interpoliert wirkender Zeitreihen. Sie brauchen keinen API-Schlüssel.

Für die vollständige Anwendung mitsamt Functions:

```bash
netlify dev
```

## Bekannte Grenzen

**Arbeitgeberbewertungen werden bewusst großzügig zugeordnet.** Kununu und
Glassdoor führen dasselbe Unternehmen unter Schreibweisen, die sich nicht exakt
abgleichen lassen; strenge Zuordnung ließ zu viele Treffer liegen. Der Preis
sind gelegentliche Fehlzuordnungen. Die verlinkten Profile und die daraus
abgeleiteten Mitarbeiterindikatoren sind deshalb vor jeder Verwendung von Hand
zu prüfen. Genau dieser Fall wird in `test/analysis-utils.test.mjs` an
„Geiger Edelmetalle" gegen „Geiger GmbH" festgehalten.

**Gespeicherte Analysen werden derzeit nicht automatisch gelöscht.** Jeder
Auftrag hinterlässt im Objektspeicher einen Datensatz aus Firmenname, Status,
Zeitstempel und vollständigem Ergebnis, und dort bleibt er, bis ihn jemand von
Hand entfernt. Ein Aufräumen nach Frist wäre die nächste sinnvolle Änderung.

**Das Eingabefeld nimmt jeden Text an.** Gedacht ist es für Unternehmen, und
die Recherche sucht ausdrücklich nach Ermittlungen und Verfahren — auf eine
natürliche Person angewandt, entstünde ein Persönlichkeitsprofil zu Vorwürfen.
Das ist nicht der Zweck und wäre datenschutzrechtlich unzulässig.

## Datenschutz in Kürze

Keine Cookies, kein Browser-Speicher, keine Reichweitenmessung, nichts von
Dritten nachgeladen: Stylesheet, Skript und Schrift kommen von dieser Domain.
Die Schrift Inter lag bis zum 21. August 2026 bei Google Fonts, wodurch bei
jedem Aufruf die Besucher-IP an Google ging; sie wird seither aus `fonts/`
ausgeliefert. Übermittelt wird ausschließlich der eingegebene Firmenname, und
zwar an Google. Vollständig in [impressum.html](impressum.html).
