// Descarga los escudos de club (hoy clubs.crest_url apunta a
// crests.football-data.org, es decir a internet) a ficheros locales dentro de
// public/img/crests/<club_id>.png y repunta clubs.crest_url a esa ruta local,
// para que la app sea de verdad offline. Idempotente: si el fichero ya existe
// no lo vuelve a bajar.
//
// Uso: node scripts/import-crests.mjs   (requiere server.mjs corriendo)
import pg from 'pg';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const CRESTS_DIR = path.resolve('public/img/crests');
await mkdir(CRESTS_DIR, { recursive: true });

const client = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'postgres', user: 'authenticator', password: 'localdev' });
await client.connect();

const { rows } = await client.query(
  `SELECT id, name, crest_url FROM clubs WHERE crest_url LIKE 'http%' ORDER BY id`
);
console.log(`[import-crests] ${rows.length} clubes con escudo remoto.`);

let downloaded = 0, repointed = 0, failed = 0;
for (const club of rows) {
  const localRel = `img/crests/${club.id}.png`;
  const localAbs = path.join(CRESTS_DIR, `${club.id}.png`);

  let exists = false;
  try { await access(localAbs, constants.F_OK); exists = true; } catch {}

  if (!exists) {
    try {
      const res = await fetch(club.crest_url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(localAbs, buf);
      downloaded++;
    } catch (e) {
      console.warn(`  ✗ ${club.name} (${club.crest_url}): ${e.message}`);
      failed++;
      continue;
    }
  }

  await client.query(`UPDATE clubs SET crest_url = $1 WHERE id = $2`, [localRel, club.id]);
  repointed++;
}

console.log(`[import-crests] descargados=${downloaded} repuntados=${repointed} fallidos=${failed}`);
await client.end();
