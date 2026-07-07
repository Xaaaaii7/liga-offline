// Generar alineación automáticamente desde "4-4-2"
export function genAlineacionFromEsquema(esquema) {
    const [def, mid, fwd] = (esquema || '4-4-2').split('-').map(n => parseInt(n, 10) || 0);

    const fila = (n, row, pref) =>
        Array.from({ length: n }, (_, i) => ({
            slot: `${pref}${i + 1}`,
            posicion: pref === 'POR' ? 'POR' : pref,
            fila: row,
            col: i + 1
        }));

    return [
        ...fila(fwd, 2, 'DEL'),
        ...fila(mid, 3, 'MED'),
        ...fila(def, 4, 'DEF'),
        { slot: 'POR1', posicion: 'POR', fila: 5, col: 3 }
    ];
}

// Resolver nombre de equipo
export function teamNameFromObj(teamObj = {}, fallbackId = null, teamMap = null) {
    let name =
        teamObj.nickname ||
        teamObj.display_name ||
        (teamObj.club && teamObj.club.name);

    if (!name && fallbackId != null && teamMap && teamMap.has(fallbackId)) {
        const fromMap = teamMap.get(fallbackId);
        name =
            fromMap.nickname ||
            fromMap.display_name ||
            (fromMap.club && fromMap.club.name);
    }

    const fallbackLabel = fallbackId != null ? `Equipo ${fallbackId}` : 'Equipo';
    return (name || fallbackLabel).toString().trim();
}
