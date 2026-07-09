-- Marca qué league_teams están controlados por un jugador humano local
-- (el resto se resuelven con scripts/simulate-match.js). Se decide al
-- configurar la competición (configurar-competicion.html), no es fija.
ALTER TABLE league_teams ADD COLUMN is_human_controlled boolean NOT NULL DEFAULT false;
