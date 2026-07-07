/**
 * Módulo de gestión de avatares en Supabase Storage
 * Maneja subida, actualización, eliminación y obtención de avatares de usuario
 */

import { getSupabaseClient } from './supabase-client.js';
import { getCurrentUser } from './auth.js';

// Configuración
const AVATAR_BUCKET = 'avatars';
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const DEFAULT_AVATAR = 'img/logo.png'; // Avatar por defecto

/**
 * Valida un archivo de imagen
 * @param {File} file - Archivo a validar
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateAvatarFile(file) {
  if (!file) {
    return { valid: false, error: 'No se seleccionó ningún archivo' };
  }

  // Validar tipo
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { 
      valid: false, 
      error: 'Formato no permitido. Usa JPG, PNG o WebP' 
    };
  }

  // Validar tamaño
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
    return { 
      valid: false, 
      error: `El archivo es demasiado grande. Máximo ${sizeMB} MB` 
    };
  }

  return { valid: true, error: null };
}

/**
 * Obtiene la extensión del archivo basándose en el tipo MIME
 * @param {string} mimeType - Tipo MIME del archivo
 * @returns {string} Extensión del archivo
 */
function getFileExtension(mimeType) {
  const extensions = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp'
  };
  return extensions[mimeType] || 'jpg';
}

/**
 * Sube o actualiza el avatar del usuario
 * @param {File} file - Archivo de imagen
 * @param {string|null} userId - UUID del usuario (opcional, usa el actual si no se proporciona)
 * @returns {Promise<{success: boolean, url: string|null, error: string|null}>}
 */
export async function uploadAvatar(file, userId = null) {
  try {
    // Validar archivo
    const validation = validateAvatarFile(file);
    if (!validation.valid) {
      return { success: false, url: null, error: validation.error };
    }

    // Obtener usuario
    const user = userId ? { id: userId } : await getCurrentUser();
    if (!user) {
      return { success: false, url: null, error: 'Usuario no autenticado' };
    }

    const supabase = await getSupabaseClient();

    // Nombre del archivo: {user_id}.{ext}
    const extension = getFileExtension(file.type);
    const fileName = `${user.id}.${extension}`;
    const filePath = fileName;

    // Verificar si ya existe un avatar
    const { data: existingFiles } = await supabase
      .storage
      .from(AVATAR_BUCKET)
      .list('', {
        search: user.id
      });

    // Eliminar archivos existentes del usuario
    if (existingFiles && existingFiles.length > 0) {
      const filesToDelete = existingFiles.map(f => f.name);
      await supabase
        .storage
        .from(AVATAR_BUCKET)
        .remove(filesToDelete);
    }

    // Subir nuevo avatar
    const { data, error } = await supabase
      .storage
      .from(AVATAR_BUCKET)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true
      });

    if (error) {
      console.error('Error subiendo avatar:', error);
      return { 
        success: false, 
        url: null, 
        error: 'Error al subir la imagen. Inténtalo de nuevo.' 
      };
    }

    // Obtener URL pública
    const { data: urlData } = supabase
      .storage
      .from(AVATAR_BUCKET)
      .getPublicUrl(filePath);

    // Añadir timestamp como cache-buster para forzar recarga del navegador
    const publicUrl = `${urlData.publicUrl}?t=${Date.now()}`;

    // Actualizar profiles.avatar_url
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ avatar_url: publicUrl })
      .eq('id', user.id);

    if (updateError) {
      console.error('Error actualizando avatar_url en profile:', updateError);
      // El archivo se subió pero no se actualizó el profile
      // No es crítico, continuar
    }

    return { 
      success: true, 
      url: publicUrl, 
      error: null 
    };

  } catch (error) {
    console.error('Error inesperado subiendo avatar:', error);
    return { 
      success: false, 
      url: null, 
      error: 'Error inesperado. Inténtalo de nuevo.' 
    };
  }
}

/**
 * Obtiene la URL del avatar del usuario
 * @param {string|null} userId - UUID del usuario (opcional)
 * @returns {Promise<string>} URL del avatar o avatar por defecto
 */
export async function getAvatarUrl(userId = null) {
  try {
    const user = userId ? { id: userId } : await getCurrentUser();
    if (!user) {
      return DEFAULT_AVATAR;
    }

    const supabase = await getSupabaseClient();

    // Obtener avatar_url del profile
    const { data: profile } = await supabase
      .from('profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .maybeSingle();

    // Si tiene avatar_url, retornarlo
    if (profile?.avatar_url) {
      return profile.avatar_url;
    }

    // Si no, retornar avatar por defecto
    return DEFAULT_AVATAR;

  } catch (error) {
    console.error('Error obteniendo avatar:', error);
    return DEFAULT_AVATAR;
  }
}

/**
 * Elimina el avatar del usuario
 * @param {string|null} userId - UUID del usuario (opcional)
 * @returns {Promise<{success: boolean, error: string|null}>}
 */
export async function deleteAvatar(userId = null) {
  try {
    const user = userId ? { id: userId } : await getCurrentUser();
    if (!user) {
      return { success: false, error: 'Usuario no autenticado' };
    }

    const supabase = await getSupabaseClient();

    // Buscar archivos del usuario
    const { data: files } = await supabase
      .storage
      .from(AVATAR_BUCKET)
      .list('', {
        search: user.id
      });

    if (files && files.length > 0) {
      const filesToDelete = files.map(f => f.name);
      
      // Eliminar archivos
      const { error } = await supabase
        .storage
        .from(AVATAR_BUCKET)
        .remove(filesToDelete);

      if (error) {
        console.error('Error eliminando avatar:', error);
        return { success: false, error: 'Error al eliminar la imagen' };
      }
    }

    // Actualizar profile para eliminar avatar_url
    await supabase
      .from('profiles')
      .update({ avatar_url: null })
      .eq('id', user.id);

    return { success: true, error: null };

  } catch (error) {
    console.error('Error inesperado eliminando avatar:', error);
    return { success: false, error: 'Error inesperado' };
  }
}

/**
 * Genera un preview de imagen antes de subirla
 * @param {File} file - Archivo de imagen
 * @returns {Promise<string>} Data URL del preview
 */
export function generateAvatarPreview(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      resolve(e.target.result);
    };
    
    reader.onerror = () => {
      reject(new Error('Error leyendo el archivo'));
    };
    
    reader.readAsDataURL(file);
  });
}

/**
 * Obtiene el avatar por defecto
 * @returns {string} URL del avatar por defecto
 */
export function getDefaultAvatar() {
  return DEFAULT_AVATAR;
}

/**
 * Verifica si un usuario tiene avatar personalizado
 * @param {string|null} userId - UUID del usuario (opcional)
 * @returns {Promise<boolean>} True si tiene avatar personalizado
 */
export async function hasCustomAvatar(userId = null) {
  try {
    const user = userId ? { id: userId } : await getCurrentUser();
    if (!user) return false;

    const supabase = await getSupabaseClient();

    const { data: profile } = await supabase
      .from('profiles')
      .select('avatar_url')
      .eq('id', user.id)
      .maybeSingle();

    return !!profile?.avatar_url;

  } catch (error) {
    console.error('Error verificando avatar personalizado:', error);
    return false;
  }
}

