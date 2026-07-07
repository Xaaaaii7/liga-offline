// Mapeos de presentación para noticias generadas por el news-writer.
// Mantener sincronizado con `lambdas/news-writer/persist.mjs` (SECTION_BY_VOICE)
// y con `lambdas/news-writer/candidates.mjs` (kinds).

export const SECTION_BY_VOICE = {
    datero: 'Sección de datos',
    tabloide: 'Sección de polémica',
    epico: 'Crónica',
    cinico: 'Columna',
    veterano: 'Memoria de la liga',
    becario: 'Cantera',
    provocador: 'Tribuna',
    duro: 'El azote',
};

// Cada tipo de ángulo se agrupa en una "familia" que le da color al badge,
// para que el lector escanee el feed por tipo de un vistazo. Las familias y
// sus colores viven en css/noticias.css (.news-badge--<family>).
//   goals  -> verde (goles/rendimiento)   discipline -> rojo (tarjetas/sanción)
//   award  -> dorado (premios/títulos)     data       -> azul (estadística/ELO)
//   misc   -> neutro (curiosidad/lesión/veredicto)
export const ANGLE_LABELS = {
    hat_trick: { emoji: '⚽', label: 'Triplete', family: 'goals' },
    high_rating: { emoji: '⭐', label: 'Rendimiento', family: 'goals' },
    elo_swing: { emoji: '📊', label: 'ELO', family: 'data' },
    red_card: { emoji: '🟥', label: 'Roja', family: 'discipline' },
    curiosity: { emoji: '💡', label: 'Curiosidad', family: 'misc' },
    monthly_award_player: { emoji: '📅', label: 'Jugador del mes', family: 'award' },
    monthly_award_coach: { emoji: '📅', label: 'Manager del mes', family: 'award' },
    champion_crowned: { emoji: '🏆', label: 'Campeón', family: 'award' },
    season_top_scorer: { emoji: '🥇', label: 'Pichichi', family: 'award' },
    season_mvp: { emoji: '🌟', label: 'MVP de temporada', family: 'award' },
    season_golden_boy: { emoji: '🌱', label: 'Golden Boy', family: 'award' },
    best_player_jornada: { emoji: '🎖️', label: 'MVP de jornada', family: 'award' },
    mvp_jornada_team: { emoji: '📈', label: 'Equipo de la jornada', family: 'data' },
    suspension: { emoji: '🚫', label: 'Sanción', family: 'discipline' },
    injury: { emoji: '🤕', label: 'Lesión', family: 'misc' },
    stance_resolution: { emoji: '🎯', label: 'Veredicto', family: 'misc' },
};

export function getSection(voice) {
    return SECTION_BY_VOICE[voice] ?? null;
}

export function getAngleBadge(kind) {
    return ANGLE_LABELS[kind] ?? null;
}
