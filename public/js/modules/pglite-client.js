// Cliente compatible (subconjunto) con la API de supabase-js, pero sobre PGlite
// corriendo EN EL NAVEGADOR — sin PostgREST ni backend Node. Traduce
// .from(t).select().eq()… a SQL, resuelve embeds (foo:table!fk(cols)) como
// consultas follow-up, y pasa .rpc(fn, args) a SELECT * FROM fn(...).
//
// Objetivo: que getSupabaseClient() pueda devolver ESTO y los ~52 ficheros de la
// app funcionen sin cambios. Cubre lo que la app usa; se extiende según haga falta.

import { PGlite } from '../../vendor/pglite/index.js';
import { SCHEMA_PATCH_VERSION, SCHEMA_PATCHES_SQL } from './schema-patches.js';

// Aplica los parches de esquema (CREATE OR REPLACE idempotentes) a una BD ya
// sembrada. Solo una vez por versión (flag en localStorage) para no costar en
// cada navegación.
async function applySchemaPatches(db) {
    try {
        const KEY = 'pglite-schema-patch-version';
        const cur = parseInt(localStorage.getItem(KEY) || '0', 10);
        if (cur >= SCHEMA_PATCH_VERSION) return;
        await db.exec(SCHEMA_PATCHES_SQL);
        localStorage.setItem(KEY, String(SCHEMA_PATCH_VERSION));
        console.log(`[PGlite] parches de esquema aplicados (v${SCHEMA_PATCH_VERSION})`);
    } catch (e) {
        console.warn('[PGlite] no se pudieron aplicar parches de esquema:', e && e.message || e);
    }
}

// ── Init de la BD (carga el seed la 1ª vez, persiste en IndexedDB) ───────────

// Muestra un error a pantalla completa (para diagnosticar en Tauri, que no
// tiene consola visible). Rethrow lo hace el llamante.
function showDbFatal(msg) {
    try {
        console.error('[PGlite]', msg);
        let d = document.getElementById('__pglite_fatal');
        if (!d) {
            d = document.createElement('div');
            d.id = '__pglite_fatal';
            d.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:#2a0a0a;color:#ffd7d7;' +
                'font:13px/1.5 monospace;padding:24px;overflow:auto;white-space:pre-wrap';
            document.body.appendChild(d);
        }
        d.textContent = '⚠️ Error inicializando la base de datos (PGlite)\n\n' + msg;
    } catch { /* noop */ }
}

// Borra la BD de PGlite en IndexedDB (para reintentar el seed si quedó vacía).
async function deletePgliteIdb() {
    let names = [];
    try {
        if (indexedDB.databases) {
            const dbs = await indexedDB.databases();
            names = dbs.map(d => d && d.name).filter(n => n && /pglite|liga-offline/i.test(n));
        }
    } catch { /* algunos webviews no soportan .databases() */ }
    if (!names.length) names = ['/pglite/liga-offline', 'pglite/liga-offline', 'liga-offline'];
    await Promise.all(names.map(n => new Promise(res => {
        try { const r = indexedDB.deleteDatabase(n); r.onsuccess = r.onerror = r.onblocked = () => res(); }
        catch { res(); }
    })));
}

let dbPromise = null;
async function getDb() {
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
        const IDB = 'idb://liga-offline';
        // ¿la BD tiene ESQUEMA? (existe la tabla clubs). Decidimos el reseed por
        // existencia de tabla, NUNCA por count de filas: una lectura 0 transitoria
        // (carrera al navegar, con la página anterior aún cerrando su conexión a
        // IndexedDB) NO debe disparar el borrado — eso colgaba (deleteDatabase se
        // bloquea con otra conexión abierta) y podía borrar una BD válida.
        const hasSchema = async (db) => {
            try { return (await db.query("select to_regclass('public.clubs') as t")).rows[0].t != null; }
            catch { return false; }
        };
        const fetchSeed = async () => {
            let r;
            try { r = await fetch('seed/pgdata.tar.gz'); }
            catch (e) { throw new Error('No se pudo pedir seed/pgdata.tar.gz: ' + (e && e.message || e)); }
            if (!r.ok) throw new Error('seed/pgdata.tar.gz devolvió HTTP ' + r.status + ' ' + r.statusText);
            const blob = await r.blob();
            if (!blob || blob.size < 1000) throw new Error('El seed llegó vacío o truncado (' + (blob ? blob.size : 0) + ' bytes)');
            return blob;
        };
        // Watchdog: si algún paso tarda demasiado, avisar en pantalla en qué fase.
        let phase = 'inicio';
        const watchdog = setTimeout(() => {
            showDbFatal(`PGlite lleva >12s en la fase: "${phase}".\n\nProbable bloqueo de IndexedDB (una conexión anterior no se soltó al navegar).`);
        }, 12000);
        try {
            const t0 = performance.now();
            // 1) abrir la BD persistida
            console.log('[PGlite] abriendo IndexedDB…'); phase = 'new PGlite(idb)';
            let db = new PGlite(IDB);
            await db.waitReady;
            const tOpen = performance.now();
            console.log(`[PGlite] abierta en ${(tOpen - t0).toFixed(0)}ms`); phase = 'hasSchema';
            // 2) ¿ya sembrada? (tabla clubs existe) → devolver TAL CUAL, no tocar.
            if (await hasSchema(db)) {
                phase = 'schemaPatches';
                await applySchemaPatches(db);
                phase = 'loadFkMeta';
                await loadFkMeta(db);
                clearTimeout(watchdog);
                console.log(`[PGlite] lista (fkMeta ${(performance.now() - tOpen).toFixed(0)}ms)`);
                return db;
            }
            console.log('[PGlite] sin esquema → sembrando desde el seed'); phase = 'reseed';
            // 3) BD sin esquema (1er arranque real) → sembrar desde el seed.
            //    Aquí no hay concurrencia (es la 1ª página), así que borrar es seguro.
            try { await db.close(); } catch { /* noop */ }
            await deletePgliteIdb();
            db = new PGlite(IDB, { loadDataDir: await fetchSeed() });
            await db.waitReady;
            if (!(await hasSchema(db))) throw new Error('El seed cargó pero no hay esquema (¿seed corrupto?).');
            await loadFkMeta(db);
            clearTimeout(watchdog);
            console.log(`[PGlite] sembrada desde seed en ${(performance.now() - t0).toFixed(0)}ms`);
            return db;
        } catch (e) {
            clearTimeout(watchdog);
            showDbFatal((e && e.stack) || (e && e.message) || String(e));
            dbPromise = null; // permitir reintento en la siguiente llamada
            throw e;
        }
    })();
    return dbPromise;
}

// Metadatos de claves foráneas: constraint → {localTable, localCol, foreignTable, foreignCol}
// y un índice (localTable→foreignTable)→fk para auto-detectar embeds sin hint.
let FK_BY_NAME = new Map();
let FK_BY_PAIR = new Map();
let PK_BY_TABLE = new Map();

// Los metadatos de FK/PK son ESTÁTICOS (dependen solo del esquema, que viene
// fijo en el seed). Consultarlos en information_schema cuesta ~1.2s y corría en
// CADA navegación (MPA) — se cachean en localStorage. Bump la versión si cambia
// el esquema.
const FKMETA_CACHE_KEY = 'pglite-fkmeta-v1';

function buildFkMaps(fkRows, pkRows) {
    FK_BY_NAME = new Map();
    FK_BY_PAIR = new Map();
    for (const r of fkRows) {
        const fk = { localTable: r.local_table, localCol: r.local_col, foreignTable: r.foreign_table, foreignCol: r.foreign_col };
        FK_BY_NAME.set(r.constraint_name, fk);
        const pair = `${r.local_table}|${r.foreign_table}`;
        if (!FK_BY_PAIR.has(pair)) FK_BY_PAIR.set(pair, []);
        FK_BY_PAIR.get(pair).push(fk);
    }
    PK_BY_TABLE = new Map(pkRows.map(r => [r.table_name, r.column_name]));
}

async function loadFkMeta(db) {
    try {
        const cached = localStorage.getItem(FKMETA_CACHE_KEY);
        if (cached) {
            const { fk, pk } = JSON.parse(cached);
            buildFkMaps(fk, pk);
            return;
        }
    } catch { /* cache corrupta → recomputar */ }
    const { rows: fkRows } = await q(db, `
        select tc.constraint_name, kcu.table_name local_table, kcu.column_name local_col,
               ccu.table_name foreign_table, ccu.column_name foreign_col
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
        join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
        where tc.constraint_type = 'FOREIGN KEY'`);
    const { rows: pkRows } = await q(db, `
        select tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
        where tc.constraint_type = 'PRIMARY KEY'`);
    buildFkMaps(fkRows, pkRows);
    try { localStorage.setItem(FKMETA_CACHE_KEY, JSON.stringify({ fk: fkRows, pk: pkRows })); } catch { /* noop */ }
}

// ── Parseo del string select de PostgREST (cols planas + embeds anidados) ────
// Devuelve { cols: [...], embeds: [{alias, table, fkHint, sub}] }
function parseSelect(sel) {
    sel = (sel || '*').trim();
    const cols = [], embeds = [];
    let i = 0, depth = 0, token = '';
    const flush = () => {
        const t = token.trim(); token = '';
        if (!t) return;
        const paren = t.indexOf('(');
        if (paren === -1) { cols.push(t); return; }
        // embed: [alias:]table[!fkHint]( sub )
        const head = t.slice(0, paren);
        const sub = t.slice(paren + 1, t.lastIndexOf(')'));
        let alias, rest;
        const colon = head.indexOf(':');
        if (colon >= 0) { alias = head.slice(0, colon); rest = head.slice(colon + 1); }
        else { rest = head; alias = null; }
        let table = rest, fkHint = null;
        const bang = rest.indexOf('!');
        if (bang >= 0) { table = rest.slice(0, bang); fkHint = rest.slice(bang + 1); }
        if (fkHint === 'inner') fkHint = null; // !inner: solo fuerza join, no es constraint
        embeds.push({ alias: alias || table, table, fkHint, sub: parseSelect(sub) });
    };
    for (; i < sel.length; i++) {
        const c = sel[i];
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === ',' && depth === 0) { flush(); continue; }
        token += c;
    }
    flush();
    return { cols, embeds };
}

// PGlite devuelve int8/numeric como STRING (para no perder precisión); PostgREST
// los da como número y la app hace math (.toFixed, etc.). Coercemos los tipos
// numéricos a Number para imitar a PostgREST.
const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]); // int8,int2,int4,oid,float4,float8,numeric
let SLOW_Q_TOTAL = 0, SLOW_Q_COUNT = 0;
async function q(db, sql) {
    const t0 = performance.now();
    const res = await db.query(sql);
    const dt = performance.now() - t0;
    SLOW_Q_TOTAL += dt; SLOW_Q_COUNT++;
    if (dt > 150) console.warn(`[PGlite query ${dt.toFixed(0)}ms] ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 180)}`);
    if (typeof window !== 'undefined') { window.__pgliteQ = { total: Math.round(SLOW_Q_TOTAL), count: SLOW_Q_COUNT }; }
    const nums = (res.fields || []).filter(f => NUMERIC_OIDS.has(f.dataTypeID)).map(f => f.name);
    if (nums.length) for (const row of res.rows) for (const f of nums) {
        const v = row[f];
        if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); if (!Number.isNaN(n)) row[f] = n; }
    }
    return res;
}

const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const lit = (v) => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (Array.isArray(v)) return 'ARRAY[' + v.map(lit).join(',') + ']';
    if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
    return "'" + String(v).replace(/'/g, "''") + "'";
};

class Query {
    constructor(table) {
        this.table = table;
        this._op = 'select';
        this._sel = '*';
        this._filters = [];   // strings de WHERE
        this._order = [];
        this._limit = null;
        this._single = 0;     // 0 | 1(single) | 2(maybeSingle)
        this._count = null;
        this._head = false;
        this._payload = null; // insert/update/upsert
        this._onConflict = null;
        this._embedFilters = []; // filtros alias.col (sobre recurso embebido)
    }
    // Filtro comparativo: si la columna lleva punto (alias.col) es un embed filter.
    _cmp(col, op, val) {
        if (col.includes('.')) { const [alias, c] = col.split('.'); this._embedFilters.push({ alias, col: c, op, val }); }
        else this._filters.push(`${ident(col)} ${sqlOp(op)} ${lit(val)}`);
        return this;
    }
    select(sel = '*', opts = {}) {
        if (this._op === 'select') this._sel = sel; else this._returning = sel;
        if (opts.count) this._count = opts.count;
        if (opts.head) this._head = true;
        return this;
    }
    insert(rows) { this._op = 'insert'; this._payload = Array.isArray(rows) ? rows : [rows]; return this; }
    update(obj) { this._op = 'update'; this._payload = obj; return this; }
    upsert(rows, opts = {}) { this._op = 'upsert'; this._payload = Array.isArray(rows) ? rows : [rows]; this._onConflict = opts.onConflict || null; return this; }
    delete() { this._op = 'delete'; return this; }
    eq(c, v) { return this._cmp(c, 'eq', v); }
    neq(c, v) { return this._cmp(c, 'neq', v); }
    gt(c, v) { return this._cmp(c, 'gt', v); }
    gte(c, v) { return this._cmp(c, 'gte', v); }
    lt(c, v) { return this._cmp(c, 'lt', v); }
    lte(c, v) { return this._cmp(c, 'lte', v); }
    like(c, p) { this._filters.push(`${ident(c)} LIKE ${lit(p)}`); return this; }
    ilike(c, p) { this._filters.push(`${ident(c)} ILIKE ${lit(p)}`); return this; }
    in(c, arr) { this._filters.push(`${ident(c)} = ANY(${lit(arr)})`); return this; }
    contains(c, v) { this._filters.push(`${ident(c)} @> ${lit(v)}`); return this; }
    is(c, v) { this._filters.push(`${ident(c)} IS ${v === null ? 'NULL' : lit(v)}`); return this; }
    not(c, op, v) {
        if (op === 'is') this._filters.push(`${ident(c)} IS NOT ${v === null ? 'NULL' : lit(v)}`);
        else if (op === 'in') this._filters.push(`NOT (${ident(c)} = ANY(${lit(v)}))`);
        else this._filters.push(`NOT (${ident(c)} ${sqlOp(op)} ${lit(v)})`);
        return this;
    }
    or(expr) { this._filters.push('(' + parseOr(expr) + ')'); return this; }
    order(c, opts = {}) { this._order.push(`${ident(c)} ${opts.ascending === false ? 'DESC' : 'ASC'}${opts.nullsFirst ? ' NULLS FIRST' : ''}`); return this; }
    limit(n) { this._limit = n; return this; }
    range(from, to) { this._limit = to - from + 1; this._offset = from; return this; }
    single() { this._single = 1; return this; }
    maybeSingle() { this._single = 2; return this; }
    then(resolve, reject) { return this._run().then(resolve, reject); }

    async _run() {
        try {
            const db = await getDb();
            // Embed filters (alias.col): base rows cuyo recurso embebido cumple → subquery.
            if (this._embedFilters.length) {
                const parsed = parseSelect(this._sel);
                for (const ef of this._embedFilters) {
                    const emb = parsed.embeds.find(e => e.alias === ef.alias);
                    const fk = emb ? (emb.fkHint ? FK_BY_NAME.get(emb.fkHint) : pickFk(this.table, emb.table)) : null;
                    if (fk) this._filters.push(`${ident(fk.localCol)} IN (SELECT ${ident(fk.foreignCol)} FROM ${ident(fk.foreignTable)} WHERE ${ident(ef.col)} ${sqlOp(ef.op)} ${lit(ef.val)})`);
                }
            }
            const where = this._filters.length ? ' WHERE ' + this._filters.join(' AND ') : '';
            let data = null, count = null;

            if (this._op === 'select') {
                if (this._count) {
                    const c = await q(db, `SELECT count(*)::int n FROM ${ident(this.table)}${where}`);
                    count = c.rows[0].n;
                    if (this._head) return { data: null, count, error: null };
                }
                const parsed = parseSelect(this._sel);
                // Incluir SIEMPRE las columnas FK que necesitan los embeds (aunque el
                // usuario no las pida) para poder hacer el JOIN follow-up.
                const hasStar = parsed.cols.length === 0 || parsed.cols.includes('*');
                const cols = hasStar ? '*' : [...new Set([...parsed.cols, ...embedLocalCols(this.table, parsed.embeds)])].map(ident).join(', ');
                const order = this._order.length ? ' ORDER BY ' + this._order.join(', ') : '';
                const limit = this._limit != null ? ` LIMIT ${this._limit}` : '';
                const offset = this._offset ? ` OFFSET ${this._offset}` : '';
                const res = await q(db, `SELECT ${cols} FROM ${ident(this.table)}${where}${order}${limit}${offset}`);
                data = res.rows;
                await resolveEmbeds(db, this.table, data, parsed.embeds);
            } else if (this._op === 'insert' || this._op === 'upsert') {
                data = await insertRows(db, this.table, this._payload, this._op === 'upsert' ? this._onConflict : null);
            } else if (this._op === 'update') {
                const sets = Object.entries(this._payload).map(([k, v]) => `${ident(k)} = ${lit(v)}`).join(', ');
                const res = await q(db, `UPDATE ${ident(this.table)} SET ${sets}${where} RETURNING *`);
                data = res.rows;
            } else if (this._op === 'delete') {
                const res = await q(db, `DELETE FROM ${ident(this.table)}${where} RETURNING *`);
                data = res.rows;
            }

            if (this._single) {
                if (data.length > 1) return { data: null, error: { message: 'multiple rows returned' } };
                if (data.length === 0) return this._single === 1
                    ? { data: null, error: { message: 'no rows returned', code: 'PGRST116' } }
                    : { data: null, error: null };
                return { data: data[0], count, error: null };
            }
            return { data, count, error: null };
        } catch (e) {
            console.error('[pglite-client]', e, this.table);
            return { data: null, error: { message: e.message } };
        }
    }
}

function sqlOp(op) { return { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', ilike: 'ILIKE' }[op] || '='; }

// PostgREST or: "a.eq.1,b.is.null,c.in.(1,2)"
function parseOr(expr) {
    return expr.split(',').map(part => {
        const [col, op, ...rest] = part.split('.');
        const raw = rest.join('.');
        if (op === 'is') return `${ident(col)} IS ${raw === 'null' ? 'NULL' : lit(raw)}`;
        if (op === 'in') { const arr = raw.replace(/^\(|\)$/g, '').split(',').map(s => isNaN(s) ? s : Number(s)); return `${ident(col)} = ANY(${lit(arr)})`; }
        const val = raw === 'null' ? null : (isNaN(raw) || raw === '' ? raw : Number(raw));
        return `${ident(col)} ${sqlOp(op)} ${lit(val)}`;
    }).join(' OR ');
}

async function insertRows(db, table, rows, onConflict) {
    if (!rows.length) return [];
    const keys = [...new Set(rows.flatMap(r => Object.keys(r)))];
    const values = rows.map(r => '(' + keys.map(k => lit(r[k] ?? null)).join(', ') + ')').join(', ');
    let sql = `INSERT INTO ${ident(table)} (${keys.map(ident).join(', ')}) VALUES ${values}`;
    if (onConflict) {
        const cc = onConflict.split(',').map(s => ident(s.trim())).join(', ');
        const upd = keys.map(k => `${ident(k)} = EXCLUDED.${ident(k)}`).join(', ');
        sql += ` ON CONFLICT (${cc}) DO UPDATE SET ${upd}`;
    }
    sql += ' RETURNING *';
    const res = await q(db, sql);
    return res.rows;
}

// Resuelve embeds belongs-to (la fila base tiene la FK). Un follow-up por embed.
async function resolveEmbeds(db, baseTable, rows, embeds) {
    if (!rows.length || !embeds.length) return;
    for (const emb of embeds) {
        const fk = emb.fkHint ? FK_BY_NAME.get(emb.fkHint) : pickFk(baseTable, emb.table);
        if (!fk) { rows.forEach(r => { r[emb.alias] = null; }); continue; }
        const localVals = [...new Set(rows.map(r => r[fk.localCol]).filter(v => v != null))];
        const subHasStar = emb.sub.cols.length === 0 || emb.sub.cols.includes('*');
        const subCols = subHasStar ? '*'
            : [...new Set([fk.foreignCol, ...emb.sub.cols, ...embedLocalCols(fk.foreignTable, emb.sub.embeds)])].map(ident).join(', ');
        let related = [];
        if (localVals.length) {
            const res = await q(db, `SELECT ${subCols} FROM ${ident(fk.foreignTable)} WHERE ${ident(fk.foreignCol)} = ANY(${lit(localVals)})`);
            related = res.rows;
            await resolveEmbeds(db, fk.foreignTable, related, emb.sub.embeds);
        }
        const byKey = new Map(related.map(r => [r[fk.foreignCol], r]));
        rows.forEach(r => { r[emb.alias] = byKey.get(r[fk.localCol]) ?? null; });
    }
}

// Columnas FK locales que necesitan los embeds de este nivel (para el JOIN).
function embedLocalCols(table, embeds) {
    const cols = [];
    for (const emb of embeds) {
        const fk = emb.fkHint ? FK_BY_NAME.get(emb.fkHint) : pickFk(table, emb.table);
        if (fk) cols.push(fk.localCol);
    }
    return cols;
}

function pickFk(localTable, foreignTable) {
    const fks = FK_BY_PAIR.get(`${localTable}|${foreignTable}`);
    return fks && fks.length === 1 ? fks[0] : (fks ? fks[0] : null);
}

// ── RPC → SELECT * FROM fn(args) ─────────────────────────────────────────────
async function rpc(fn, args = {}) {
    try {
        const db = await getDb();
        const params = Object.entries(args || {}).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ');
        const res = await q(db, `SELECT * FROM ${ident(fn)}(${params})`);
        return { data: res.rows, error: null };
    } catch (e) {
        console.error('[pglite-client rpc]', fn, e);
        return { data: null, error: { message: e.message } };
    }
}

export function createPgliteClient() {
    return {
        from: (table) => new Query(table),
        rpc,
        // stubs de auth (la app offline no usa login)
        auth: { getUser: async () => ({ data: { user: null }, error: null }), getSession: async () => ({ data: { session: null }, error: null }) },
    };
}

// Instancia PGlite cruda (misma singleton que usa el shim). Para ejecutar SQL
// directo — p.ej. aplicar el SQL que genera el motor de simulación en el
// navegador. Las escrituras persisten en IndexedDB y el shim las ve al instante.
export async function getPgliteDb() {
    return getDb();
}
