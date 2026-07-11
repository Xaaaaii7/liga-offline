-- Utilidades generales de liga (introspectado 2026-07-07). Incluye la lógica
-- de integridad de partidos (resolved_administratively, sync de goles a
-- match_team_stats, ratings sintéticas para goleadores sin OCR) y las
-- funciones de consulta (standings hasta jornada, forma de equipo, pichichi).
--
-- set_active_season y delete_competition_cascade se portan SIN el check de
-- auth.uid()/profiles.is_super_admin del original: en una instalación local
-- de un solo jugador no hay multi-usuario que autorizar.

-- ── Integridad de partidos ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_matches_updated_at() RETURNS trigger LANGUAGE plpgsql AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$;
CREATE TRIGGER trg_set_matches_updated_at BEFORE UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION set_matches_updated_at();

CREATE OR REPLACE FUNCTION trigger_check_resolved_administratively() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
    IF NEW.home_goals IS NOT NULL AND NEW.away_goals IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM match_team_stats mts WHERE mts.match_uuid = NEW.match_uuid) THEN
            NEW.resolved_administratively = TRUE;
        ELSE
            NEW.resolved_administratively = FALSE;
        END IF;
    ELSE
        NEW.resolved_administratively = FALSE;
    END IF;
    RETURN NEW;
END;
$function$;
CREATE TRIGGER trigger_matches_check_administrative BEFORE INSERT OR UPDATE OF home_goals, away_goals ON matches
  FOR EACH ROW EXECUTE FUNCTION trigger_check_resolved_administratively();

CREATE OR REPLACE FUNCTION sync_match_team_stats_on_result() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.home_goals IS NULL OR NEW.away_goals IS NULL THEN RETURN NEW; END IF;
  IF NEW.resolved_administratively = true THEN RETURN NEW; END IF;
  IF NEW.home_league_team_id IS NULL OR NEW.away_league_team_id IS NULL OR NEW.competition_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.match_uuid IS NULL THEN RETURN NEW; END IF;

  INSERT INTO match_team_stats (match_id, match_uuid, league_team_id, competition_id, goals, season)
  VALUES (NEW.id, NEW.match_uuid, NEW.home_league_team_id, NEW.competition_id, NEW.home_goals, NEW.season)
  ON CONFLICT (match_id, league_team_id)
  DO UPDATE SET goals = EXCLUDED.goals, match_uuid = EXCLUDED.match_uuid, competition_id = EXCLUDED.competition_id, season = EXCLUDED.season;

  INSERT INTO match_team_stats (match_id, match_uuid, league_team_id, competition_id, goals, season)
  VALUES (NEW.id, NEW.match_uuid, NEW.away_league_team_id, NEW.competition_id, NEW.away_goals, NEW.season)
  ON CONFLICT (match_id, league_team_id)
  DO UPDATE SET goals = EXCLUDED.goals, match_uuid = EXCLUDED.match_uuid, competition_id = EXCLUDED.competition_id, season = EXCLUDED.season;

  RETURN NEW;
END;
$function$;
CREATE TRIGGER trigger_sync_match_team_stats_on_result AFTER UPDATE ON matches FOR EACH ROW EXECUTE FUNCTION sync_match_team_stats_on_result();

-- ── Ratings sintéticas para goleadores sin rating OCR ───────────────────
-- (ver memoria del proyecto: "Ratings sin player_id" — este es justo el
-- mecanismo que evita jugadores fantasma en los rankings).
CREATE OR REPLACE FUNCTION compute_synthetic_goal_rating(p_goals integer)
 RETURNS numeric LANGUAGE plpgsql IMMUTABLE AS $function$
BEGIN
  IF p_goals IS NULL OR p_goals <= 0 THEN RETURN NULL;
  ELSIF p_goals = 1 THEN RETURN 7.0;
  ELSIF p_goals = 2 THEN RETURN 8.0;
  ELSE RETURN 8.5;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION recompute_synthetic_rating(p_match_uuid integer, p_player_id bigint)
 RETURNS void LANGUAGE plpgsql AS $function$
DECLARE
  v_goal_count integer; v_match_id text; v_competition_id integer; v_season text;
  v_league_team_id integer; v_player_name text; v_rating numeric; v_has_real boolean;
BEGIN
  IF p_match_uuid IS NULL OR p_player_id IS NULL THEN RETURN; END IF;

  SELECT COUNT(*) INTO v_goal_count FROM goal_events ge
  WHERE ge.match_uuid = p_match_uuid AND ge.player_id = p_player_id AND ge.event_type <> 'own_goal';

  SELECT m.id::text, m.competition_id, m.season INTO v_match_id, v_competition_id, v_season
  FROM matches m WHERE m.match_uuid = p_match_uuid LIMIT 1;

  SELECT name INTO v_player_name FROM players WHERE id = p_player_id;
  IF v_player_name IS NULL THEN RETURN; END IF;

  SELECT ge.league_team_id INTO v_league_team_id FROM goal_events ge
  WHERE ge.match_uuid = p_match_uuid AND ge.player_id = p_player_id AND ge.event_type <> 'own_goal'
  ORDER BY ge.id ASC LIMIT 1;

  IF v_goal_count = 0 THEN
    DELETE FROM match_player_ratings r WHERE r.match_uuid = p_match_uuid AND r.player_id = p_player_id AND r.is_synthetic = true;
    RETURN;
  END IF;

  IF v_league_team_id IS NULL THEN RETURN; END IF;

  SELECT bool_or(NOT r.is_synthetic) INTO v_has_real FROM match_player_ratings r
  WHERE r.match_uuid = p_match_uuid AND r.league_team_id = v_league_team_id
    AND (r.player_id = p_player_id OR r.player_name = v_player_name);

  IF COALESCE(v_has_real, false) THEN
    DELETE FROM match_player_ratings r WHERE r.match_uuid = p_match_uuid AND r.player_id = p_player_id AND r.is_synthetic = true;
    RETURN;
  END IF;

  v_rating := compute_synthetic_goal_rating(v_goal_count);

  INSERT INTO match_player_ratings (match_uuid, match_id, league_team_id, competition_id, season, player_id, player_name, rating, is_synthetic)
  VALUES (p_match_uuid, v_match_id, v_league_team_id, v_competition_id, v_season, p_player_id, v_player_name, v_rating, true)
  ON CONFLICT (match_uuid, league_team_id, player_name)
  DO UPDATE SET rating = EXCLUDED.rating, player_id = EXCLUDED.player_id, is_synthetic = true
  WHERE match_player_ratings.is_synthetic = true;
END;
$function$;

CREATE OR REPLACE FUNCTION trigger_sync_synthetic_rating() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM recompute_synthetic_rating(OLD.match_uuid, OLD.player_id);
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.match_uuid IS DISTINCT FROM NEW.match_uuid OR OLD.player_id IS DISTINCT FROM NEW.player_id) THEN
    PERFORM recompute_synthetic_rating(OLD.match_uuid, OLD.player_id);
  END IF;

  PERFORM recompute_synthetic_rating(NEW.match_uuid, NEW.player_id);
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trigger_goal_events_synthetic_rating AFTER INSERT OR DELETE OR UPDATE ON goal_events FOR EACH ROW EXECUTE FUNCTION trigger_sync_synthetic_rating();

CREATE OR REPLACE FUNCTION cleanup_stale_synthetic_rating() RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.is_synthetic = false AND NEW.player_id IS NOT NULL THEN
    DELETE FROM match_player_ratings r
    WHERE r.match_uuid = NEW.match_uuid AND r.player_id = NEW.player_id AND r.is_synthetic = true AND r.id <> NEW.id;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trigger_cleanup_stale_synthetic_rating AFTER INSERT OR UPDATE ON match_player_ratings
  FOR EACH ROW WHEN (NEW.is_synthetic = false) EXECUTE FUNCTION cleanup_stale_synthetic_rating();

-- ── Consultas de stats ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION get_league_standings_until_jornada(p_competition_id integer, p_jornada integer)
 RETURNS TABLE(league_team_id integer, competition_id integer, season text, jornada_max integer, pj bigint, g bigint, e bigint, p bigint, gf bigint, gc bigint, goal_difference bigint, pts_raw numeric, penalty_points integer, pts numeric)
 LANGUAGE plpgsql AS $function$
BEGIN
    RETURN QUERY
    WITH team_matches AS (
        SELECT m.home_league_team_id AS league_team_id, m.competition_id, c.season, m.round_id, m.id AS match_id,
               m.home_goals AS goals_for, m.away_goals AS goals_against,
               CASE WHEN m.home_goals > m.away_goals THEN 1 WHEN m.home_goals = m.away_goals THEN 0 ELSE -1 END AS result,
               COALESCE((c.type_config->>'points_win')::INTEGER, 3) AS points_win,
               COALESCE((c.type_config->>'points_draw')::INTEGER, 1) AS points_draw,
               COALESCE((c.type_config->>'points_loss')::INTEGER, 0) AS points_loss
        FROM matches m INNER JOIN competitions c ON m.competition_id = c.id
        WHERE c.competition_type = 'league' AND m.competition_id = p_competition_id AND m.round_id <= p_jornada
          AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
          AND (m.round_type IS NULL OR m.round_type = 'league') AND m.home_league_team_id IS NOT NULL
        UNION ALL
        SELECT m.away_league_team_id AS league_team_id, m.competition_id, c.season, m.round_id, m.id AS match_id,
               m.away_goals AS goals_for, m.home_goals AS goals_against,
               CASE WHEN m.away_goals > m.home_goals THEN 1 WHEN m.away_goals = m.home_goals THEN 0 ELSE -1 END AS result,
               COALESCE((c.type_config->>'points_win')::INTEGER, 3) AS points_win,
               COALESCE((c.type_config->>'points_draw')::INTEGER, 1) AS points_draw,
               COALESCE((c.type_config->>'points_loss')::INTEGER, 0) AS points_loss
        FROM matches m INNER JOIN competitions c ON m.competition_id = c.id
        WHERE c.competition_type = 'league' AND m.competition_id = p_competition_id AND m.round_id <= p_jornada
          AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
          AND (m.round_type IS NULL OR m.round_type = 'league') AND m.away_league_team_id IS NOT NULL
    )
    SELECT tm.league_team_id, tm.competition_id, tm.season, MAX(tm.round_id) AS jornada_max,
           COUNT(DISTINCT tm.match_id) AS pj,
           SUM(CASE WHEN tm.result = 1 THEN 1 ELSE 0 END)::BIGINT AS g,
           SUM(CASE WHEN tm.result = 0 THEN 1 ELSE 0 END)::BIGINT AS e,
           SUM(CASE WHEN tm.result = -1 THEN 1 ELSE 0 END)::BIGINT AS p,
           SUM(COALESCE(tm.goals_for, 0))::BIGINT AS gf,
           SUM(COALESCE(tm.goals_against, 0))::BIGINT AS gc,
           (SUM(COALESCE(tm.goals_for, 0)) - SUM(COALESCE(tm.goals_against, 0)))::BIGINT AS goal_difference,
           SUM(CASE WHEN tm.result = 1 THEN tm.points_win WHEN tm.result = 0 THEN tm.points_draw ELSE tm.points_loss END)::NUMERIC AS pts_raw,
           COALESCE(lt.penalty_points, 0) AS penalty_points,
           GREATEST(SUM(CASE WHEN tm.result = 1 THEN tm.points_win WHEN tm.result = 0 THEN tm.points_draw ELSE tm.points_loss END)::NUMERIC - COALESCE(lt.penalty_points, 0), 0)::NUMERIC AS pts
    FROM team_matches tm
    LEFT JOIN league_teams lt ON tm.league_team_id = lt.id
    GROUP BY tm.league_team_id, tm.competition_id, tm.season, lt.penalty_points;
END;
$function$;

CREATE OR REPLACE FUNCTION get_team_form(p_competition_id integer, p_team_nickname text, p_last_n_matches integer DEFAULT 3)
 RETURNS TABLE(wins integer, draws integer, losses integer, form_results text[], form_rating text, matches_count integer)
 LANGUAGE plpgsql AS $function$
DECLARE
    v_league_team_id INTEGER; v_matches RECORD;
    v_wins INTEGER := 0; v_draws INTEGER := 0; v_losses INTEGER := 0;
    v_results TEXT[] := ARRAY[]::TEXT[]; v_rating TEXT;
BEGIN
    SELECT id INTO v_league_team_id FROM league_teams
    WHERE competition_id = p_competition_id AND (nickname ILIKE p_team_nickname OR display_name ILIKE p_team_nickname) LIMIT 1;
    IF v_league_team_id IS NULL THEN RETURN; END IF;

    FOR v_matches IN
        SELECT m.id, m.home_goals, m.away_goals, (m.home_league_team_id = v_league_team_id) AS is_home
        FROM matches m
        WHERE m.competition_id = p_competition_id
          AND (m.home_league_team_id = v_league_team_id OR m.away_league_team_id = v_league_team_id)
          AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
        ORDER BY m.round_id DESC, m.match_date DESC, m.match_time DESC LIMIT p_last_n_matches
    LOOP
        DECLARE v_result TEXT;
        BEGIN
            IF v_matches.is_home THEN
                IF v_matches.home_goals > v_matches.away_goals THEN v_result := 'W'; v_wins := v_wins + 1;
                ELSIF v_matches.home_goals < v_matches.away_goals THEN v_result := 'L'; v_losses := v_losses + 1;
                ELSE v_result := 'D'; v_draws := v_draws + 1;
                END IF;
            ELSE
                IF v_matches.away_goals > v_matches.home_goals THEN v_result := 'W'; v_wins := v_wins + 1;
                ELSIF v_matches.away_goals < v_matches.home_goals THEN v_result := 'L'; v_losses := v_losses + 1;
                ELSE v_result := 'D'; v_draws := v_draws + 1;
                END IF;
            END IF;
            v_results := ARRAY_APPEND(v_results, v_result);
        END;
    END LOOP;

    DECLARE v_count INTEGER := array_length(v_results, 1);
    BEGIN
        IF v_count IS NULL OR v_count < 3 THEN v_rating := 'NO DATA';
        ELSIF v_wins = 3 THEN v_rating := '🔥 ON FIRE';
        ELSIF v_wins = 2 THEN v_rating := '🟩 STRONG';
        ELSIF v_wins = 1 AND v_losses = 0 THEN v_rating := '🟨 SOLID';
        ELSIF v_draws = 3 THEN v_rating := '⚪ STEADY';
        ELSIF v_wins = 0 AND v_losses = 1 THEN v_rating := '🟧 SHAKY';
        ELSIF v_losses = 2 THEN v_rating := '🟥 BAD MOMENT';
        ELSIF v_losses = 3 THEN v_rating := '❄️ COLD';
        ELSE v_rating := '🟨 SOLID';
        END IF;
        RETURN QUERY SELECT v_wins, v_draws, v_losses, v_results, v_rating, COALESCE(v_count, 0);
    END;
END;
$function$;

CREATE OR REPLACE FUNCTION get_team_matches(p_competition_id integer, p_team_nickname text)
 RETURNS TABLE(match_id integer, jornada integer, match_date date, match_time time without time zone, home_team_nickname text, home_team_display_name text, away_team_nickname text, away_team_display_name text, home_goals integer, away_goals integer, is_home boolean, opponent_nickname text, opponent_display_name text, team_goals integer, opponent_goals integer, result text, is_played boolean, is_next_match boolean, is_last_match boolean, stream_url text, resolved_administratively boolean)
 LANGUAGE plpgsql AS $function$
-- Las columnas OUT (home_goals, away_goals, match_date, match_time) chocan con
-- las columnas homónimas de `matches` en los SELECT…INTO de abajo; que gane
-- SIEMPRE la columna (si no, PGlite lanza "column reference … is ambiguous").
#variable_conflict use_column
DECLARE
    v_league_team_id INTEGER; v_next_match_id INTEGER; v_last_match_id INTEGER;
BEGIN
    SELECT id INTO v_league_team_id FROM league_teams
    WHERE competition_id = p_competition_id AND (nickname ILIKE p_team_nickname OR display_name ILIKE p_team_nickname) LIMIT 1;
    IF v_league_team_id IS NULL THEN RETURN; END IF;

    -- matches.id es TEXTO ("J1-P2"); el entero es match_uuid. Usar match_uuid
    -- para casar con v_next/last_match_id (INTEGER) y el OUT match_id.
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

CREATE OR REPLACE FUNCTION get_teams_form_top(p_competition_id integer, p_limit integer DEFAULT 3)
 RETURNS TABLE(league_team_id integer, team_name text, avg_score numeric, pj_total bigint, last_jornada integer)
 LANGUAGE plpgsql AS $function$
BEGIN
    RETURN QUERY
    WITH team_mvp_history AS (
        SELECT mj.league_team_id, mj.jornada, mj.mvp_score,
               (SELECT COUNT(DISTINCT m.id)::BIGINT FROM matches m
                WHERE ((m.home_league_team_id = mj.league_team_id AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL)
                       OR (m.away_league_team_id = mj.league_team_id AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL))
                  AND m.competition_id = p_competition_id AND m.round_id = mj.jornada
                  AND (m.round_type IS NULL OR m.round_type = 'league')) AS pj
        FROM mvp_jornada mj WHERE mj.competition_id = p_competition_id ORDER BY mj.league_team_id, mj.jornada ASC
    ),
    team_last_3 AS (
        SELECT tmh.league_team_id, tmh.jornada, tmh.mvp_score, tmh.pj,
               ROW_NUMBER() OVER (PARTITION BY tmh.league_team_id ORDER BY tmh.jornada DESC) AS rn
        FROM team_mvp_history tmh
    ),
    team_aggregated AS (
        SELECT t3.league_team_id, COUNT(*) AS n, AVG(t3.mvp_score) AS avg_score, SUM(t3.pj)::BIGINT AS pj_total, MAX(t3.jornada) AS last_jornada
        FROM team_last_3 t3 WHERE t3.rn <= 3 GROUP BY t3.league_team_id
    ),
    team_names AS (
        SELECT ta.league_team_id, ta.avg_score, ta.pj_total, ta.last_jornada,
               COALESCE(lt.nickname, lt.display_name, 'Equipo ' || ta.league_team_id::TEXT) AS team_name
        FROM team_aggregated ta INNER JOIN league_teams lt ON ta.league_team_id = lt.id WHERE lt.competition_id = p_competition_id
    )
    SELECT tn.league_team_id, tn.team_name, tn.avg_score, tn.pj_total, tn.last_jornada
    FROM team_names tn ORDER BY tn.avg_score DESC, tn.pj_total DESC, tn.last_jornada DESC, tn.team_name ASC LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION get_pichichi_ordered(p_competition_id integer, p_limit integer DEFAULT 1000)
 RETURNS TABLE(player_id bigint, jugador text, manager text, partidos bigint, goles bigint, goles_por_partido numeric)
 LANGUAGE plpgsql AS $function$
BEGIN
    RETURN QUERY
    SELECT g.player_id, g.jugador, g.manager, g.partidos, g.goles,
           CASE WHEN g.partidos > 0 THEN (g.goles::NUMERIC / g.partidos::NUMERIC) ELSE 0::NUMERIC END AS goles_por_partido
    FROM goleadores g
    WHERE g.competition_id = p_competition_id AND g.partidos > 0 AND g.goles > 0
    ORDER BY g.goles DESC, CASE WHEN g.partidos > 0 THEN (g.goles::NUMERIC / g.partidos::NUMERIC) ELSE 0 END DESC, g.jugador ASC
    LIMIT p_limit;
END;
$function$;

CREATE OR REPLACE FUNCTION get_goleador_momento(p_competition_id integer, p_jornadas integer DEFAULT 3)
 RETURNS TABLE(player_id bigint, player_name text, team_name text, goles bigint, partidos_tramo bigint, jornadas integer[])
 LANGUAGE plpgsql AS $function$
DECLARE v_last_jornada INTEGER; v_start_jornada INTEGER; v_jornadas_array INTEGER[];
BEGIN
    SELECT MAX(m.round_id) INTO v_last_jornada FROM matches m
    WHERE m.competition_id = p_competition_id AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
      AND (m.round_type IS NULL OR m.round_type = 'league') AND (m.resolved_administratively IS NULL OR m.resolved_administratively = false);
    IF v_last_jornada IS NULL THEN RETURN; END IF;

    v_start_jornada := GREATEST(1, v_last_jornada - (p_jornadas - 1));
    SELECT ARRAY_AGG(jornada ORDER BY jornada) INTO v_jornadas_array FROM generate_series(v_start_jornada, v_last_jornada) AS jornada;

    RETURN QUERY
    WITH jornadas_seleccionadas AS (SELECT unnest(v_jornadas_array) AS jornada_num),
    partidos_jornadas AS (
        SELECT DISTINCT m.match_uuid FROM matches m
        INNER JOIN jornadas_seleccionadas js ON m.round_id = js.jornada_num
        WHERE m.competition_id = p_competition_id AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
          AND (m.round_type IS NULL OR m.round_type = 'league') AND (m.resolved_administratively IS NULL OR m.resolved_administratively = false)
    ),
    goles_con_equipo AS (
        SELECT ge.player_id, ge.league_team_id, COUNT(*)::BIGINT AS goles, COUNT(DISTINCT ge.match_uuid)::BIGINT AS partidos_tramo
        FROM goal_events ge INNER JOIN partidos_jornadas pj ON ge.match_uuid = pj.match_uuid
        WHERE ge.event_type = 'goal' AND ge.player_id IS NOT NULL GROUP BY ge.player_id, ge.league_team_id
    ),
    goles_agregados AS (
        SELECT gce.player_id, SUM(gce.goles)::BIGINT AS goles, SUM(gce.partidos_tramo)::BIGINT AS partidos_tramo,
               (SELECT gce2.league_team_id FROM goles_con_equipo gce2 WHERE gce2.player_id = gce.player_id
                ORDER BY gce2.goles DESC, gce2.league_team_id DESC LIMIT 1) AS league_team_id
        FROM goles_con_equipo gce GROUP BY gce.player_id
    ),
    jugadores_info AS (
        SELECT gaj.player_id AS player_id_val, p.name AS player_name,
               COALESCE(lt.nickname, lt.display_name, 'Equipo ' || gaj.league_team_id::TEXT) AS team_name,
               gaj.goles, gaj.partidos_tramo
        FROM goles_agregados gaj INNER JOIN players p ON gaj.player_id = p.id
        LEFT JOIN league_teams lt ON gaj.league_team_id = lt.id AND lt.competition_id = p_competition_id
    )
    SELECT ji.player_id_val AS player_id, ji.player_name, COALESCE(ji.team_name, 'Equipo desconocido') AS team_name,
           ji.goles, ji.partidos_tramo, v_jornadas_array AS jornadas
    FROM jugadores_info ji ORDER BY ji.goles DESC, ji.partidos_tramo ASC, ji.player_name ASC LIMIT 5;
END;
$function$;

CREATE OR REPLACE FUNCTION get_competition_format(comp_id integer)
 RETURNS text LANGUAGE plpgsql STABLE AS $function$
DECLARE comp_type competition_type_enum; config JSONB;
BEGIN
    SELECT competition_type, type_config INTO comp_type, config FROM competitions WHERE id = comp_id;
    IF comp_type = 'league' THEN RETURN config->>'format';
    ELSIF comp_type = 'cup' THEN RETURN config->>'format';
    ELSIF comp_type = 'mixed' THEN RETURN config->>'group_phase_format';
    END IF;
    RETURN NULL;
END;
$function$;

-- ── Administración de temporadas/competiciones (sin gate de auth) ───────
CREATE OR REPLACE FUNCTION set_active_season(p_season_id bigint)
 RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
    UPDATE seasons SET is_active = false WHERE is_active = true;
    UPDATE seasons SET is_active = true WHERE id = p_season_id;
END;
$function$;

CREATE OR REPLACE FUNCTION safe_delete_by_competition_id(table_name text, comp_id integer, where_clause text DEFAULT 'competition_id'::text)
 RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
    EXECUTE format('DELETE FROM %I WHERE %I = %s', table_name, where_clause, comp_id);
END;
$function$;

CREATE OR REPLACE FUNCTION delete_competition_cascade(comp_id integer)
 RETURNS void LANGUAGE plpgsql AS $function$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM competitions WHERE id = comp_id) THEN
        RAISE EXCEPTION 'La competición no existe';
    END IF;

    UPDATE matches SET penalties_winner_id = NULL WHERE competition_id = comp_id AND penalties_winner_id IS NOT NULL;

    DELETE FROM player_suspensions WHERE match_uuid IN (SELECT match_uuid FROM matches WHERE competition_id = comp_id)
      OR origin_match_uuid IN (SELECT match_uuid FROM matches WHERE competition_id = comp_id);
    DELETE FROM match_red_cards WHERE match_uuid IN (SELECT match_uuid FROM matches WHERE competition_id = comp_id);
    DELETE FROM match_yellow_cards WHERE match_uuid IN (SELECT match_uuid FROM matches WHERE competition_id = comp_id);
    DELETE FROM match_injuries WHERE match_uuid IN (SELECT match_uuid FROM matches WHERE competition_id = comp_id);
    DELETE FROM goal_events WHERE match_uuid IN (SELECT match_uuid FROM matches WHERE competition_id = comp_id);
    DELETE FROM match_team_stats WHERE match_uuid IN (SELECT match_uuid FROM matches WHERE competition_id = comp_id);
    DELETE FROM mvp_jornada WHERE competition_id = comp_id;
    DELETE FROM best_xi_jornada WHERE competition_id = comp_id;
    DELETE FROM best_player_jornada WHERE competition_id = comp_id;
    DELETE FROM monthly_awards WHERE competition_id = comp_id;

    PERFORM safe_delete_by_competition_id('matches', comp_id);
    PERFORM safe_delete_by_competition_id('formations', comp_id);
    PERFORM safe_delete_by_competition_id('league_teams', comp_id);

    DELETE FROM competitions WHERE id = comp_id;
END;
$function$;
