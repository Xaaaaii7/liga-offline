import { getSupabaseClient } from './supabase-client.js';
import { redirectTo } from './competition-context.js';
import { escapeHtml } from './utils.js';

export async function getCurrentUser() {
    const supabase = await getSupabaseClient();

    try {
        const { data, error } = await supabase.auth.getUser();

        // Si no hay sesión, Supabase lanza AuthSessionMissingError:
        if (error) {
            if (error.name === "AuthSessionMissingError") {
                // Caso normal: usuario anónimo, no lo tratamos como error
                return null;
            }
            console.error("Error obteniendo usuario actual", error);
            return null;
        }

        return data?.user ?? null;
    } catch (e) {
        console.error("Error inesperado en getCurrentUser:", e);
        return null;
    }
}

export async function getCurrentProfile() {
    const user = await getCurrentUser();
    if (!user) return null;

    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('profiles')
        .select('nickname, is_admin, is_approved, team_nickname, coins, is_super_admin')
        .eq('id', user.id)
        .maybeSingle();

    if (error) {
        console.warn('Error cargando profile', error);
        return null;
    }
    return data || null;
}

export async function login(email, password) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

export async function logout() {
    const supabase = await getSupabaseClient();
    await supabase.auth.signOut();
    redirectTo('index.html');
}
