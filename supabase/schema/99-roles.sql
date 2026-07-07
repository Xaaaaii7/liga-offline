-- ============================================================================
-- Roles PostgREST para el motor local. No hay auth real ni multi-usuario
-- (instalación local de un solo jugador): web_anon tiene acceso amplio a
-- propósito, es el equivalente al "anon" de Supabase pero sin RLS detrás.
-- authenticator es el rol de conexión que usa PostgREST (db-uri); la
-- contraseña es local y sin valor de seguridad real (pglite-socket no
-- valida credenciales, solo importa que el puerto esté en 127.0.0.1).
-- ============================================================================

CREATE ROLE web_anon NOLOGIN;
GRANT USAGE ON SCHEMA public TO web_anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO web_anon;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO web_anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO web_anon;

CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'localdev';
GRANT web_anon TO authenticator;
