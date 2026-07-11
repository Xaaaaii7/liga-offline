// CLI (Node): simula un partido IA-vs-IA por match_uuid y escribe el SQL a
// fichero. El MOTOR vive en public/js/modules/simulate-engine.js (compartido
// con el navegador). Aquí solo el envoltorio Node: cliente supabase-js contra
// PostgREST + escritura del fichero.
//
// Uso:  node scripts/simulate-match.js matchuuid <matchUuid> [outputPath]

// Node 18 no trae WebSocket global (supabase-js lo exige al crear el cliente,
// aunque no usemos realtime) — polyfill mínimo con `ws`.
if (typeof globalThis.WebSocket === 'undefined') {
    const { WebSocket } = await import('ws');
    globalThis.WebSocket = WebSocket;
}

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from '../public/js/modules/config.js';
import { simulateMatchToSql } from '../public/js/modules/simulate-engine.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== 'matchuuid') {
    console.error('Uso: node scripts/simulate-match.js matchuuid <matchUuid> [outputPath]');
    process.exit(1);
}
const matchUuid = parseInt(args[1], 10);
const outputPath = args[2] || null;
if (!Number.isFinite(matchUuid)) { console.error('matchUuid inválido'); process.exit(1); }

const sb = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

try {
    const sql = await simulateMatchToSql(sb, matchUuid);
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const finalPath = outputPath ? resolve(outputPath) : resolve(process.cwd(), `scripts/output/simulate-${ts}.sql`);
    const dir = dirname(finalPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(finalPath, sql, 'utf8');
    console.log(`SQL escrito en: ${finalPath}`);
} catch (e) {
    console.error('Error simulando:', e?.message || e);
    process.exit(1);
}
