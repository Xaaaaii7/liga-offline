// Runtime local de liga-offline: PGlite (Postgres en WASM) + pglite-socket
// (protocolo real de Postgres) + PostgREST real -> el frontend sigue usando
// supabase-js exactamente igual que contra Supabase cloud, solo cambia la URL.
//
// Node 18 no trae `CustomEvent` global (lo usa pglite-socket) - polyfill mínimo.
if (typeof globalThis.CustomEvent === 'undefined') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, params = {}) { super(type, params); this.detail = params.detail ?? null; }
  };
}

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import jwt from 'jsonwebtoken';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, chmod, access, rm, readdir } from 'node:fs/promises';
import { constants as fsConstants, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA_DIR = path.join(ROOT, 'data');
const BIN_DIR = path.join(ROOT, 'bin');
const STATIC_DIR = path.join(ROOT, 'public');

const PGLITE_SOCKET_PORT = 55432;
const POSTGREST_PORT = 3001;
const STATIC_PORT = 8080;

// Secreto local para firmar el JWT anon. No protege nada sensible: la app
// corre en 127.0.0.1 de la propia máquina del usuario, no hay multi-tenant
// que aislar. Cada instalación podría regenerarlo, pero no es necesario.
const JWT_SECRET = 'liga-offline-local-dev-secret-2026-not-for-remote-use';
const ANON_ROLE = 'web_anon';

function makeAnonKey() {
  // noTimestamp: mismo token en cada arranque (no lleva `exp`, así que es
  // válido indefinidamente) - así se puede hardcodear en config.js sin que
  // quede obsoleto.
  return jwt.sign({ role: ANON_ROLE }, JWT_SECRET, { algorithm: 'HS256', noTimestamp: true });
}

// ── 1. Asegurar binario de PostgREST (auto-descarga cacheada) ──────────────
const POSTGREST_VERSION = '14.14';
const PLATFORM_ASSET = {
  'linux-x64': `postgrest-v${POSTGREST_VERSION}-linux-static-x86-64.tar.xz`,
  'darwin-x64': `postgrest-v${POSTGREST_VERSION}-macos-x86-64.tar.xz`,
  'darwin-arm64': `postgrest-v${POSTGREST_VERSION}-macos-arm64.tar.xz`,
};

async function ensurePostgrest() {
  const binPath = path.join(BIN_DIR, 'postgrest');
  try {
    await access(binPath, fsConstants.X_OK);
    return binPath;
  } catch {
    // no existe todavía, se descarga
  }

  const key = `${process.platform}-${process.arch}`;
  const asset = PLATFORM_ASSET[key];
  if (!asset) {
    throw new Error(
      `No hay binario de PostgREST mapeado para ${key}. Instálalo manualmente y colócalo en ${binPath}.`
    );
  }

  console.log(`[liga-offline] Descargando PostgREST v${POSTGREST_VERSION} para ${key} (primera vez)...`);
  await mkdir(BIN_DIR, { recursive: true });
  const url = `https://github.com/PostgREST/postgrest/releases/download/v${POSTGREST_VERSION}/${asset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Descarga de PostgREST falló: ${res.status} ${res.statusText}`);

  const tmpFile = path.join(os.tmpdir(), asset);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpFile));

  // Se delega la extracción al `tar` del sistema (soporta xz) en vez de
  // depender de una lib JS de xz/lzma que no viene con Node.
  await execFileAsync('tar', ['-xJf', tmpFile, '-C', BIN_DIR]);
  await rm(tmpFile);
  await chmod(binPath, 0o755);
  console.log('[liga-offline] PostgREST listo en', binPath);
  return binPath;
}

// ── 2. Abrir/crear la base de datos PGlite persistente ─────────────────────
async function openDatabase() {
  await mkdir(DATA_DIR, { recursive: true });
  const db = new PGlite(path.join(DATA_DIR, 'pgdata'));
  await db.waitReady;

  const { rows } = await db.query(
    `select 1 from information_schema.tables where table_schema='public' and table_name='seasons'`
  );
  if (rows.length === 0) {
    console.log('[liga-offline] Base de datos nueva, aplicando schema...');
    const schemaDir = path.join(ROOT, 'supabase/schema');
    const files = (await readdir(schemaDir)).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      const sql = await readFile(path.join(schemaDir, f), 'utf8');
      await db.exec(sql);
      console.log(`[liga-offline]   ${f} aplicado`);
    }
    console.log('[liga-offline] Schema aplicado.');
  }
  return db;
}

// ── 3. Exponer PGlite por el wire protocol real de Postgres ────────────────
async function startSocketServer(db) {
  // maxConnections por defecto es 1 (PGlite es de una sola conexión física,
  // pglite-socket multiplexa varias lógicas encima). Con solo 1, el pool de
  // PostgREST ya la ocupa entera y cualquier segunda conexión (scripts de
  // siembra/simulación) revienta con "Connection terminated unexpectedly".
  const server = new PGLiteSocketServer({ db, port: PGLITE_SOCKET_PORT, host: '127.0.0.1', maxConnections: 5 });
  await server.start();
  console.log(`[liga-offline] Postgres wire protocol en 127.0.0.1:${PGLITE_SOCKET_PORT}`);
  return server;
}

// ── 4. Lanzar PostgREST apuntando al socket ─────────────────────────────────
async function startPostgrest(binPath) {
  const confPath = path.join(DATA_DIR, 'postgrest.conf');
  const conf = `
db-uri = "postgres://authenticator:localdev@127.0.0.1:${PGLITE_SOCKET_PORT}/postgres"
db-schemas = "public"
db-anon-role = "${ANON_ROLE}"
jwt-secret = "${JWT_SECRET}"
server-host = "127.0.0.1"
server-port = ${POSTGREST_PORT}
db-pool = 1
db-prepared-statements = false
db-channel-enabled = false
`.trim();
  await writeFile(confPath, conf, 'utf8');

  const proc = spawn(binPath, [confPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => process.stdout.write(`[postgrest] ${d}`));
  proc.stderr.on('data', (d) => process.stderr.write(`[postgrest] ${d}`));
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[liga-offline] PostgREST terminó con código ${code}`);
  });

  // esperar a que levante antes de seguir
  await new Promise((resolve, reject) => {
    const start = Date.now();
    const check = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${POSTGREST_PORT}/`);
        if (r.ok || r.status === 404) return resolve();
      } catch {}
      if (Date.now() - start > 10000) return reject(new Error('PostgREST no arrancó a tiempo'));
      setTimeout(check, 200);
    };
    check();
  });
  console.log(`[liga-offline] PostgREST escuchando en http://127.0.0.1:${POSTGREST_PORT}`);
  return proc;
}

// ── 5. Servidor estático para el frontend + proxy /rest/v1 -> PostgREST ────
// supabase-js antepone siempre `/rest/v1` a las rutas (así habla con el
// gateway real de Supabase). Nuestro PostgREST está montado en la raíz, así
// que este único servidor traduce `/rest/v1/*` -> PostgREST y sirve el resto
// como estático - un solo origen, sin CORS que gestionar.
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.sql': 'text/plain' };

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks) : undefined;
}

async function proxyToPostgrest(req, res) {
  const target = `http://127.0.0.1:${POSTGREST_PORT}${req.url.replace(/^\/rest\/v1/, '')}`;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers.connection;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readRequestBody(req);
  const upstream = await fetch(target, { method: req.method, headers, body });
  const resHeaders = Object.fromEntries(upstream.headers);
  delete resHeaders['content-encoding']; // ya decodificado por fetch
  res.writeHead(upstream.status, resHeaders);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

// ── Simular un partido IA-vs-IA server-side ────────────────────────────────
// La simulación (scripts/simulate-match.js) corre en Node (lee historial,
// genera SQL) — no puede correr en el navegador. Este endpoint la lanza para
// un match_uuid concreto y aplica el SQL a la BD local, para que el botón
// "Simular" de resultados.html funcione sin CLI. Se usa `matchuuid` (no
// `match`) porque matches.id no es único entre competiciones.
async function simulateMatch(db, matchUuid) {
  const tmpFile = path.join(os.tmpdir(), `sim-${matchUuid}-${Date.now()}.sql`);
  await new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['scripts/simulate-match.js', 'matchuuid', String(matchUuid), tmpFile], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `simulate-match salió con código ${code}`)));
  });
  const sql = await readFile(tmpFile, 'utf8');
  await db.exec(sql);
  await rm(tmpFile).catch(() => {});
}

// Re-simular un partido YA jugado: borra su resultado, stats y eventos (y los
// registros hacia adelante que generó: suspensiones por sus rojas, lesiones),
// pone el marcador a NULL y vuelve a simular. Nota: no cascada a jornadas
// posteriores — re-tira solo ESTE partido (re-roll casual del resultado).
async function resimulateMatch(db, matchUuid) {
  const uuid = parseInt(matchUuid, 10);
  await db.exec(`
    DELETE FROM match_team_stats     WHERE match_uuid = ${uuid};
    DELETE FROM goal_events          WHERE match_uuid = ${uuid};
    DELETE FROM match_red_cards      WHERE match_uuid = ${uuid};
    DELETE FROM match_yellow_cards   WHERE match_uuid = ${uuid};
    DELETE FROM match_substitutions  WHERE match_uuid = ${uuid};
    DELETE FROM match_injuries       WHERE match_uuid = ${uuid};
    DELETE FROM match_player_ratings WHERE match_uuid = ${uuid};
    DELETE FROM player_suspensions   WHERE origin_match_uuid = ${uuid};
    UPDATE matches SET home_goals = NULL, away_goals = NULL, resolved_administratively = false WHERE match_uuid = ${uuid};
  `);
  await simulateMatch(db, uuid);
}

async function readBodyJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}

function startStaticServer(db) {
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/rest/v1/')) {
      try {
        return await proxyToPostgrest(req, res);
      } catch (e) {
        res.writeHead(502);
        return res.end(`Proxy a PostgREST falló: ${e.message}`);
      }
    }
    if (req.url === '/api/simulate' && req.method === 'POST') {
      try {
        const body = await readBodyJson(req);
        const uuid = parseInt(body.match_uuid, 10);
        if (!Number.isFinite(uuid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'match_uuid inválido' }));
        }
        await simulateMatch(db, uuid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
    if (req.url === '/api/resimulate' && req.method === 'POST') {
      try {
        const body = await readBodyJson(req);
        const uuid = parseInt(body.match_uuid, 10);
        if (!Number.isFinite(uuid)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'match_uuid inválido' }));
        }
        await resimulateMatch(db, uuid);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    }
    try {
      let filePath = path.join(STATIC_DIR, decodeURIComponent(req.url.split('?')[0]));
      if (filePath.endsWith('/')) filePath = path.join(filePath, 'index.html');
      const data = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  server.listen(STATIC_PORT, '127.0.0.1');
  console.log(`[liga-offline] Frontend en http://127.0.0.1:${STATIC_PORT}`);
  return server;
}

// ── 6. Sustituto local de los cron jobs de fanbase/moral ───────────────────
function startDecayScheduler(db) {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const run = async () => {
    try {
      const r = await db.query('SELECT _player_morale_apply_decay() as n;');
      console.log(`[liga-offline] Decay de moral aplicado (${r.rows[0]?.n ?? 0} jugadores)`);
    } catch (e) {
      console.error('[liga-offline] Error en decay de moral:', e.message);
    }
  };
  run(); // catch-up al arrancar
  return setInterval(run, DAY_MS);
}

// ── main ─────────────────────────────────────────────────────────────────
const db = await openDatabase();
const socketServer = await startSocketServer(db);
const postgrestBin = await ensurePostgrest();
const postgrestProc = await startPostgrest(postgrestBin);
const staticServer = startStaticServer(db);
const decayTimer = startDecayScheduler(db);

console.log('\n[liga-offline] Listo. anonKey local para SUPABASE_CONFIG:');
console.log(makeAnonKey());
console.log(`\nAbre http://127.0.0.1:${STATIC_PORT} en el navegador.`);

process.on('SIGINT', async () => {
  console.log('\n[liga-offline] Apagando...');
  clearInterval(decayTimer);
  postgrestProc.kill();
  await socketServer.stop();
  await db.close();
  staticServer.close();
  process.exit(0);
});
