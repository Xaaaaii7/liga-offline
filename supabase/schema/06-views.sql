-- Vistas de stats restantes (introspectadas 2026-07-07 vía pg_get_viewdef).
-- Estas son justo las que fallaban en el frontend durante el spike de la
-- Fase 0 (player_ratings_avg, team_stats_rankings, goleadores...).

CREATE VIEW goleadores AS
WITH goles_por_jugador AS (
  SELECT ge.player_id, m.competition_id, m.season, count(*) AS goles
  FROM goal_events ge
  JOIN matches m ON ge.match_uuid = m.match_uuid
  WHERE ge.event_type <> 'own_goal' AND ge.player_id IS NOT NULL
    AND (m.resolved_administratively IS NULL OR m.resolved_administratively = false)
  GROUP BY ge.player_id, m.competition_id, m.season
), partidos_por_jugador AS (
  SELECT participations.player_id, participations.competition_id, participations.season,
         count(DISTINCT participations.match_uuid) AS total_partidos
  FROM (
    SELECT DISTINCT mpr.player_id, mpr.competition_id, mpr.season, mpr.match_uuid
    FROM match_player_ratings mpr
    JOIN matches m ON mpr.match_uuid = m.match_uuid
    WHERE mpr.player_id IS NOT NULL AND mpr.rating IS NOT NULL
      AND (m.resolved_administratively IS NULL OR m.resolved_administratively = false)
    UNION
    SELECT DISTINCT ge.player_id, m.competition_id, m.season, ge.match_uuid
    FROM goal_events ge
    JOIN matches m ON ge.match_uuid = m.match_uuid
    WHERE ge.player_id IS NOT NULL AND ge.event_type = 'goal'
      AND (m.resolved_administratively IS NULL OR m.resolved_administratively = false)
  ) participations
  GROUP BY participations.player_id, participations.competition_id, participations.season
)
SELECT g.player_id, p.name AS jugador, ct.nickname AS manager,
       COALESCE(pp.total_partidos, 0) AS partidos, g.goles, g.season, g.competition_id
FROM goles_por_jugador g
JOIN players p ON g.player_id = p.id
LEFT JOIN LATERAL (
  SELECT lt.id AS league_team_id, lt.nickname
  FROM player_club_memberships pcm
  JOIN league_teams lt ON lt.club_id = pcm.club_id AND lt.competition_id = g.competition_id
  WHERE pcm.player_id = g.player_id AND pcm.season = g.season AND pcm.is_current = true
  LIMIT 1
) ct ON true
LEFT JOIN partidos_por_jugador pp ON pp.player_id = g.player_id AND pp.season = g.season AND pp.competition_id = g.competition_id
ORDER BY g.season DESC, g.goles DESC, COALESCE(pp.total_partidos, 0);

CREATE VIEW league_teams_by_competition AS
SELECT DISTINCT lt.id AS league_team_id, lt.nickname, lt.display_name, lt.club_id,
       lt.competition_id, lt.season, c.name AS club_name, c.crest_url AS club_crest
FROM league_teams lt
LEFT JOIN clubs c ON lt.club_id = c.id
WHERE lt.competition_id IS NOT NULL
ORDER BY lt.nickname, lt.display_name;

CREATE VIEW matches_resolved_administratively AS
SELECT id, match_uuid, season, round_id, round_type, cup_round, match_date, match_time,
       home_goals, away_goals, home_league_team_id, away_league_team_id, competition_id,
       resolved_administratively,
       CASE WHEN (EXISTS (SELECT 1 FROM match_team_stats mts WHERE mts.match_uuid = m.match_uuid))
            THEN false ELSE true END AS should_be_administrative
FROM matches m
WHERE home_goals IS NOT NULL AND away_goals IS NOT NULL
  AND NOT (EXISTS (SELECT 1 FROM match_team_stats mts WHERE mts.match_uuid = m.match_uuid));

CREATE VIEW team_goals_summary AS
SELECT league_team_id, competition_id, count(*) AS pj, sum(goles_a_favor) AS gf, sum(goles_en_contra) AS gc
FROM (
  SELECT home_league_team_id AS league_team_id, competition_id, home_goals AS goles_a_favor, away_goals AS goles_en_contra
  FROM matches
  WHERE home_goals IS NOT NULL AND away_goals IS NOT NULL AND home_league_team_id IS NOT NULL
    AND (resolved_administratively IS NULL OR resolved_administratively = false)
  UNION ALL
  SELECT away_league_team_id AS league_team_id, competition_id, away_goals AS goles_a_favor, home_goals AS goles_en_contra
  FROM matches
  WHERE home_goals IS NOT NULL AND away_goals IS NOT NULL AND away_league_team_id IS NOT NULL
    AND (resolved_administratively IS NULL OR resolved_administratively = false)
) team_matches
GROUP BY league_team_id, competition_id;

CREATE VIEW player_match_aggregate AS
WITH player_match_keys AS (
  SELECT DISTINCT player_id, match_uuid FROM match_player_ratings WHERE player_id IS NOT NULL
  UNION
  SELECT DISTINCT player_id, match_uuid FROM goal_events WHERE player_id IS NOT NULL AND event_type = 'goal'
  UNION
  SELECT DISTINCT player_id, match_uuid FROM match_yellow_cards WHERE player_id IS NOT NULL
  UNION
  SELECT DISTINCT player_id, match_uuid FROM match_red_cards WHERE player_id IS NOT NULL
), ratings_agg AS (
  SELECT player_id, match_uuid, rating, league_team_id FROM match_player_ratings WHERE player_id IS NOT NULL
), goals_agg AS (
  SELECT player_id, match_uuid, count(*)::integer AS goals, (array_agg(league_team_id))[1] AS league_team_id
  FROM goal_events WHERE player_id IS NOT NULL AND event_type = 'goal' GROUP BY player_id, match_uuid
), yellows_agg AS (
  SELECT player_id, match_uuid, count(*)::integer AS yellows, (array_agg(league_team_id))[1] AS league_team_id
  FROM match_yellow_cards WHERE player_id IS NOT NULL GROUP BY player_id, match_uuid
), reds_agg AS (
  SELECT player_id, match_uuid, count(*)::integer AS reds, (array_agg(league_team_id))[1] AS league_team_id
  FROM match_red_cards WHERE player_id IS NOT NULL GROUP BY player_id, match_uuid
)
SELECT pmk.player_id, pmk.match_uuid, m.id AS match_id, m.round_id AS jornada, m.competition_id, m.season,
       m.match_date, m.home_league_team_id, m.away_league_team_id, m.home_goals, m.away_goals,
       COALESCE(r.league_team_id::bigint, g.league_team_id::bigint, y.league_team_id::bigint, rc.league_team_id) AS league_team_id,
       lt.club_id, c.is_official, c.competition_type, c.slug AS competition_slug, c.name AS competition_name,
       r.rating, COALESCE(g.goals, 0) AS goals, COALESCE(y.yellows, 0) AS yellows, COALESCE(rc.reds, 0) AS reds,
       CASE WHEN COALESCE(r.league_team_id::bigint, g.league_team_id::bigint, y.league_team_id::bigint, rc.league_team_id) = m.home_league_team_id THEN m.home_goals
            WHEN COALESCE(r.league_team_id::bigint, g.league_team_id::bigint, y.league_team_id::bigint, rc.league_team_id) = m.away_league_team_id THEN m.away_goals
            ELSE NULL END AS goals_for_team,
       CASE WHEN COALESCE(r.league_team_id::bigint, g.league_team_id::bigint, y.league_team_id::bigint, rc.league_team_id) = m.home_league_team_id THEN m.away_goals
            WHEN COALESCE(r.league_team_id::bigint, g.league_team_id::bigint, y.league_team_id::bigint, rc.league_team_id) = m.away_league_team_id THEN m.home_goals
            ELSE NULL END AS goals_conceded
FROM player_match_keys pmk
LEFT JOIN matches m ON m.match_uuid = pmk.match_uuid
LEFT JOIN ratings_agg r ON r.player_id = pmk.player_id AND r.match_uuid = pmk.match_uuid
LEFT JOIN goals_agg g ON g.player_id = pmk.player_id AND g.match_uuid = pmk.match_uuid
LEFT JOIN yellows_agg y ON y.player_id = pmk.player_id AND y.match_uuid = pmk.match_uuid
LEFT JOIN reds_agg rc ON rc.player_id = pmk.player_id AND rc.match_uuid = pmk.match_uuid
LEFT JOIN league_teams lt ON lt.id = COALESCE(r.league_team_id::bigint, g.league_team_id::bigint, y.league_team_id::bigint, rc.league_team_id)
LEFT JOIN competitions c ON c.id = m.competition_id;

CREATE VIEW player_ratings_avg AS
WITH comp_rating_stats AS (
  SELECT competition_id, season, avg(rating) AS mean_rating
  FROM match_player_ratings WHERE rating IS NOT NULL GROUP BY competition_id, season
), player_stats AS (
  SELECT mpr.player_id, p.name AS player_name, p.position, mpr.competition_id, mpr.season,
         count(*) AS matches_count, round(avg(mpr.rating), 2) AS avg_rating,
         min(mpr.rating) AS min_rating, max(mpr.rating) AS max_rating, sum(mpr.rating) AS total_rating_sum
  FROM match_player_ratings mpr JOIN players p ON mpr.player_id = p.id
  WHERE mpr.rating IS NOT NULL AND mpr.player_id IS NOT NULL
  GROUP BY mpr.player_id, p.name, p.position, mpr.competition_id, mpr.season
), player_stats_with_bayesian AS (
  SELECT ps.*, round((4.0 * COALESCE(crs.mean_rating, ps.avg_rating) + ps.matches_count * ps.avg_rating) / (4 + ps.matches_count), 2) AS bayesian_rating
  FROM player_stats ps
  LEFT JOIN comp_rating_stats crs ON crs.competition_id = ps.competition_id AND crs.season = ps.season
), player_team_info AS (
  SELECT DISTINCT ON (psb.player_id, psb.competition_id, psb.season)
         psb.player_id, psb.player_name, psb.position, psb.competition_id, psb.season,
         psb.matches_count, psb.avg_rating, psb.min_rating, psb.max_rating, psb.total_rating_sum, psb.bayesian_rating,
         pcm.club_id, c.name AS club_name, c.crest_url AS club_crest, lt.id AS league_team_id, lt.nickname AS team_nickname,
         comp.competition_type
  FROM player_stats_with_bayesian psb
  LEFT JOIN LATERAL (
    SELECT club_id FROM player_club_memberships
    WHERE player_id = psb.player_id AND season = psb.season AND is_current = true LIMIT 1
  ) pcm ON true
  LEFT JOIN clubs c ON pcm.club_id = c.id
  LEFT JOIN LATERAL (
    SELECT id, nickname FROM league_teams WHERE club_id = pcm.club_id AND competition_id = psb.competition_id LIMIT 1
  ) lt ON true
  LEFT JOIN competitions comp ON psb.competition_id = comp.id
  ORDER BY psb.player_id, psb.competition_id, psb.season, lt.id
)
SELECT player_id, player_name, position, competition_id, season, matches_count, avg_rating, min_rating,
       max_rating, total_rating_sum, bayesian_rating, club_id, club_name, club_crest, league_team_id,
       team_nickname, competition_type
FROM player_team_info
ORDER BY bayesian_rating DESC;

CREATE VIEW player_ratings_jornada AS
SELECT mpr.player_id, COALESCE(p.name, mpr.player_name) AS player_name, p.position, mpr.competition_id, mpr.season,
       m.round_id AS jornada, count(*) AS matches_count, round(avg(mpr.rating), 2) AS avg_rating,
       min(mpr.rating) AS min_rating, max(mpr.rating) AS max_rating, sum(mpr.rating) AS total_rating_sum,
       pcm.club_id, c.name AS club_name, c.crest_url AS club_crest, lt.id AS league_team_id, lt.nickname AS team_nickname
FROM match_player_ratings mpr
JOIN matches m ON mpr.match_uuid = m.match_uuid
LEFT JOIN players p ON mpr.player_id = p.id
LEFT JOIN LATERAL (
  SELECT club_id FROM player_club_memberships
  WHERE player_id = mpr.player_id AND season = mpr.season AND is_current = true LIMIT 1
) pcm ON true
LEFT JOIN clubs c ON pcm.club_id = c.id
LEFT JOIN league_teams lt ON lt.club_id = pcm.club_id AND lt.competition_id = mpr.competition_id
WHERE mpr.rating IS NOT NULL AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
  AND (m.resolved_administratively IS NULL OR m.resolved_administratively = false)
GROUP BY mpr.player_id, p.name, p.position, mpr.player_name, mpr.competition_id, mpr.season, m.round_id,
         pcm.club_id, c.name, c.crest_url, lt.id, lt.nickname
ORDER BY mpr.competition_id, mpr.season, m.round_id, round(avg(mpr.rating), 2) DESC;

CREATE VIEW team_stats_rankings AS
SELECT mts.league_team_id, mts.competition_id, m.season,
       count(DISTINCT CASE WHEN mts.possession IS NOT NULL OR mts.fouls IS NOT NULL OR mts.tackles IS NOT NULL
                            OR mts.passes IS NOT NULL OR mts.shots IS NOT NULL OR mts.goals IS NOT NULL OR mts.red_cards IS NOT NULL
                       THEN mts.match_uuid ELSE NULL END) AS pj,
       sum(CASE WHEN mts.possession IS NOT NULL THEN mts.possession / 100.0 ELSE NULL END) AS pos_sum,
       count(mts.possession) AS pos_count,
       sum(COALESCE(mts.fouls, 0)) AS faltas,
       sum(COALESCE(mts.tackles, 0)) AS entradas,
       sum(COALESCE(mts.passes, 0)) AS pases,
       sum(COALESCE(mts.passes_completed, 0)) AS completados,
       sum(COALESCE(mts.shots, 0)) AS tiros,
       sum(COALESCE(mts.shots_on_target, 0)) AS ta_puerta,
       sum(COALESCE(mts.goals, 0)) AS goles,
       sum(COALESCE(mts.red_cards, 0)) AS rojas,
       sum(COALESCE(rival_stats.goals, 0)) AS goles_encajados,
       sum(COALESCE(rival_stats.shots_on_target, 0)) AS tiros_rival,
       CASE WHEN count(mts.possession) > 0 THEN avg(mts.possession) / 100.0 ELSE NULL END AS posesion_media,
       CASE WHEN (sum(COALESCE(mts.fouls, 0)) + 5 * sum(COALESCE(mts.red_cards, 0)) + 1) > 0
            THEN (sum(COALESCE(mts.tackles, 0)) + 1)::numeric / (sum(COALESCE(mts.fouls, 0)) + 5 * sum(COALESCE(mts.red_cards, 0)) + 1)
            ELSE NULL END AS fair_play_ratio,
       sum(COALESCE(mts.tackles, 0)) - sum(COALESCE(mts.fouls, 0)) * 0.5 - sum(COALESCE(mts.red_cards, 0)) * 3 AS fair_play_index,
       CASE WHEN sum(COALESCE(mts.passes, 0)) > 0 THEN sum(COALESCE(mts.passes_completed, 0))::numeric / sum(COALESCE(mts.passes, 0)) ELSE NULL END AS precision_pase,
       CASE WHEN sum(COALESCE(mts.shots, 0)) > 0 THEN sum(COALESCE(mts.shots_on_target, 0))::numeric / sum(COALESCE(mts.shots, 0)) ELSE NULL END AS precision_tiro,
       CASE WHEN sum(COALESCE(mts.shots, 0)) > 0 THEN sum(COALESCE(mts.goals, 0))::numeric / sum(COALESCE(mts.shots, 0)) ELSE NULL END AS conversion_gol,
       CASE WHEN sum(COALESCE(mts.shots, 0)) > 0
            THEN (sum(COALESCE(mts.shots_on_target, 0))::numeric / sum(COALESCE(mts.shots, 0)) + sum(COALESCE(mts.goals, 0))::numeric / sum(COALESCE(mts.shots, 0))) / 2
            ELSE NULL END AS indice_tiro_combinado,
       CASE WHEN sum(COALESCE(rival_stats.shots_on_target, 0)) > 0 THEN sum(COALESCE(rival_stats.goals, 0))::numeric / sum(COALESCE(rival_stats.shots_on_target, 0)) ELSE NULL END AS efectividad_defensiva
FROM match_team_stats mts
JOIN matches m ON mts.match_uuid = m.match_uuid
LEFT JOIN match_team_stats rival_stats ON rival_stats.match_uuid = mts.match_uuid AND rival_stats.league_team_id <> mts.league_team_id
WHERE m.resolved_administratively IS NULL OR m.resolved_administratively = false
GROUP BY mts.league_team_id, mts.competition_id, m.season;

CREATE VIEW mvp_temporada AS
SELECT league_team_id, competition_id, season, count(DISTINCT jornada) AS jornadas,
       avg(mvp_score) AS mvp_avg, sum(mvp_score) AS mvp_sum
FROM mvp_jornada mj
GROUP BY league_team_id, competition_id, season;
