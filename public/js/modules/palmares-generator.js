import { generatePalmares, calculateBestEleven } from './palmares-calculator.js';
import { savePalmares, saveBestEleven, palmaresExists } from './palmares-data.js';
import { getSupabaseClient } from './supabase-client.js';

/**
 * Module for automatically generating palmares when a competition is finished
 */

const getSupa = async () => {
    return await getSupabaseClient();
};

/**
 * Generate and save palmares for a finished competition
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Result with success status
 */
export const generateAndSavePalmares = async (competitionId) => {
    try {
        console.log(`[Palmares Generator] Starting generation for competition ${competitionId}`);

        const supa = await getSupa();
        if (!supa) {
            return { success: false, error: 'Supabase client not available' };
        }

        // Get competition details
        const { data: competition, error: compError } = await supa
            .from('competitions')
            .select('id, name, season, status')
            .eq('id', competitionId)
            .single();

        if (compError) throw compError;
        if (!competition) {
            return { success: false, error: 'Competition not found' };
        }

        // Check if competition is finished
        if (competition.status !== 'finished') {
            return { success: false, error: 'Competition is not finished yet' };
        }

        // Check if palmares already exists
        const exists = await palmaresExists(competitionId);
        if (exists) {
            console.log(`[Palmares Generator] Palmares already exists for competition ${competitionId}`);
            return { success: false, error: 'Palmares already exists. Use regenerate to update.' };
        }

        // Generate palmares data
        console.log(`[Palmares Generator] Calculating awards...`);
        const palmaresData = await generatePalmares(competitionId, competition.season);

        // Save palmares
        console.log(`[Palmares Generator] Saving palmares...`);
        const saveResult = await savePalmares(palmaresData);

        if (!saveResult.success) {
            return saveResult;
        }

        const palmaresId = saveResult.palmares.id;

        // Generate and save Best XI
        console.log(`[Palmares Generator] Calculating Best XI...`);
        const bestEleven = await calculateBestEleven(competitionId);

        if (bestEleven.length > 0) {
            console.log(`[Palmares Generator] Saving Best XI (${bestEleven.length} players)...`);
            await saveBestEleven(palmaresId, bestEleven);
        }

        console.log(`[Palmares Generator] Successfully generated palmares for competition ${competitionId}`);
        return {
            success: true,
            palmaresId,
            message: `Palmarés generado exitosamente para ${competition.name}`
        };
    } catch (err) {
        console.error('[Palmares Generator] Error:', err);
        return { success: false, error: err.message };
    }
};

/**
 * Regenerate palmares for a competition (overwrites existing)
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Result with success status
 */
export const regeneratePalmares = async (competitionId) => {
    try {
        console.log(`[Palmares Generator] Regenerating palmares for competition ${competitionId}`);

        const supa = await getSupa();
        if (!supa) {
            return { success: false, error: 'Supabase client not available' };
        }

        // Get competition details
        const { data: competition, error: compError } = await supa
            .from('competitions')
            .select('id, name, season, status')
            .eq('id', competitionId)
            .single();

        if (compError) throw compError;
        if (!competition) {
            return { success: false, error: 'Competition not found' };
        }

        // Check if competition is finished
        if (competition.status !== 'finished') {
            return { success: false, error: 'Competition is not finished yet. Only finished competitions can have palmares.' };
        }

        // Generate new palmares data
        const palmaresData = await generatePalmares(competitionId, competition.season);

        // Save (upsert will update if exists)
        const saveResult = await savePalmares(palmaresData);

        if (!saveResult.success) {
            return saveResult;
        }

        const palmaresId = saveResult.palmares.id;

        // Regenerate Best XI
        const bestEleven = await calculateBestEleven(competitionId);

        if (bestEleven.length > 0) {
            await saveBestEleven(palmaresId, bestEleven);
        }

        console.log(`[Palmares Generator] Successfully regenerated palmares`);
        return {
            success: true,
            palmaresId,
            message: `Palmarés regenerado exitosamente`
        };
    } catch (err) {
        console.error('[Palmares Generator] Error regenerating:', err);
        return { success: false, error: err.message };
    }
};

/**
 * Hook to be called when competition status changes to 'finished'
 * This can be called from competition management UI
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Result with success status
 */
export const onCompetitionFinished = async (competitionId) => {
    console.log(`[Palmares Generator] Competition ${competitionId} marked as finished`);
    return await generateAndSavePalmares(competitionId);
};
