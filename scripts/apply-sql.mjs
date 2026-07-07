// Aplica un fichero SQL (p.ej. el generado por simulate-match.js) contra la
// instancia local, vía el mismo wire protocol que usa PostgREST.
// Uso: node scripts/apply-sql.mjs <ruta.sql>
import pg from 'pg';
import { readFileSync } from 'node:fs';

const filePath = process.argv[2];
if (!filePath) {
  console.error('Uso: node scripts/apply-sql.mjs <ruta.sql>');
  process.exit(1);
}

const sql = readFileSync(filePath, 'utf8');
const client = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'postgres', user: 'authenticator', password: 'localdev' });
await client.connect();
try {
  await client.query(sql);
  console.log(`OK: ${filePath} aplicado.`);
} finally {
  await client.end();
}
