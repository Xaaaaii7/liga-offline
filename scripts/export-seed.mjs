// Vuelca el datadir de PGlite a un blob (tar.gz) que el navegador carga con
// loadDataDir. Es la "semilla" que empaqueta la BD (esquema + funciones +
// catálogo + datos) para la versión PGlite-en-navegador. Requiere que el server
// NO esté usando data/pgdata (una sola conexión física): parar server, exportar,
// arrancar.
//   node scripts/export-seed.mjs [salida]   (por defecto public/seed/pgdata.tar.gz)
import { PGlite } from '@electric-sql/pglite';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = process.argv[2] || path.join(ROOT, 'public/seed/pgdata.tar.gz');

const db = new PGlite(path.join(ROOT, 'data/pgdata'));
await db.waitReady;
const { rows } = await db.query('select count(*)::int n from matches');
console.log(`[export-seed] BD abierta (${rows[0].n} partidos). Volcando…`);
const blob = await db.dumpDataDir('gzip');
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, Buffer.from(await blob.arrayBuffer()));
console.log(`[export-seed] escrito ${out} (${(blob.size / 1e6).toFixed(1)} MB)`);
await db.close();
