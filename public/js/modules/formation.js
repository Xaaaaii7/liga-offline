import { getSupabaseClient, getSupabaseConfig } from './supabase-client.js';
import { TABLES_WITH_COMPETITION_ID } from './db-helpers.js';

// ==========================
//  PLANTILLAS DE SISTEMAS
// ==========================
export const FORMATION_TEMPLATES = {
    "4-4-2": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 20, y: 72 },
        { index: 2, line: "DEF", x: 40, y: 75 },
        { index: 3, line: "DEF", x: 60, y: 75 },
        { index: 4, line: "DEF", x: 80, y: 72 },
        { index: 5, line: "MC", x: 25, y: 55 },
        { index: 6, line: "MC", x: 45, y: 50 },
        { index: 7, line: "MC", x: 65, y: 50 },
        { index: 8, line: "MC", x: 75, y: 55 },
        { index: 9, line: "DEL", x: 40, y: 30 },
        { index: 10, line: "DEL", x: 60, y: 30 }
    ],
    "4-3-3": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 20, y: 72 },
        { index: 2, line: "DEF", x: 40, y: 75 },
        { index: 3, line: "DEF", x: 60, y: 75 },
        { index: 4, line: "DEF", x: 80, y: 72 },
        { index: 5, line: "MC", x: 30, y: 55 },
        { index: 6, line: "MC", x: 50, y: 50 },
        { index: 7, line: "MC", x: 70, y: 55 },
        { index: 8, line: "DEL", x: 25, y: 30 },
        { index: 9, line: "DEL", x: 50, y: 25 },
        { index: 10, line: "DEL", x: 75, y: 30 }
    ],
    "4-5-1": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 20, y: 72 },
        { index: 2, line: "DEF", x: 40, y: 75 },
        { index: 3, line: "DEF", x: 60, y: 75 },
        { index: 4, line: "DEF", x: 80, y: 72 },
        { index: 5, line: "MC", x: 20, y: 55 },
        { index: 6, line: "MC", x: 35, y: 50 },
        { index: 7, line: "MC", x: 50, y: 45 },
        { index: 8, line: "MC", x: 65, y: 50 },
        { index: 9, line: "MC", x: 80, y: 55 },
        { index: 10, line: "DEL", x: 50, y: 25 }
    ],
    "3-5-2": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 30, y: 75 },
        { index: 2, line: "DEF", x: 50, y: 72 },
        { index: 3, line: "DEF", x: 70, y: 75 },
        { index: 4, line: "MC", x: 20, y: 55 },
        { index: 5, line: "MC", x: 35, y: 50 },
        { index: 6, line: "MC", x: 50, y: 45 },
        { index: 7, line: "MC", x: 65, y: 50 },
        { index: 8, line: "MC", x: 80, y: 55 },
        { index: 9, line: "DEL", x: 40, y: 30 },
        { index: 10, line: "DEL", x: 60, y: 30 }
    ],
    "4-2-3-1": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 20, y: 72 },
        { index: 2, line: "DEF", x: 40, y: 75 },
        { index: 3, line: "DEF", x: 60, y: 75 },
        { index: 4, line: "DEF", x: 80, y: 72 },
        { index: 5, line: "MC", x: 38, y: 60 },
        { index: 6, line: "MC", x: 62, y: 60 },
        { index: 7, line: "MC", x: 25, y: 42 },
        { index: 8, line: "MC", x: 50, y: 40 },
        { index: 9, line: "MC", x: 75, y: 42 },
        { index: 10, line: "DEL", x: 50, y: 25 }
    ],
    "3-4-3": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 28, y: 74 },
        { index: 2, line: "DEF", x: 50, y: 72 },
        { index: 3, line: "DEF", x: 72, y: 74 },
        { index: 4, line: "MC", x: 20, y: 52 },
        { index: 5, line: "MC", x: 40, y: 50 },
        { index: 6, line: "MC", x: 60, y: 50 },
        { index: 7, line: "MC", x: 80, y: 52 },
        { index: 8, line: "DEL", x: 25, y: 28 },
        { index: 9, line: "DEL", x: 50, y: 25 },
        { index: 10, line: "DEL", x: 75, y: 28 }
    ],
    "4-1-4-1": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 20, y: 72 },
        { index: 2, line: "DEF", x: 40, y: 75 },
        { index: 3, line: "DEF", x: 60, y: 75 },
        { index: 4, line: "DEF", x: 80, y: 72 },
        { index: 5, line: "MC", x: 50, y: 60 },
        { index: 6, line: "MC", x: 20, y: 45 },
        { index: 7, line: "MC", x: 40, y: 43 },
        { index: 8, line: "MC", x: 60, y: 43 },
        { index: 9, line: "MC", x: 80, y: 45 },
        { index: 10, line: "DEL", x: 50, y: 25 }
    ],
    "5-3-2": [
        { index: 0, line: "POR", x: 50, y: 90 },
        { index: 1, line: "DEF", x: 12, y: 70 },
        { index: 2, line: "DEF", x: 31, y: 74 },
        { index: 3, line: "DEF", x: 50, y: 76 },
        { index: 4, line: "DEF", x: 69, y: 74 },
        { index: 5, line: "DEF", x: 88, y: 70 },
        { index: 6, line: "MC", x: 30, y: 52 },
        { index: 7, line: "MC", x: 50, y: 50 },
        { index: 8, line: "MC", x: 70, y: 52 },
        { index: 9, line: "DEL", x: 40, y: 28 },
        { index: 10, line: "DEL", x: 60, y: 28 }
    ]
};

export const DEFAULT_SYSTEM = "4-3-3";

// Clasificación de posición -> línea
export function groupFromPosition(pos) {
    const p = (pos || "").toLowerCase();
    if (p.includes("goalkeeper") || p.includes("portero") || p === "gk") return "POR";
    if (
        p.includes("defence") || p.includes("back") ||
        p.includes("centre-back") || p.includes("defensa") ||
        p === "cb" || p === "lb" || p === "rb"
    ) return "DEF";
    if (p.includes("midfield") || p.includes("medio") || p.includes("mid")) return "MC";
    if (
        p.includes("offence") || p.includes("forward") ||
        p.includes("wing") || p.includes("striker") ||
        p.includes("delantero")
    ) return "DEL";
    return null; // otros
}

/**
 * Resuelve el club_id a partir del nickname del equipo
 * @param {string} nickname - Nickname del equipo
 * @param {number|null} competitionId - ID de la competición (opcional, para filtrar por competición)
 * @returns {Promise<number|null>} ID del club o null si no se encuentra
 * @deprecated Usar resolveLeagueTeamIdFromNickname en su lugar
 */
export async function resolveClubIdFromNickname(nickname, competitionId = null) {
    if (!nickname) return null;
    const supabase = await getSupabaseClient();

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        const { getCurrentCompetitionId } = await import('./competitions.js');
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para league_teams. Es obligatorio.');
        }
    }

    let q = supabase
        .from("league_teams")
        .select("club_id, season, nickname, competition_id")
        .ilike("nickname", nickname)
        .limit(1);

    // league_teams.competition_id es NOT NULL, así que filtramos directamente
    // competition_id es obligatorio para league_teams
    if (finalCompetitionId === null) {
        throw new Error('competition_id es obligatorio para league_teams pero no se proporcionó ni se pudo obtener del contexto.');
    }
    q = q.eq("competition_id", finalCompetitionId);

    const { data, error } = await q;
    if (error) {
        console.warn("Error league_teams:", error);
        return null;
    }
    const row = data && data[0];
    return row?.club_id || null;
}

/**
 * Resuelve el league_team_id a partir del nickname del equipo
 * @param {string} nickname - Nickname del equipo
 * @param {number|null} competitionId - ID de la competición (opcional, para filtrar por competición)
 * @returns {Promise<number|null>} ID del league_team o null si no se encuentra
 */
export async function resolveLeagueTeamIdFromNickname(nickname, competitionId = null) {
    if (!nickname) return null;
    const supabase = await getSupabaseClient();

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        const { getCurrentCompetitionId } = await import('./competitions.js');
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para league_teams. Es obligatorio.');
        }
    }

    let q = supabase
        .from("league_teams")
        .select("id, club_id, season, nickname, competition_id")
        .ilike("nickname", nickname)
        .limit(1);

    // league_teams.competition_id es NOT NULL, así que filtramos directamente
    // competition_id es obligatorio para league_teams
    if (finalCompetitionId === null) {
        throw new Error('competition_id es obligatorio para league_teams pero no se proporcionó ni se pudo obtener del contexto.');
    }
    q = q.eq("competition_id", finalCompetitionId);

    const { data, error } = await q;
    if (error) {
        console.warn("Error league_teams:", error);
        return null;
    }
    const row = data && data[0];
    return row?.id || null;
}

/**
 * Carga la plantilla (squad) de un club
 * @param {number} clubId - ID del club
 * @param {number|null} competitionId - ID de la competición (opcional, para filtrar por competición)
 * @returns {Promise<Array>} Array de jugadores con información
 */
export async function loadSquadForClub(clubId, competitionId = null) {
    if (!clubId) return [];
    const supabase = await getSupabaseClient();
    const cfg = getSupabaseConfig();
    const season = cfg?.season || null;

    let q = supabase
        .from("player_club_memberships")
        .select(`
        player:players (
          id,
          name,
          position,
          nationality
        )
      `)
        .eq("club_id", clubId);

    // Nota: player_club_memberships puede no tener competition_id
    // Si la tabla tiene competition_id, usarlo con prioridad
    // Por ahora, solo filtramos por season si no hay competitionId
    // TODO: Verificar si player_club_memberships tiene competition_id en la BD
    if (season) {
        q = q.eq("season", season);
    }

    const { data, error } = await q;
    if (error) {
        console.warn("Error memberships:", error);
        return [];
    }

    const map = new Map();
    for (const row of data || []) {
        const p = row.player;
        if (!p || !p.id) continue;
        if (!map.has(p.id)) {
            map.set(p.id, {
                ...p,
                line: groupFromPosition(p.position)
            });
        }
    }
    return Array.from(map.values());
}

/**
 * Carga la formación de un club (por league_team_id)
 * @param {number} leagueTeamId - ID del league_team
 * @param {number|null} competitionId - ID de la competición (opcional, para filtrar por competición)
 * @returns {Promise<Object|null>} Objeto con la formación o null si no se encuentra
 */
export async function loadFormationForClub(leagueTeamId, competitionId = null) {
    if (!leagueTeamId) return null;
    const supabase = await getSupabaseClient();

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        const { getCurrentCompetitionId } = await import('./competitions.js');
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para formations. Es obligatorio.');
        }
    }

    let q = supabase
        .from("formations")
        .select(`
        id,
        system,
        slots:formation_slots (
          slot_index,
          player_id
        )
      `)
        .eq("league_team_id", leagueTeamId)
        .limit(1);

    // formations tiene competition_id, así que filtramos directamente
    // competition_id es obligatorio para formations
    if (finalCompetitionId === null) {
        throw new Error('competition_id es obligatorio para formations pero no se proporcionó ni se pudo obtener del contexto.');
    }
    q = q.eq("competition_id", finalCompetitionId);

    const { data, error } = await q;
    if (error) {
        console.warn("Error formations:", error);
        return null;
    }

    const row = data && data[0];
    if (!row) return null;

    const slots = new Map();
    for (const s of (row.slots || [])) {
        slots.set(s.slot_index, s.player_id);
    }

    return {
        id: row.id,
        system: row.system || DEFAULT_SYSTEM,
        slots
    };
}

/**
 * Guarda una formación en la base de datos
 * @param {number} leagueTeamId - ID del league_team (equipo del usuario)
 * @param {string} season - Temporada
 * @param {string} system - Sistema de juego (ej: "4-3-3")
 * @param {Map} slotsMap - Mapa de slot_index -> player_id
 * @param {number|null} formationId - ID de la formación existente (para actualizar)
 * @param {number|null} competitionId - ID de la competición (opcional)
 * @returns {Promise<Object>} Resultado de la operación {ok: boolean, msg: string, formationId?: number}
 */
export async function saveFormationToDb(leagueTeamId, season, system, slotsMap, formationId = null, competitionId = null) {
    if (!leagueTeamId) return { ok: false, msg: "Faltan datos (leagueTeamId)" };

    const template = FORMATION_TEMPLATES[system];
    if (!template) return { ok: false, msg: "Sistema de juego no válido" };

    const supabase = await getSupabaseClient();

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        const { getCurrentCompetitionId } = await import('./competitions.js');
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            return { ok: false, msg: "No se pudo obtener competition_id. Es obligatorio para formations." };
        }
    }

    if (finalCompetitionId === null) {
        return { ok: false, msg: "competition_id es obligatorio para formations pero no se proporcionó ni se pudo obtener del contexto." };
    }

    // 1) Upsert de formations
    let newFormationId = formationId;

    // Preparar datos para insert/update
    const formationData = {
        league_team_id: leagueTeamId,
        season: season,
        system: system,
        competition_id: finalCompetitionId
    };

    if (!newFormationId) {
        let ins = supabase.from("formations").insert(formationData).select("id").single();

        const { data, error } = await ins;
        if (error) {
            console.error("Error insert formations:", error);
            return { ok: false, msg: "No se pudo crear la formación" };
        }
        newFormationId = data.id;
    } else {
        let upd = supabase.from("formations").update(formationData).eq("id", newFormationId).select("id").single();

        const { data, error } = await upd;
        if (error) {
            // Si el error es porque competition_id no existe en la tabla, intentar sin él
            if (error.code === '42703' && competitionId !== null) {
                delete formationData.competition_id;
                const { data: retryData, error: retryError } = await supabase
                    .from("formations")
                    .update(formationData)
                    .eq("id", newFormationId)
                    .select("id")
                    .single();
                if (retryError) {
                    console.error("Error update formations:", retryError);
                    return { ok: false, msg: "No se pudo actualizar la formación" };
                }
                newFormationId = retryData.id;
            } else {
                console.error("Error update formations:", error);
                return { ok: false, msg: "No se pudo actualizar la formación" };
            }
        } else {
            newFormationId = data.id;
        }
    }

    // 2) Upsert de slots
    const rows = template.map(slot => ({
        formation_id: newFormationId,
        slot_index: slot.index,
        player_id: slotsMap.get(slot.index) || null
    }));

    const { error: slotsError } = await supabase
        .from("formation_slots")
        .upsert(rows, { onConflict: "formation_id,slot_index" });

    if (slotsError) {
        console.error("Error upsert formation_slots:", slotsError);
        return { ok: false, msg: "La formación se guardó parcialmente (error en slots)", formationId: newFormationId };
    }

    return { ok: true, msg: "Formación guardada", formationId: newFormationId };
}

/**
 * Calcula y carga automáticamente la mejor formación para un club
 * @param {number} leagueTeamId - ID del league_team
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<Object|null>} Objeto con la formación calculada o null si hay error
 */
export async function calculateAndLoadFormationForClub(leagueTeamId, competitionId) {
    if (!leagueTeamId || !competitionId) {
        console.warn('calculateAndLoadFormationForClub: leagueTeamId y competitionId son requeridos');
        return null;
    }
    
    const supabase = await getSupabaseClient();
    
    try {
        // Llamar a la RPC que calcula y guarda automáticamente la formación
        const { data, error } = await supabase.rpc('get_club_formation', {
            p_league_team_id: leagueTeamId,
            p_competition_id: competitionId
        });
        
        if (error) {
            // P0001 con "No se encontró portero" es un caso conocido de plantilla
            // incompleta (bug de datos, no de UX). Lo bajamos a warn 1-línea.
            const isKnownDataIssue =
                error.code === 'P0001' &&
                typeof error.message === 'string' &&
                /portero/i.test(error.message);
            if (isKnownDataIssue) {
                console.warn(`[formation] ${error.message} (lt=${leagueTeamId}, comp=${competitionId})`);
            } else {
                console.error('Error calculando formación automática:', error,
                    { leagueTeamId, competitionId });
            }
            return null;
        }
        
        if (!data) {
            console.warn('No se retornó formación desde get_club_formation');
            return null;
        }
        
        // Convertir respuesta a formato compatible con el estado actual
        // data tiene: { formation_id, system, slots: [{ slot_index, player_id }] }
        const slots = new Map();
        if (data.slots && Array.isArray(data.slots)) {
            for (const slot of data.slots) {
                if (slot.player_id) {
                    slots.set(slot.slot_index, slot.player_id);
                }
            }
        }
        
        return {
            id: data.formation_id,
            system: data.system || DEFAULT_SYSTEM,
            slots: slots
        };
    } catch (err) {
        console.error('Error en calculateAndLoadFormationForClub:', err);
        return null;
    }
}