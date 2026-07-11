// Parches de esquema que se aplican EN RUNTIME a bases de datos ya sembradas.
//
// El esquema vive dentro del seed (public/seed/*.tar.gz): una BD que un usuario
// ya tiene en IndexedDB conserva las funciones VIEJAS aunque arreglemos el .sql
// fuente (que solo afecta a seeds nuevos). Este módulo aplica CREATE OR REPLACE
// idempotentes sobre la BD existente. Se ejecuta una sola vez por versión
// (flag en localStorage); sube SCHEMA_PATCH_VERSION al añadir un parche nuevo.

export const SCHEMA_PATCH_VERSION = 1;

// SQL idempotente. Debe poder ejecutarse entero con db.exec() sobre cualquier
// BD sembrada sin romper (solo CREATE OR REPLACE / cosas idempotentes).
export const SCHEMA_PATCHES_SQL = `
-- v1: get_team_matches lanzaba "column reference home_goals is ambiguous" en
-- PGlite (las columnas OUT del RETURNS TABLE chocan con las de matches en los
-- SELECT…INTO). Se fuerza que gane la columna con #variable_conflict use_column.
CREATE OR REPLACE FUNCTION get_team_matches(p_competition_id integer, p_team_nickname text)
 RETURNS TABLE(match_id integer, jornada integer, match_date date, match_time time without time zone, home_team_nickname text, home_team_display_name text, away_team_nickname text, away_team_display_name text, home_goals integer, away_goals integer, is_home boolean, opponent_nickname text, opponent_display_name text, team_goals integer, opponent_goals integer, result text, is_played boolean, is_next_match boolean, is_last_match boolean, stream_url text, resolved_administratively boolean)
 LANGUAGE plpgsql AS $function$
#variable_conflict use_column
DECLARE
    v_league_team_id INTEGER; v_next_match_id INTEGER; v_last_match_id INTEGER;
BEGIN
    SELECT id INTO v_league_team_id FROM league_teams
    WHERE competition_id = p_competition_id AND (nickname ILIKE p_team_nickname OR display_name ILIKE p_team_nickname) LIMIT 1;
    IF v_league_team_id IS NULL THEN RETURN; END IF;

    SELECT match_uuid INTO v_next_match_id FROM matches
    WHERE competition_id = p_competition_id AND (home_league_team_id = v_league_team_id OR away_league_team_id = v_league_team_id)
      AND (home_goals IS NULL OR away_goals IS NULL)
    ORDER BY round_id ASC, match_date ASC, match_time ASC LIMIT 1;

    SELECT match_uuid INTO v_last_match_id FROM matches
    WHERE competition_id = p_competition_id AND (home_league_team_id = v_league_team_id OR away_league_team_id = v_league_team_id)
      AND home_goals IS NOT NULL AND away_goals IS NOT NULL
    ORDER BY round_id DESC, match_date DESC, match_time DESC LIMIT 1;

    RETURN QUERY
    SELECT m.match_uuid AS match_id, m.round_id AS jornada, m.match_date, m.match_time,
           ht.nickname AS home_team_nickname, ht.display_name AS home_team_display_name,
           at.nickname AS away_team_nickname, at.display_name AS away_team_display_name,
           m.home_goals, m.away_goals, (m.home_league_team_id = v_league_team_id) AS is_home,
           CASE WHEN m.home_league_team_id = v_league_team_id THEN at.nickname ELSE ht.nickname END AS opponent_nickname,
           CASE WHEN m.home_league_team_id = v_league_team_id THEN at.display_name ELSE ht.display_name END AS opponent_display_name,
           CASE WHEN m.home_league_team_id = v_league_team_id THEN m.home_goals ELSE m.away_goals END AS team_goals,
           CASE WHEN m.home_league_team_id = v_league_team_id THEN m.away_goals ELSE m.home_goals END AS opponent_goals,
           CASE WHEN m.home_goals IS NULL OR m.away_goals IS NULL THEN NULL
                WHEN m.home_league_team_id = v_league_team_id THEN
                    CASE WHEN m.home_goals > m.away_goals THEN 'W' WHEN m.home_goals < m.away_goals THEN 'L' ELSE 'D' END
                ELSE
                    CASE WHEN m.away_goals > m.home_goals THEN 'W' WHEN m.away_goals < m.home_goals THEN 'L' ELSE 'D' END
           END AS result,
           (m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL) AS is_played,
           (m.match_uuid = v_next_match_id) AS is_next_match, (m.match_uuid = v_last_match_id) AS is_last_match,
           m.stream_url, COALESCE(m.resolved_administratively, false) AS resolved_administratively
    FROM matches m
    LEFT JOIN league_teams ht ON m.home_league_team_id = ht.id
    LEFT JOIN league_teams at ON m.away_league_team_id = at.id
    WHERE m.competition_id = p_competition_id AND (m.home_league_team_id = v_league_team_id OR m.away_league_team_id = v_league_team_id)
    ORDER BY m.round_id ASC, m.match_date ASC, m.match_time ASC;
END;
$function$;
`;
