// Crea una competición de prueba usando clubes REALES ya importados por
// import-catalog.mjs (Liverpool/Man City/Chelsea/Man United — con plantilla
// y efootball_overall reales). Requiere haber corrido import-catalog.mjs
// antes; este script ya no inventa clubes/jugadores sintéticos (los ids
// bajos que usaba antes chocan con ids reales de producción, que llegan a
// los 10 millones).
import pg from 'pg';

const client = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'postgres', user: 'authenticator', password: 'localdev' });
await client.connect();

const CLUBS = [
  { id: 64, nickname: 'Liverpool' },
  { id: 65, nickname: 'ManCity' },
  { id: 61, nickname: 'Chelsea' },
  { id: 66, nickname: 'ManUnited' },
];

const { rows: existing } = await client.query(`SELECT id FROM clubs WHERE id = ANY($1::bigint[])`, [CLUBS.map(c => c.id)]);
if (existing.length < CLUBS.length) {
  console.error(`Faltan clubes (${existing.length}/${CLUBS.length} encontrados). Corre antes: node scripts/import-catalog.mjs`);
  process.exit(1);
}

await client.query(`
  INSERT INTO seasons (id, name, is_active) VALUES (1, '2026-27', true) ON CONFLICT DO NOTHING;

  INSERT INTO competitions (id, name, slug, season, competition_type)
  VALUES (1, 'Liga Offline Test', 'liga-offline-test', '2026-27', 'league')
  ON CONFLICT (id) DO NOTHING;
  SELECT setval('competitions_id_seq', 1, true);
`);

for (let i = 0; i < CLUBS.length; i++) {
  const { id: clubId, nickname } = CLUBS[i];
  await client.query(
    `INSERT INTO league_teams (id, season, club_id, nickname, competition_id)
     VALUES ($1, '2026-27', $2, $3, 1) ON CONFLICT (id) DO NOTHING`,
    [i + 1, clubId, nickname]
  );
}
await client.query(`SELECT setval('league_teams_id_seq', $1, true);`, [CLUBS.length]);

console.log('Seed de desarrollo insertado (competición de prueba con clubes reales).');
await client.end();
