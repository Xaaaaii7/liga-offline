/**
 * Módulo para gestionar la subida de logos de competiciones
 * Maneja la subida, eliminación y validación de imágenes
 */

import { getSupabaseClient } from './supabase-client.js';

// =====================================================
// Configuración
// =====================================================

const BUCKET_NAME = 'competition-logos';
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

// =====================================================
// Funciones principales
// =====================================================

/**
 * Sube un logo para una competición
 * @param {number} competitionId - ID de la competición
 * @param {File} file - Archivo de imagen a subir
 * @returns {Promise<{success: boolean, url?: string, error?: string}>}
 */
export async function uploadCompetitionLogo(competitionId, file) {
  try {
    // Validar archivo
    const validation = validateFile(file);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Obtener cliente de Supabase
    const supabase = await getSupabaseClient();

    // Generar nombre de archivo único
    const timestamp = Date.now();
    const extension = getFileExtension(file.name);
    const fileName = `${timestamp}-logo${extension}`;
    const filePath = `${competitionId}/${fileName}`;

    // Eliminar logo anterior si existe
    await deleteOldLogos(competitionId);

    // Subir archivo
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: false,
        contentType: file.type
      });

    if (error) {
      console.error('Error subiendo logo:', error);
      return { 
        success: false, 
        error: `Error al subir el logo: ${error.message}` 
      };
    }

    // Obtener URL pública
    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return {
      success: true,
      url: publicUrl,
      path: filePath
    };

  } catch (error) {
    console.error('Error inesperado en uploadCompetitionLogo:', error);
    return {
      success: false,
      error: `Error inesperado: ${error.message}`
    };
  }
}

/**
 * Elimina el logo de una competición
 * @param {number} competitionId - ID de la competición
 * @param {string} logoUrl - URL del logo a eliminar (opcional, se puede derivar del competitionId)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
export async function deleteCompetitionLogo(competitionId, logoUrl = null) {
  try {
    const supabase = await getSupabaseClient();

    // Si se proporciona URL, extraer el path
    let pathToDelete = null;
    
    if (logoUrl) {
      pathToDelete = extractPathFromUrl(logoUrl);
    }

    // Si no hay path específico, eliminar todos los logos de la competición
    if (!pathToDelete) {
      await deleteOldLogos(competitionId);
      return { success: true };
    }

    // Eliminar archivo específico
    const { error } = await supabase.storage
      .from(BUCKET_NAME)
      .remove([pathToDelete]);

    if (error) {
      console.error('Error eliminando logo:', error);
      return {
        success: false,
        error: `Error al eliminar el logo: ${error.message}`
      };
    }

    return { success: true };

  } catch (error) {
    console.error('Error inesperado en deleteCompetitionLogo:', error);
    return {
      success: false,
      error: `Error inesperado: ${error.message}`
    };
  }
}

/**
 * Obtiene la URL pública del logo de una competición
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<string|null>} URL del logo o null si no existe
 */
export async function getCompetitionLogoUrl(competitionId) {
  try {
    const supabase = await getSupabaseClient();

    // Listar archivos en la carpeta de la competición
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .list(`${competitionId}`, {
        limit: 1,
        sortBy: { column: 'created_at', order: 'desc' }
      });

    if (error || !data || data.length === 0) {
      return null;
    }

    // Obtener URL pública del logo más reciente
    const filePath = `${competitionId}/${data[0].name}`;
    const { data: { publicUrl } } = supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(filePath);

    return publicUrl;

  } catch (error) {
    console.error('Error obteniendo URL del logo:', error);
    return null;
  }
}

// =====================================================
// Funciones de validación
// =====================================================

/**
 * Valida un archivo antes de subirlo
 * @param {File} file - Archivo a validar
 * @returns {Object} {valid: boolean, error?: string}
 */
export function validateFile(file) {
  if (!file) {
    return { valid: false, error: 'No se ha seleccionado ningún archivo' };
  }

  // Validar tamaño
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(1);
    return { 
      valid: false, 
      error: `El archivo es demasiado grande. Tamaño máximo: ${sizeMB}MB` 
    };
  }

  // Validar tipo MIME
  if (!ALLOWED_MIME_TYPES.includes(file.type.toLowerCase())) {
    return {
      valid: false,
      error: 'Formato de archivo no permitido. Use JPG, PNG o WEBP'
    };
  }

  // Validar extensión
  const extension = getFileExtension(file.name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(extension)) {
    return {
      valid: false,
      error: 'Extensión de archivo no permitida. Use .jpg, .png o .webp'
    };
  }

  return { valid: true };
}

/**
 * Valida las dimensiones de una imagen
 * @param {File} file - Archivo de imagen
 * @param {Object} options - Opciones {minWidth, minHeight, maxWidth, maxHeight}
 * @returns {Promise<{valid: boolean, error?: string, dimensions?: {width, height}}>}
 */
export async function validateImageDimensions(file, options = {}) {
  const {
    minWidth = 100,
    minHeight = 100,
    maxWidth = 2000,
    maxHeight = 2000
  } = options;

  return new Promise((resolve) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      const { width, height } = img;

      if (width < minWidth || height < minHeight) {
        resolve({
          valid: false,
          error: `La imagen es demasiado pequeña. Mínimo: ${minWidth}x${minHeight}px`,
          dimensions: { width, height }
        });
        return;
      }

      if (width > maxWidth || height > maxHeight) {
        resolve({
          valid: false,
          error: `La imagen es demasiado grande. Máximo: ${maxWidth}x${maxHeight}px`,
          dimensions: { width, height }
        });
        return;
      }

      resolve({
        valid: true,
        dimensions: { width, height }
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve({
        valid: false,
        error: 'No se pudo cargar la imagen. Archivo corrupto o formato inválido'
      });
    };

    img.src = objectUrl;
  });
}

// =====================================================
// Funciones auxiliares
// =====================================================

/**
 * Elimina todos los logos antiguos de una competición
 * @param {number} competitionId - ID de la competición
 */
async function deleteOldLogos(competitionId) {
  try {
    const supabase = await getSupabaseClient();

    // Listar todos los archivos de la competición
    const { data, error } = await supabase.storage
      .from(BUCKET_NAME)
      .list(`${competitionId}`);

    if (error || !data || data.length === 0) {
      return;
    }

    // Crear array de paths a eliminar
    const pathsToDelete = data.map(file => `${competitionId}/${file.name}`);

    // Eliminar todos los archivos
    if (pathsToDelete.length > 0) {
      await supabase.storage
        .from(BUCKET_NAME)
        .remove(pathsToDelete);
    }

  } catch (error) {
    console.warn('Error eliminando logos antiguos:', error);
    // No lanzar error, solo advertir
  }
}

/**
 * Extrae el path del archivo desde una URL pública de Supabase
 * @param {string} url - URL pública del archivo
 * @returns {string|null} Path del archivo o null
 */
function extractPathFromUrl(url) {
  try {
    // Formato esperado: https://[proyecto].supabase.co/storage/v1/object/public/competition-logos/[path]
    const match = url.match(/\/competition-logos\/(.+)$/);
    return match ? match[1] : null;
  } catch (error) {
    console.error('Error extrayendo path de URL:', error);
    return null;
  }
}

/**
 * Obtiene la extensión de un archivo
 * @param {string} filename - Nombre del archivo
 * @returns {string} Extensión con punto (ej: '.jpg')
 */
function getFileExtension(filename) {
  const lastDot = filename.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filename.substring(lastDot).toLowerCase();
}

/**
 * Genera una vista previa de una imagen como Data URL
 * @param {File} file - Archivo de imagen
 * @returns {Promise<string>} Data URL de la imagen
 */
export async function generatePreview(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      resolve(e.target.result);
    };
    
    reader.onerror = (error) => {
      reject(error);
    };
    
    reader.readAsDataURL(file);
  });
}

/**
 * Comprime una imagen si es necesario
 * @param {File} file - Archivo de imagen original
 * @param {number} maxSizeKB - Tamaño máximo en KB
 * @param {number} quality - Calidad de compresión (0-1)
 * @returns {Promise<File>} Archivo comprimido o original si no es necesario
 */
export async function compressImage(file, maxSizeKB = 500, quality = 0.8) {
  // Si el archivo ya es menor que el tamaño máximo, devolverlo sin comprimir
  if (file.size <= maxSizeKB * 1024) {
    return file;
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    
    reader.onload = (e) => {
      const img = new Image();
      
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        
        canvas.toBlob(
          (blob) => {
            const compressedFile = new File(
              [blob], 
              file.name, 
              { type: 'image/jpeg', lastModified: Date.now() }
            );
            resolve(compressedFile);
          },
          'image/jpeg',
          quality
        );
      };
      
      img.src = e.target.result;
    };
    
    reader.readAsDataURL(file);
  });
}

