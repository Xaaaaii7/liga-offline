// Genera el seed de DISTRIBUCIÓN: catálogo (clubs/players/memberships/leagues/
// seasons/geo) SIN las competiciones/partidos/stats del usuario. Carga el dump
// actual en una instancia fresca (no toca data/pgdata), borra los datos de
// usuario con TRUNCATE ... CASCADE, compacta con VACUUM FULL y vuelve a volcar.
//   node scripts/export-seed-clean.mjs [entrada.tar.gz] [salida.tar.gz]
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const inPath = process.argv[2] || path.join(ROOT, 'public/seed/pgdata.tar.gz');
const outPath = process.argv[3] || path.join(ROOT, 'public/seed/pgdata-clean.tar.gz');

const db = new PGlite({ loadDataDir: new Blob([await readFile(inPath)]) });
await db.waitReady;

const before = await db.query('select count(*)::int c from players');
console.log(`[clean] cargado (${before.rows[0].c} jugadores en catálogo).`);

// TRUNCATE competitions CASCADE arrastra todo lo que referencia a competitions
// (league_teams, matches, y transitivamente stats/goles/tarjetas/ratings/best_xi
// /mvp/formations/…). El catálogo (clubs/players/leagues/seasons) es independiente.
await db.exec('TRUNCATE competitions CASCADE;');

const comps = await db.query('select count(*)::int c from competitions');
const matches = await db.query('select count(*)::int c from matches');
const players = await db.query('select count(*)::int c from players');
const clubs = await db.query('select count(*)::int c from clubs');
console.log(`[clean] tras truncar → competiciones=${comps.rows[0].c}, partidos=${matches.rows[0].c} | catálogo intacto: jugadores=${players.rows[0].c}, clubs=${clubs.rows[0].c}`);

await db.exec('VACUUM FULL;');
const blob = await db.dumpDataDir('gzip');
await writeFile(outPath, Buffer.from(await blob.arrayBuffer()));
console.log(`[clean] escrito ${outPath} (${(blob.size / 1e6).toFixed(1)} MB)`);
await db.close();
