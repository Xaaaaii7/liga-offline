/**
 * Módulo de helpers para gestión de usuarios
 * Maneja la relación entre auth.users (UUID), profiles y users (INTEGER)
 */

import { getSupabaseClient } from './supabase-client.js';
import { getCurrentUser, getCurrentProfile } from './auth.js';

/**
 * Obtiene el users.id (INTEGER) desde el auth.users.id (UUID)
 * 
 * Flujo:
 * 1. Obtiene el profile del usuario autenticado (UUID)
 * 2. Obtiene el team_nickname del profile
 * 3. Busca en la tabla users por nickname
 * 4. Retorna users.id (INTEGER)
 * 
 * @param {string|null} authUuid - UUID del usuario de auth.users (opcional)
 * @returns {Promise<number|null>} users.id (INTEGER) o null si no se encuentra
 */
export async function getUserIdFromAuthUuid(authUuid = null) {
  const supabase = await getSupabaseClient();
  
  try {
    // 1. Obtener el UUID del usuario autenticado si no se proporciona
    const userId = authUuid || (await getCurrentUser())?.id;
    if (!userId) {
      console.warn('[user-helpers] No hay usuario autenticado');
      return null;
    }

    // 2. Obtener el profile y su team_nickname
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('team_nickname, is_super_admin')
      .eq('id', userId)
      .maybeSingle();

    if (profileError) {
      console.error('[user-helpers] Error obteniendo profile:', profileError);
      return null;
    }

    // ✨ SUPER ADMIN: Los super admins no necesitan team_nickname
    // Si es super admin, devolver null (no es necesario users.id para administración)
    if (profile?.is_super_admin) {
      console.log('[user-helpers] Usuario es super admin, no requiere team_nickname');
      return null; // Super admins usan el UUID directamente en sus permisos
    }

    if (!profile?.team_nickname) {
      console.warn('[user-helpers] El usuario no tiene team_nickname asignado');
      return null;
    }

    // 3. Buscar en la tabla users por nickname
    const { data: user, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('nickname', profile.team_nickname)
      .maybeSingle();

    if (userError) {
      console.error('[user-helpers] Error buscando en users:', userError);
      return null;
    }

    if (!user) {
      console.warn(`[user-helpers] No existe entrada en users para el nickname: ${profile.team_nickname}`);
      return null;
    }

    return user.id;
  } catch (error) {
    console.error('[user-helpers] Error inesperado en getUserIdFromAuthUuid:', error);
    return null;
  }
}

/**
 * Obtiene el team_nickname del usuario autenticado
 * @param {string|null} authUuid - UUID del usuario (opcional)
 * @returns {Promise<string|null>} team_nickname o null
 */
export async function getTeamNickname(authUuid = null) {
  try {
    const userId = authUuid || (await getCurrentUser())?.id;
    if (!userId) return null;

    const profile = await getCurrentProfile();
    return profile?.team_nickname || null;
  } catch (error) {
    console.error('[user-helpers] Error obteniendo team_nickname:', error);
    return null;
  }
}

/**
 * Verifica si un usuario tiene una entrada válida en la tabla users
 * @param {string|null} authUuid - UUID del usuario (opcional)
 * @returns {Promise<boolean>} true si tiene entrada en users
 */
export async function hasValidUsersEntry(authUuid = null) {
  const usersId = await getUserIdFromAuthUuid(authUuid);
  return usersId !== null;
}

