/**
 * Cliente para la Lambda `clubs-import` (import/sync de clubs y squads).
 *
 * La Lambda valida el JWT del usuario y comprueba `is_super_admin`.
 * Si no eres super admin, las llamadas devolverán 403.
 */
import { getSupabaseClient } from './supabase-client.js';

const ENDPOINT = 'https://d39ra5ecf4.execute-api.eu-west-1.amazonaws.com/prod/clubs-import';

async function callLambda(mode, payload = {}) {
  const supabase = await getSupabaseClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('No hay sesión activa');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ mode, ...payload }),
  });

  let body = {};
  try { body = await res.json(); } catch { /* respuesta vacía */ }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export const listPendingClubs = (season) => callLambda('list-pending', { season });
export const importClub = (teamId, leagueId, season) => callLambda('import', { teamId, leagueId, season });
export const syncClub = (clubId, season) => callLambda('sync', { clubId, season });
