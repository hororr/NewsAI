# NewsAI

Chrome-bővítmény, ami hírcikkekhez rövid összefoglalót és pontozást ad a Claude segítségével, még mielőtt elolvasnád őket.

- **Cikkoldalon:** jobb felső sarokban 5-10 mondatos összefoglaló, pontszámok (érdekesség, relevancia neked, újdonság, kattintásvadászat) és egy verdikt: érdemes elolvasni / az összefoglaló elég / kihagyható.
- **Címlapon:** minden cikkcím elé kerül egy 1-10-es pontszám-jelvény (zöld = érdemes, sárga = közepes, szürke = kihagyható). A jelvény fölé víve az egérmutatót egy rövid indoklás is látszik. A címlapi pontszám csak a cím alapján készül, a cikket nem tölti le.
- **Bármely más oldalon:** kattints a bővítmény ikonjára, és összefoglalja az aktuális oldalt.

Az eredmények el vannak tárolva a gépeden, így ugyanazért a cikkért nem fizetsz kétszer.

## Telepítés

1. Töltsd le a repót (Code → Download ZIP), és csomagold ki.
2. Chrome-ban nyisd meg a `chrome://extensions` oldalt, és kapcsold be jobb fent a **Fejlesztői módot**.
3. **Kicsomagolt bővítmény betöltése** → válaszd ki az `extension` mappát.
4. Megnyílik a beállítások oldal: add meg az Anthropic API-kulcsodat ([console.anthropic.com](https://console.anthropic.com/settings/keys)) és az érdeklődési köreidet.

## Beállítások

- **Modell:** alapból Claude Haiku 4.5 (gyors és olcsó). Sonnet 5.5 vagy Opus 5.5 jobb minőséget ad, de többe kerül.
- **Érdeklődési körök:** szabad szöveg arról, mi érdekel és mi nem. Ez alapján számol a relevancia és a címlapi pontszám.
- **Híroldalak:** ezeken fut automatikusan (alapból index.hu, telex.hu, 444.hu, hvg.hu, 24.hu, portfolio.hu, origo.hu, magyarnemzet.hu, nepszava.hu).

## Fejlesztés

A forrás a `src/` mappában van, az `extension/` mappába építjük (a lefordított fájlok is a repóban vannak, hogy építés nélkül betölthető legyen).

```sh
npm install
npm run build    # vagy: npm run watch
```

Utána a `chrome://extensions` oldalon a bővítmény frissítés gombjával töltsd újra.
