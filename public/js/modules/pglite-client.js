// Cliente compatible (subconjunto) con la API de supabase-js, pero sobre PGlite
// corriendo EN EL NAVEGADOR — sin PostgREST ni backend Node. Traduce
// .from(t).select().eq()… a SQL, resuelve embeds (foo:table!fk(cols)) como
// consultas follow-up, y pasa .rpc(fn, args) a SELECT * FROM fn(...).
//
// Objetivo: que getSupabaseClient() pueda devolver ESTO y los ~52 ficheros de la
// app funcionen sin cambios. Cubre lo que la app usa; se extiende según haga falta.

import { PGlite } from '../../vendor/pglite/index.js';

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
        // ¿la BD ya está poblada? (existe el catálogo con filas)
        const hasCatalog = async (db) => {
            try { return (await db.query('select count(*)::int c from clubs')).rows[0].c > 0; }
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
        try {
            // 1) intentar abrir la BD persistida
            let db = new PGlite(IDB);
            await db.waitReady;
            if (await hasCatalog(db)) { await loadFkMeta(db); return db; }
            // 2) vacía o sin esquema (1er arranque, o una carga previa que falló):
            //    cerrar, borrar y recargar desde el seed
            try { await db.close(); } catch { /* noop */ }
            await deletePgliteIdb();
            db = new PGlite(IDB, { loadDataDir: await fetchSeed() });
            await db.waitReady;
            if (!(await hasCatalog(db))) {
                throw new Error('El seed cargó pero el catálogo sigue vacío (clubs=0). ¿Seed corrupto?');
            }
            await loadFkMeta(db);
            return db;
        } catch (e) {
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
async function loadFkMeta(db) {
    const { rows } = await q(db, `
        select tc.constraint_name, kcu.table_name local_table, kcu.column_name local_col,
               ccu.table_name foreign_table, ccu.column_name foreign_col
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
        join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
        where tc.constraint_type = 'FOREIGN KEY'`);
    FK_BY_NAME = new Map();
    FK_BY_PAIR = new Map();
    for (const r of rows) {
        const fk = { localTable: r.local_table, localCol: r.local_col, foreignTable: r.foreign_table, foreignCol: r.foreign_col };
        FK_BY_NAME.set(r.constraint_name, fk);
        const pair = `${r.local_table}|${r.foreign_table}`;
        if (!FK_BY_PAIR.has(pair)) FK_BY_PAIR.set(pair, []);
        FK_BY_PAIR.get(pair).push(fk);
    }
    const pk = await q(db, `
        select tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
        where tc.constraint_type = 'PRIMARY KEY'`);
    PK_BY_TABLE = new Map(pk.rows.map(r => [r.table_name, r.column_name]));
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
async function q(db, sql) {
    const res = await db.query(sql);
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
