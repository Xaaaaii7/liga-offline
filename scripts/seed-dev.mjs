import pg from 'pg';

const client = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'postgres', user: 'authenticator', password: 'localdev' });
await client.connect();

await client.query(`
  INSERT INTO seasons (id, name, is_active) VALUES (1, '2026-27', true) ON CONFLICT DO NOTHING;

  INSERT INTO clubs (id, name, short_name) VALUES
    (1, 'Club Norte', 'NOR'), (2, 'Club Sur', 'SUR'), (3, 'Club Este', 'EST'), (4, 'Club Oeste', 'OES')
  ON CONFLICT DO NOTHING;

  INSERT INTO players (id, name, position) VALUES
    (1, 'Portero Norte', 'Goalkeeper'), (2, 'Defensa Norte', 'Defender'),
    (3, 'Medio Norte', 'Midfielder'), (4, 'Delantero Norte', 'Attacker'),
    (5, 'Portero Sur', 'Goalkeeper'), (6, 'Defensa Sur', 'Defender'),
    (7, 'Medio Sur', 'Midfielder'), (8, 'Delantero Sur', 'Attacker'),
    (9, 'Portero Este', 'Goalkeeper'), (10, 'Defensa Este', 'Defender'),
    (11, 'Medio Este', 'Midfielder'), (12, 'Delantero Este', 'Attacker'),
    (13, 'Portero Oeste', 'Goalkeeper'), (14, 'Defensa Oeste', 'Defender'),
    (15, 'Medio Oeste', 'Midfielder'), (16, 'Delantero Oeste', 'Attacker')
  ON CONFLICT DO NOTHING;

  INSERT INTO player_club_memberships (player_id, club_id, season, is_current) VALUES
    (1,1,'2026-27',true), (2,1,'2026-27',true), (3,1,'2026-27',true), (4,1,'2026-27',true),
    (5,2,'2026-27',true), (6,2,'2026-27',true), (7,2,'2026-27',true), (8,2,'2026-27',true),
    (9,3,'2026-27',true), (10,3,'2026-27',true), (11,3,'2026-27',true), (12,3,'2026-27',true),
    (13,4,'2026-27',true), (14,4,'2026-27',true), (15,4,'2026-27',true), (16,4,'2026-27',true)
  ON CONFLICT DO NOTHING;

  INSERT INTO competitions (id, name, slug, season, competition_type)
  VALUES (1, 'Liga Offline Test', 'liga-offline-test', '2026-27', 'league')
  ON CONFLICT (id) DO NOTHING;
  SELECT setval('competitions_id_seq', 1, true);

  INSERT INTO league_teams (id, season, club_id, nickname, competition_id) VALUES
    (1, '2026-27', 1, 'Norte', 1),
    (2, '2026-27', 2, 'Sur', 1),
    (3, '2026-27', 3, 'Este', 1),
    (4, '2026-27', 4, 'Oeste', 1)
  ON CONFLICT (id) DO NOTHING;
  SELECT setval('league_teams_id_seq', 4, true);
`);

console.log('Seed de desarrollo insertado.');
await client.end();
