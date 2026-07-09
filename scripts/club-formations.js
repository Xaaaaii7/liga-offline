// Sistema táctico real (aprox. temporadas ~2024-26) de cada club, de entre las
// 8 plantillas disponibles en FORMATION_TEMPLATES:
//   '4-4-2' · '4-3-3' · '4-5-1' · '3-5-2' · '4-2-3-1' · '3-4-3' · '4-1-4-1' · '5-3-2'
//
// Se usa como DEFAULT para equipos IA sin formación configurada en la tabla
// `formations`. Precedencia en simulate-match.js:
//   formations.system (configurado por el usuario)  →  este seed  →
//   inferido de la plantilla  →  '4-3-3'.
//
// Orientativo (los sistemas reales cambian de temporada); la UI de configurar
// competición puede sobreescribirlo por equipo. Clave = clubs.id.
export const CLUB_FORMATIONS = {
  // ── España ──
  77: '4-4-2',    // Athletic Club (Valverde)
  78: '4-4-2',    // Atlético de Madrid (Simeone)
  92: '4-3-3',    // Real Sociedad
  94: '4-4-2',    // Villarreal (Marcelino)
  90: '4-2-3-1',  // Real Betis (Pellegrini)
  // ── Italia ──
  98: '4-2-3-1',  // AC Milan
  100: '3-5-2',   // AS Roma
  102: '3-4-3',   // Atalanta (Gasperini, 3-4-1-2)
  108: '3-5-2',   // Inter (Inzaghi)
  109: '4-3-3',   // Juventus
  113: '4-3-3',   // Napoli
  // ── Alemania ──
  3: '3-4-3',     // Bayer Leverkusen (Xabi Alonso, 3-4-2-1)
  4: '4-2-3-1',   // Borussia Dortmund
  // ── Inglaterra ──
  58: '4-2-3-1',  // Aston Villa (Emery)
  61: '4-2-3-1',  // Chelsea (Maresca)
  354: '3-4-3',   // Crystal Palace (Glasner, 3-4-2-1)
  62: '4-1-4-1',  // Everton (defensivo)
  63: '4-2-3-1',  // Fulham
  64: '4-3-3',    // Liverpool
  65: '4-3-3',    // Manchester City
  66: '3-4-3',    // Manchester United (Amorim, 3-4-2-1)
  67: '4-3-3',    // Newcastle
  351: '4-2-3-1', // Nottingham Forest
  73: '4-3-3',    // Tottenham
  // ── Francia ──
  548: '4-2-3-1', // AS Monaco
  516: '3-4-3',   // Olympique de Marseille (De Zerbi, 3-4-2-1)
  546: '3-5-2',   // RC Lens
  // ── Portugal ──
  503: '4-3-3',   // FC Porto
  1903: '4-2-3-1',// Benfica
  // ── Países Bajos ──
  674: '4-3-3',   // PSV
  // ── Turquía ──
  10000611: '4-2-3-1', // Fenerbahçe (Mourinho)
  610: '4-2-3-1', // Galatasaray
};
