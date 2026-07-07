import * as StatsData from './modules/stats-data.js';
import * as StatsCalc from './modules/stats-calc.js';
import * as StatsAnalyze from './modules/stats-analyze.js';
import { isNum, toNum } from './modules/utils.js';

// Aggregate all functions into a single CoreStats object
const CoreStats = {
    // Data
    getResultados: StatsData.getResultados,
    getStatsIndex: StatsData.getStatsIndex,
    getPichichiRows: StatsData.getPichichiRows,
    computePichichiPlayers: StatsAnalyze.computePichichiPlayers,

    // Calculation
    computeClasificacion: StatsCalc.computeClasificacion,
    computeClasificacionPorJornada: StatsCalc.computeClasificacionPorJornada,
    computeTeamTotals: StatsCalc.computeTeamTotals,

    // Analysis
    computeRankingsPorEquipo: StatsAnalyze.computeRankingsPorEquipo,
    computeMvpPorJornada: StatsAnalyze.computeMvpPorJornada,
    computeMvpTemporada: StatsAnalyze.computeMvpTemporada,

    // Helpers
    dg: StatsCalc.dg,
    isNum,
    toNum,
    // Add internal helpers if needed, but preferably use them from modules directly

    // Internal use (compatibility)
    norm: window.AppUtils ? window.AppUtils.normalizeText : (s) => String(s).toLowerCase(),
    slug: window.AppUtils ? window.AppUtils.slugify : (s) => String(s).toLowerCase().replace(/\s/g, '-')
};

// Expose globally
window.CoreStats = CoreStats;
