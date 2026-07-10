// Resetea y re-simula TODOS los partidos ya jugados de una o más competiciones
// con el motor actual de simulate-match.js. Útil tras cambios en el motor de
// simulación (p.ej. limpiar ligas con historial "envenenado" por una versión
// anterior). Los partidos se re-simulan en orden de jornada para que el
// historial se reconstruya progresivamente.
//
// Uso:  node scripts/resim-competition.mjs <compId> [compId...]
// Requiere server.mjs corriendo (usa el socket pg en 127.0.0.1:55432).
import pg from 'pg';
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const comps = process.argv.slice(2).map(n => parseInt(n, 10)).filter(Boolean);
if (!comps.length) {
    console.error('Uso: node scripts/resim-competition.mjs <compId> [compId...]');
    process.exit(1);
}

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const client = new pg.Client({ host: '127.0.0.1', port: 55432, database: 'postgres', user: 'authenticator', password: 'localdev' });
await client.connect();

// Partidos jugados, en orden de jornada (round_id).
const { rows: matches } = await client.query(
    `SELECT match_uuid, competition_id, round_id FROM matches
     WHERE competition_id IN (${comps.join(',')})
       AND home_goals IS NOT NULL AND away_goals IS NOT NULL
     ORDER BY competition_id, round_id, match_uuid`
);
console.log(`[resim] ${matches.length} partidos jugados en comps ${comps.join(', ')}`);
if (!matches.length) { await client.end(); process.exit(0); }

const uuidList = matches.map(m => m.match_uuid).join(',');

// 1) Reset: borrar filas dependientes y poner goles a NULL.
await client.query('BEGIN');
for (const t of ['match_team_stats', 'goal_events', 'match_red_cards', 'match_yellow_cards', 'match_player_ratings']) {
    const r = await client.query(`DELETE FROM ${t} WHERE match_uuid IN (${uuidList})`);
    console.log(`  borradas ${r.rowCount} filas de ${t}`);
}
// Suspensiones: por competición (referencian partidos futuros, no solo los jugados).
for (const cid of comps) {
    const r = await client.query(`DELETE FROM player_suspensions WHERE competition_id = ${cid}`);
    if (r.rowCount) console.log(`  borradas ${r.rowCount} suspensiones de comp ${cid}`);
}
await client.query(
    `UPDATE matches SET home_goals = NULL, away_goals = NULL, resolved_administratively = false
     WHERE match_uuid IN (${uuidList})`
);
await client.query('COMMIT');
console.log('[resim] reset hecho. Re-simulando en orden de jornada...');

// 2) Re-simular en orden (cada partido ve el historial nuevo de los anteriores).
let done = 0;
for (const m of matches) {
    const tmp = path.join(os.tmpdir(), `resim-${m.match_uuid}-${Date.now()}.sql`);
    await new Promise((res, rej) => {
        const p = spawn(process.execPath, ['scripts/simulate-match.js', 'matchuuid', String(m.match_uuid), tmp],
            { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = ''; p.stderr.on('data', d => err += d);
        p.on('error', rej);
        p.on('exit', c => c === 0 ? res() : rej(new Error(err || `exit ${c}`)));
    });
    const sql = await readFile(tmp, 'utf8');
    await client.query(sql);
    await rm(tmp).catch(() => {});
    done++;
    if (done % 5 === 0 || done === matches.length) console.log(`  ${done}/${matches.length}`);
}
console.log(`[resim] completado: ${done} partidos re-simulados.`);
await client.end();
