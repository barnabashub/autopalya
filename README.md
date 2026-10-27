# Matricatérkép

Statikus weboldal, amely megmutatja, kell-e autópálya-matrica egy magyarországi útvonalhoz, melyik a legolcsóbb megoldás, és hol érvényesek a vármegyei matricák. Hét nyelven működik (magyar, angol, német, román, szlovák, lengyel, ukrán), és GitHub Pages-en fut, saját szerver nélkül.

## Mit tud

- **Térkép:** a díjköteles gyorsforgalmi utak (narancs), a díjmentes szakaszok (kék szaggatott), a vármegyehatárok és a fix ellenőrző kapuk.
- **Útvonaltervező:** indulás és érkezés címkereséssel, saját pozícióval vagy a térképre koppintva. A pontok húzhatók.
- **Eredmény:** kell-e matrica, hány km díjköteles, melyik utakon. Egy szalagtérkép mutatja, hol kezdődik a díjköteles rész, és melyik vármegyén megy át az út.
- **Ajánlás:** napi, 10 napos és havi ár egy utazásra. Egész évre a legolcsóbb vármegyei kombinációt számolja ki, beleértve az M1 regionális matricát és a kedvezményes Borsod-Abaúj-Zemplén vármegyei matricát is, és összeveti az éves országossal.
- **Díjmentes alternatíva:** mennyivel tart tovább az út matrica nélkül, és meg is mutatja a térképen.
- **Vármegyék:** a térképre koppintva látszik, mennyibe kerül az adott vármegye matricája, és mely szakaszokon érvényes (a jogszabály szerinti csomópontokkal).
- **Árak** és **Tudnivalók** fül: díjtáblázat, pótdíj, vásárlás lépései, díjkategóriák, érvényesség. Külföldi felhasználóknak forintár mellett hozzávetőleges euróárat is mutat.
- Az állapot benne van az URL-ben (`#a=…&b=…&lang=…`), így egy tervezett útvonal linkként megosztható.

## Felépítés

```
index.html, css/, js/          a weboldal (build lépés nélkül, ES modulok)
  js/core.js                   útvonal ↔ díjköteles hálózat illesztése, legolcsóbb matrica kiszámítása
  js/services.js               külső szolgáltatások (útvonal, címkeresés, árfolyam)
  js/i18n.js                   szövegek 7 nyelven
  js/app.js                    térkép és felület
vendor/leaflet/                Leaflet 1.9.4 (a repóban, CDN nélkül)
data/network.json              díjköteles hálózat: szakaszok és a rájuk érvényes vármegyék, ellenőrző kapuk
data/counties.geojson          vármegyehatárok
data/prices.json               2026-os árak és pótdíjak
data/source/annex1.json        a 45/2020. ITM rendelet 1. melléklete (vármegyei érvényesség szelvényszám szerint)
tools/build_data.py            a data/*.json fájlok előállítása (csak Python standard könyvtár)
tests/                         egységtesztek valós útvonalmintákkal
```

### Hogyan dől el, kell-e matrica

1. A `tools/build_data.py` letölti az összes M-út OSM útvonal-relációját, az utakat folytonos pályatestekre fűzi, és a csomópontszámok (ezek a magyar gyakorlatban a km-szelvényt jelentik) alapján kilométerezi őket.
2. A rendelet melléklete minden vármegyei matrica érvényességét szelvényszám és csomópont szerint adja meg. A pályatesteket ezeken a határokon szétvágja; minden darab megkapja azon vármegyék listáját, amelyek matricája érvényes rajta. Ami egyik tartományba sem esik, az díjmentes.
3. A böngészőben az útvonal geometriáját 20 méterenként végigjárja, és a közeli, azonos irányú hálózati darabhoz illeszti. Ebből adódik a díjköteles hossz és az, hogy mely vármegyék melyik szakaszt fedik le.
4. A legolcsóbb éves vármegyei kombináció egy kis halmazlefedési feladat, amelyet minden érintett vármegye-részhalmazra kipróbálva old meg (M1 regionálissal és anélkül is).

Az építés önellenőrzést is végez: összeveti a rendelet szerinti díjköteles szakaszokat az OSM `toll=yes` címkéivel, és hibával leáll, ha valamelyik vármegyei tartományhoz nem talál geometriát.

### Külső szolgáltatások (mind ingyenes, kulcs nélkül)

| Mire | Szolgáltatás |
|---|---|
| Alaptérkép | OpenStreetMap csempék (szürkeárnyalatosan) |
| Útvonal és díjmentes alternatíva | Valhalla, FOSSGIS (`valhalla1.openstreetmap.de`); tartalék: OSRM, FOSSGIS |
| Címkeresés | Photon (komoot) |
| Euró-árfolyam | Frankfurter (EKB-árfolyam) |

## Adatforrások

- Árak, pótdíjak, szabályok: [nemzetiutdij.hu](https://nemzetiutdij.hu/hu/e-matrica/dijak/e-matrica-arak) (2026. január 1-től érvényes díjtáblázat).
- Vármegyei érvényesség: [45/2020. (XI. 28.) ITM rendelet 1. melléklete](https://njt.hu/jogszabaly/2020-45-20-7Q), a 34/2025. (XI. 30.) ÉKM rendelettel módosított szöveg.
- Úthálózat, ellenőrző kapuk (`highway=toll_gantry`), vármegyehatárok: © OpenStreetMap közreműködők, [ODbL](https://www.openstreetmap.org/copyright).

## Futtatás helyben

```sh
python3 -m http.server 8000     # majd: http://localhost:8000
npm test                        # egységtesztek (Node 20+)
```

## Közzététel GitHub Pages-en

1. A repó **Settings → Pages** oldalán a **Source** legyen **GitHub Actions**.
2. A `main` ágra érkező minden push lefuttatja a teszteket, és közzéteszi az oldalt (`.github/workflows/pages.yml`).

## Karbantartás

- **Év eleji árváltozás:** írd át a `data/prices.json` fájlt a nemzetiutdij.hu díjtáblázata alapján.
- **Rendeletmódosítás (új díjköteles szakasz, vármegyehatár):** frissítsd a `data/source/annex1.json` fájlt, majd futtasd a `python3 tools/build_data.py all` parancsot.
- **Térképadatok:** a `.github/workflows/update-data.yml` havonta újraépíti a hálózatot OpenStreetMapből, és pull requestet nyit a változásról. Kézzel is indítható az Actions fülön.

## Korlátok

- A szakaszhatárok pontossága néhány száz méter: a kilométerezés az OSM csomópontszámaiból készül, ezért egy csomóponton belül a fel- és lehajtók besorolása eltérhet a valóságtól.
- A díjmentes gyűjtő-elosztó pályákat az illesztés a főpályától való távolság alapján különíti el; nagyon közel futó pályáknál ez tévedhet.
- Az ellenőrző kapuk listája az OpenStreetMapből származik, ezért nem feltétlenül teljes. Mobil ellenőrzés bárhol lehet.
- Az oldal tájékoztató jellegű. A díjköteles szakaszok hivatalos listája a 45/2020. ITM rendeletben van.
