
import { getSupabaseClient, getSupabaseConfig } from './supabase-client.js';
import { getCurrentCompetitionId } from './competitions.js';
import { TABLES_WITH_COMPETITION_ID } from './db-helpers.js';

/**
 * Helper interno para buscar usuario por nickname
 */
async function getUserRowByNickname(nickname) {
    if (!nickname) return null;
    try {
        const supabase = await getSupabaseClient();
        const { data, error } = await supabase
            .from("users")
            .select("id,nickname,youtube_playlist_id,twitch_channel")
            .ilike("nickname", nickname); // case-insensitive

        if (error) {
            console.warn("Supabase users error:", error);
            return null;
        }
        return (data && data[0]) || null;
    } catch (e) {
        console.warn("Supabase users exception:", e);
        return null;
    }
}

/**
 * Carga la plantilla de un club desde Supabase
 * @param {string} clubNickname - Nickname del club
 * @param {number|null} competitionId - ID de la competición (opcional, para filtrar por competición)
 */
export async function loadPlantillaFromDb(clubNickname, competitionId = null) {
    if (!clubNickname) return null;

    const supabase = await getSupabaseClient();
    const cfg = getSupabaseConfig();
    const season = cfg?.season || null;

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para league_teams. Es obligatorio.');
        }
    }

    // 1) Resolver club_id a partir de league_teams.nickname
    // league_teams.competition_id es NOT NULL, así que filtramos directamente
    let ltQuery = supabase
        .from("league_teams")
        .select("club_id, season, nickname, competition_id")
        .ilike("nickname", clubNickname)      // case-insensitive
        .limit(1);

    // competition_id es obligatorio para league_teams
    if (finalCompetitionId === null) {
        throw new Error('competition_id es obligatorio para league_teams pero no se proporcionó ni se pudo obtener del contexto.');
    }
    ltQuery = ltQuery.eq("competition_id", finalCompetitionId);

    const { data: ltRows, error: ltError } = await ltQuery;
    if (ltError) {
        console.warn("Supabase league_teams error:", ltError);
        return null;
    }

    const lt = ltRows && ltRows[0];
    if (!lt || !lt.club_id) {
        console.warn("No se encontró league_team para", clubNickname, "season:", season);
        return null;
    }

    const clubId = lt.club_id;

    // 2) Leer memberships + players para ese club_id
    const baseSelect = `
      id,
      season,
      from_round,
      to_round,
      is_current,
      club:clubs (
        id,
        name,
        short_name,
        crest_url,
        country,
        venue
      ),
      player:players (
        id,
        name,
        position,
        date_of_birth,
        nationality
      )
    `;

    // Preferimos is_current = true; si no hay, tiramos de fallback
    let membQuery = supabase
        .from("player_club_memberships")
        .select(baseSelect)
        .eq("club_id", clubId)
        .eq("is_current", true);

    if (season) membQuery = membQuery.eq("season", season);

    let { data: membs, error: membErr } = await membQuery;
    if (membErr) {
        console.warn("Supabase memberships error:", membErr);
        return null;
    }

    if (!membs || !membs.length) {
        // Fallback: cualquier membership de ese club en la season
        let fbQuery = supabase
            .from("player_club_memberships")
            .select(baseSelect)
            .eq("club_id", clubId);

        if (season) fbQuery = fbQuery.eq("season", season);

        const { data: fbData, error: fbErr } = await fbQuery;
        if (fbErr) {
            console.warn("Supabase memberships fallback error:", fbErr);
            return null;
        }
        membs = fbData || [];
    }

    if (!membs.length) {
        console.warn("Sin memberships para club_id", clubId, "season", season);
        return null;
    }

    const club = membs[0].club || null;

    return {
        club,
        squad: membs
            .filter(m => m.player) // por si acaso
            .map(m => ({
                id: m.player.id,
                name: m.player.name,
                position: m.player.position,
                dateOfBirth: m.player.date_of_birth,
                nationality: m.player.nationality
            }))
    };
}

/**
 * Resuelve el ID de playlist de YouTube para un club
 */
export async function resolvePlaylistIdForClub(clubName) {
    if (!clubName) return null;

    // 1) Supabase: tabla users, nickname = CLUB
    const userRow = await getUserRowByNickname(clubName);
    if (userRow && userRow.youtube_playlist_id) {
        return userRow.youtube_playlist_id;
    }

    return null;
}

/**
 * Obtiene los items de una playlist de YouTube vía RSS
 */
export async function fetchPlaylistItemsRSS(playlistId) {
    const url = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xmlText = await res.text();

    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const entries = Array.from(doc.querySelectorAll("entry"));

    return entries.map(e => {
        const videoId = e.querySelector("yt\\:videoId, videoId")?.textContent?.trim();
        const title = e.querySelector("title")?.textContent?.trim() || "Vídeo";
        const thumbEl = e.querySelector("media\\:thumbnail, thumbnail");
        const thumb = thumbEl?.getAttribute("url") || "";

        return { videoId, title, thumb };
    }).filter(x => x.videoId);
}
