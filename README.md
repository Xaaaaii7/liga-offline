# Liga Offline

Liga de fútbol **offline vs IA**: creas competiciones con clubes reales de eFootball, se simulan los partidos (motor propio: fuerza por OVR, formaciones, tarjetas, sustituciones, lesiones, suspensiones…) y registras tus propios resultados —incluso **adjuntando fotos** de las pantallas de eFootball, que un OCR local rellena por ti.

Funciona **100% en local**, sin cuenta ni servidores externos.

---

## Dos formas de usarla

### A) Modo PWA (recomendado): instalable y offline, sin backend

La app corre entera en el **navegador** con PGlite (Postgres en WebAssembly). No necesita PostgREST ni conexión.

1. Sirve la carpeta `public/` por HTTP (hace falta HTTP para el service worker; `file://` no vale). Puede ser cualquier servidor estático, o el propio `server.mjs` (ver abajo).
2. Abre `http://localhost:8080/index.html?pglite=1`. El parámetro `?pglite=1` activa el modo PGlite (queda recordado; `?pglite=0` lo desactiva).
3. **Instalar la app**:
   - **PC (Chrome/Edge)**: icono de instalar en la barra de direcciones, o menú ⋮ → *«Instalar Liga Offline»*.
   - **Android (Chrome)**: menú ⋮ → *«Añadir a pantalla de inicio»* / *«Instalar app»*.
   - **iOS (Safari)**: botón compartir → *«Añadir a pantalla de inicio»*.
4. Una vez abierta e usada online la primera vez, el service worker cachea todo (incluido el motor wasm y el catálogo) y **funciona sin conexión**.

> La app arranca con el catálogo de clubes/jugadores y **en blanco** de competiciones: tú creas las tuyas. Tus datos se guardan en el navegador (IndexedDB).

### B) Modo servidor (desarrollo)

Levanta PGlite + PostgREST + servidor estático en Node (útil para desarrollar con la misma API que la app online).

```bash
npm install
node server.mjs
# abre http://127.0.0.1:8080
```

`server.mjs` descarga el binario de PostgREST la primera vez y crea la BD en `data/pgdata`.

---

## Puesta a punto para el modo PWA (regenerar binarios)

Los binarios grandes están **fuera de git** (`.gitignore`) porque son regenerables. Antes de servir la app en modo PWA, genéralos:

```bash
npm install

# 1) Vendorizar PGlite (motor wasm) → public/vendor/pglite/
cp -r node_modules/@electric-sql/pglite/dist/* public/vendor/pglite/

# 2) Vendorizar Tesseract (OCR offline) → public/vendor/tesseract/
mkdir -p public/vendor/tesseract/lang
cp node_modules/tesseract.js/dist/tesseract.min.js node_modules/tesseract.js/dist/worker.min.js public/vendor/tesseract/
cp node_modules/tesseract.js-core/tesseract-core*-lstm.wasm node_modules/tesseract.js-core/tesseract-core*-lstm.wasm.js node_modules/tesseract.js-core/tesseract-core*-lstm.js public/vendor/tesseract/
curl -L https://tessdata.projectnaptha.com/4.0.0/eng.traineddata.gz -o public/vendor/tesseract/lang/eng.traineddata.gz

# 3) Seed de distribución (catálogo, sin competiciones): requiere el server parado
node scripts/export-seed.mjs                 # vuelca data/pgdata → public/seed/pgdata.tar.gz
node scripts/export-seed-clean.mjs           # versión limpia (catálogo sin datos de usuario)
```

(Los `npm install -D tesseract.js` / `@electric-sql/pglite` ya son dependencias del proyecto.)

---

## Estructura

- `public/` — la app (HTML/JS/CSS). Estáticos; es lo que se sirve.
  - `js/modules/pglite-client.js` — cliente compatible con la API de supabase-js sobre PGlite en el navegador.
  - `js/modules/ocr-efootball.js` — OCR local (Tesseract) de las fotos de stats/valoraciones.
  - `manifest.webmanifest`, `service-worker.js` — PWA.
  - `vendor/`, `seed/` — binarios regenerables (fuera de git).
- `scripts/` — simulación (`simulate-match.js`), re-simulación, export de seed, import de catálogo.
- `supabase/schema/*.sql` — esquema + funciones (mismo que corre en PGlite).
- `server.mjs` — runtime de desarrollo (PGlite + PostgREST + estáticos).
