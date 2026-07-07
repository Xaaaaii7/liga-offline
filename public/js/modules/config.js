// ─────────────────────────────
// CONFIGURACIÓN — motor local (PGlite + PostgREST), no Supabase cloud.
// ─────────────────────────────
// El anonKey es un JWT firmado con el secreto local fijo de `server.mjs`
// (rol `web_anon`, sin `exp`). No protege nada sensible: la app corre en
// 127.0.0.1 de la propia máquina, no hay multi-tenant que aislar.
export const SUPABASE_CONFIG = {
    url: "http://127.0.0.1:8080",
    anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoid2ViX2Fub24ifQ.CkV382t7nrL7ZEEI8ANk1fd8c_Ebljnt3u83XqrHTbw",
    season: "2026-27"
};
