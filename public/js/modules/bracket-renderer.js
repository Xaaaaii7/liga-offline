/**
 * Módulo para renderizar brackets/cuadros eliminatorios
 * 
 * IMPORTANTE: No modifica la lógica existente
 * Solo proporciona funciones para renderizar brackets visualmente
 */

/**
 * Verifica si una ronda de copa está completa y genera la siguiente
 * @param {number} competitionId 
 * @param {number} matchId 
 * @param {number} cupRound 
 * @returns {Promise<void>}
 */
async function checkAndGenerateNextRoundFromBracket(competitionId, matchId, cupRound, bracketType = null) {
    try {
        const { getSupabaseClient } = await import('./supabase-client.js');
        const supabase = await getSupabaseClient();
        
        const payload = {
            competition_id: competitionId,
            match_id: matchId,
            cup_round: cupRound,
            round_type: 'cup',
            bracket_type: bracketType  // ✅ Añadido para doble eliminación
        };
        
        console.log('🎯 Verificando ronda completa tras penaltis:', payload);
        console.log('⚠️ Edge Function deshabilitada - Triggers SQL manejan todo');
        
        // ⚠️ EDGE FUNCTION DESHABILITADA
        // Los triggers SQL actualizan equipos automáticamente
        /*
        const { data, error } = await supabase.functions.invoke('check-and-generate-round', {
            body: payload
        });
        
        if (error) {
            console.error('❌ Error llamando Edge Function:', error);
            return;
        }
        
        console.log('✅ Respuesta Edge Function:', data);
        
        if (data?.roundGenerated) {
            console.log('🎉 Nueva ronda generada automáticamente:', data);
            showBracketNotification('✅ Nueva ronda generada automáticamente');
        }
        */
        
        console.log('✅ Triggers SQL han actualizado los equipos automáticamente');
    } catch (error) {
        console.error('❌ Error en checkAndGenerateNextRoundFromBracket:', error);
    }
}

/**
 * Muestra notificación en el bracket
 * @param {string} message 
 */
function showBracketNotification(message) {
    // Crear notificación temporal en el bracket
    const notification = document.createElement('div');
    notification.className = 'bracket-notification';
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => notification.classList.add('show'), 10);
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

/**
 * Actualiza has_penalties y penalties_winner_id en todos los partidos de una eliminatoria
 * @param {Array<number>} matchIds - IDs de todos los partidos de la eliminatoria
 * @param {boolean} hasPenalties - Si hubo penaltis o no
 * @param {number|null} penaltiesWinnerId - ID del equipo ganador de los penaltis (null si no hay penaltis)
 * @param {Object|null} competitionData - Datos de la competición para generar siguiente ronda {competitionId, cupRound, matchId}
 * @returns {Promise<void>}
 */
async function updateEliminatoriaPenalties(matchIds, hasPenalties, penaltiesWinnerId = null, competitionData = null) {
    if (!matchIds || matchIds.length === 0) {
        console.warn('⚠️ updateEliminatoriaPenalties: No se proporcionaron matchIds');
        return;
    }
    
    try {
        const { getSupabaseClient } = await import('./supabase-client.js');
        const supabase = await getSupabaseClient();
        
        const updateData = {
            has_penalties: hasPenalties,
            penalties_winner_id: hasPenalties ? penaltiesWinnerId : null
        };
        
        console.log('🔄 Actualizando penalties:', {
            matchIds,
            hasPenalties,
            penaltiesWinnerId,
            competitionId: competitionData?.competitionId
        });
        
        // SEGURIDAD: Si tenemos competitionId, verificar que los matches pertenecen a esa competición
        let query = supabase
            .from('matches')
            .update(updateData)
            .in('id', matchIds);
        
        // Añadir filtro de competition_id si está disponible (protección contra actualizaciones cruzadas)
        if (competitionData && competitionData.competitionId) {
            query = query.eq('competition_id', competitionData.competitionId);
            console.log('🔒 Filtro de seguridad aplicado: competition_id =', competitionData.competitionId);
        } else {
            console.warn('⚠️ Actualizando penalties sin filtro de competition_id (menos seguro)');
        }
        
        const { error } = await query;
        
        if (error) {
            console.error('❌ Error actualizando penaltis de eliminatoria:', error);
            throw error;
        }
        
        console.log('✅ Penalties actualizados correctamente para:', matchIds);
        
        // Si hay ganador de penaltis y datos de competición, generar siguiente ronda
        if (hasPenalties && penaltiesWinnerId && competitionData) {
            const { competitionId, cupRound, matchId } = competitionData;
            if (competitionId && cupRound && matchId) {
                await checkAndGenerateNextRoundFromBracket(competitionId, matchId, cupRound);
            }
        }
    } catch (error) {
        console.error('Error en updateEliminatoriaPenalties:', error);
        throw error;
    }
}

/**
 * Renderiza un bracket eliminatorio en un contenedor HTML
 * @param {HTMLElement} container - Contenedor donde renderizar
 * @param {Object} bracketData - Datos del bracket (de getCupBracket)
 * @param {Object} options - Opciones de renderizado
 * @returns {void}
 */
export function renderBracket(container, bracketData, options = {}) {
    if (!container || !bracketData) {
        console.error('Container o bracketData no proporcionado');
        return;
    }

    const {
        showScores = true,
        showDates = false,
        compact = false,
        totalTeams = null,
        competitionId = null,
        isDoubleElimination = false
    } = options;
    
    // Guardar competitionId en el contenedor para poder recargar después de actualizar penaltis
    if (competitionId) {
        container.dataset.competitionId = competitionId;
    }

    // Limpiar contenedor
    container.innerHTML = '';

    // ✨ DOBLE ELIMINACIÓN: Renderizar dos brackets separados
    if (isDoubleElimination) {
        const doubleElimEl = document.createElement('div');
        doubleElimEl.className = 'bracket-double-elimination';
        
        // Winner Bracket
        if (bracketData.winnerBracket) {
            const winnerSection = document.createElement('div');
            winnerSection.className = 'bracket-winner-bracket';
            
            const winnerTitle = document.createElement('h2');
            winnerTitle.className = 'bracket-section-title';
            winnerTitle.textContent = 'Cuadro principal';
            winnerSection.appendChild(winnerTitle);
            
            const winnerContainer = document.createElement('div');
            winnerContainer.className = 'bracket-container';
            if (competitionId) {
                winnerContainer.dataset.competitionId = competitionId;
            }
            
            // ✅ Renderizar TODAS las rondas del Winner Bracket (incluyendo la final)
            const allWinnerRounds = [];
            
            // Añadir rondas normales
            if (bracketData.winnerBracket.rounds && bracketData.winnerBracket.rounds.length > 0) {
                allWinnerRounds.push(...bracketData.winnerBracket.rounds);
            }
            
            // Añadir la final si existe (como una ronda más)
            if (bracketData.winnerBracket.final) {
                allWinnerRounds.push(bracketData.winnerBracket.final);
            }
            
            // Renderizar todas las rondas ordenadas por número de ronda
            allWinnerRounds.sort((a, b) => (a.round || 0) - (b.round || 0));
            
            allWinnerRounds.forEach((round, index) => {
                // Determinar si es la última ronda (final)
                const isLastRound = index === allWinnerRounds.length - 1 && 
                    round.matches?.some(m => m.is_cup_final || m.leg === 'final');
                
                if (isLastRound) {
                    // Renderizar como final del Winner Bracket
                    const finalEl = document.createElement('div');
                    finalEl.className = 'bracket-round bracket-final';
                    
                    const finalTitle = document.createElement('h3');
                    finalTitle.className = 'bracket-round-title bracket-final-title';
                    finalTitle.textContent = 'Final';
                    finalEl.appendChild(finalTitle);
                    
                    const matchesEl = document.createElement('div');
                    matchesEl.className = 'bracket-matches';
                    
                    round.matches?.forEach(match => {
                        const matchEl = renderMatch(match, showScores, showDates, true);
                        matchesEl.appendChild(matchEl);
                    });
                    
                    finalEl.appendChild(matchesEl);
                    winnerContainer.appendChild(finalEl);
                } else {
                    // Renderizar como ronda normal
                    const roundEl = renderRound(round, showScores, showDates, totalTeams, false);
                    winnerContainer.appendChild(roundEl);
                }
            });
            
            winnerSection.appendChild(winnerContainer);
            doubleElimEl.appendChild(winnerSection);
        }
        
        // Loser Bracket
        if (bracketData.loserBracket) {
            const loserSection = document.createElement('div');
            loserSection.className = 'bracket-loser-bracket';
            
            const loserTitle = document.createElement('h2');
            loserTitle.className = 'bracket-section-title';
            loserTitle.textContent = 'Cuadro de consolación (3º puesto)';
            loserSection.appendChild(loserTitle);
            
            const loserContainer = document.createElement('div');
            loserContainer.className = 'bracket-container';
            if (competitionId) {
                loserContainer.dataset.competitionId = competitionId;
            }
            
            // ✅ Renderizar TODAS las rondas del Loser Bracket (incluyendo la final)
            const allLoserRounds = [];
            
            // Añadir rondas normales
            if (bracketData.loserBracket.rounds && bracketData.loserBracket.rounds.length > 0) {
                allLoserRounds.push(...bracketData.loserBracket.rounds);
            }
            
            // Añadir la final si existe (como una ronda más)
            if (bracketData.loserBracket.final) {
                allLoserRounds.push(bracketData.loserBracket.final);
            }
            
            // Renderizar todas las rondas ordenadas por número de ronda
            allLoserRounds.sort((a, b) => (a.round || 0) - (b.round || 0));
            
            allLoserRounds.forEach((round, index) => {
                const isLastRound = index === allLoserRounds.length - 1;
                const isThirdPlaceMatch = round.matches?.some(m => m.is_third_place_match);

                if (isLastRound) {
                    const finalEl = document.createElement('div');
                    finalEl.className = 'bracket-round bracket-final';
                    const finalTitle = document.createElement('h3');
                    finalTitle.className = 'bracket-round-title bracket-final-title';
                    finalTitle.textContent = isThirdPlaceMatch
                        ? 'Partido por 3º y 4º puesto'
                        : 'Final (3º puesto)';
                    finalEl.appendChild(finalTitle);
                    
                    const matchesEl = document.createElement('div');
                    matchesEl.className = 'bracket-matches';
                    
                    round.matches?.forEach(match => {
                        const matchEl = renderMatch(match, showScores, showDates, true);
                        matchesEl.appendChild(matchEl);
                    });
                    
                    finalEl.appendChild(matchesEl);
                    loserContainer.appendChild(finalEl);
                } else {
                    // Renderizar como ronda normal del Loser Bracket
                    const roundEl = renderRound(round, showScores, showDates, null, true);
                    loserContainer.appendChild(roundEl);
                }
            });
            
            loserSection.appendChild(loserContainer);
            doubleElimEl.appendChild(loserSection);
        }
        
        container.appendChild(doubleElimEl);
        return;
    }

    // Copa normal (sin doble eliminación)
    const bracketEl = document.createElement('div');
    bracketEl.className = `bracket-container ${compact ? 'bracket-compact' : ''}`;
    if (competitionId) {
        bracketEl.dataset.competitionId = competitionId;
    }

    // Renderizar rondas
    if (bracketData.rounds && bracketData.rounds.length > 0) {
        bracketData.rounds.forEach(round => {
            const roundEl = renderRound(round, showScores, showDates, totalTeams);
            bracketEl.appendChild(roundEl);
        });
    }

    // Renderizar final
    if (bracketData.final) {
        const finalEl = renderFinal(bracketData.final, showScores, showDates);
        bracketEl.appendChild(finalEl);
    }

    // Renderizar partido del tercer puesto
    if (bracketData.thirdPlace) {
        const thirdPlaceEl = renderThirdPlace(bracketData.thirdPlace, showScores, showDates);
        bracketEl.appendChild(thirdPlaceEl);
    }

    container.appendChild(bracketEl);
}

/**
 * Renderiza una ronda del bracket
 * @param {Object} round - Datos de la ronda
 * @param {boolean} showScores
 * @param {boolean} showDates
 * @param {number} totalTeams - Número total de equipos (opcional)
 * @param {boolean} isLoserBracket - Si es ronda del Loser Bracket
 * @returns {HTMLElement}
 */
function renderRound(round, showScores, showDates, totalTeams = null, isLoserBracket = false) {
    const roundEl = document.createElement('div');
    roundEl.className = 'bracket-round';

    const roundTitle = document.createElement('h3');
    roundTitle.className = 'bracket-round-title';
    const numMatches = round.matches ? round.matches.length : 0;
    roundTitle.textContent = getRoundName(round.round, numMatches, totalTeams, isLoserBracket);
    roundEl.appendChild(roundTitle);

    const matchesEl = document.createElement('div');
    matchesEl.className = 'bracket-matches';

    round.matches.forEach(match => {
        const matchEl = renderMatch(match, showScores, showDates, false);
        matchesEl.appendChild(matchEl);
    });

    roundEl.appendChild(matchesEl);
    return roundEl;
}

/**
 * Renderiza la final
 * @param {Object} final - Datos de la final
 * @param {boolean} showScores
 * @param {boolean} showDates
 * @returns {HTMLElement}
 */
function renderFinal(final, showScores, showDates) {
    const finalEl = document.createElement('div');
    finalEl.className = 'bracket-round bracket-final';

    const finalTitle = document.createElement('h3');
    finalTitle.className = 'bracket-round-title bracket-final-title';
    finalTitle.textContent = 'Final';
    finalEl.appendChild(finalTitle);

    const matchesEl = document.createElement('div');
    matchesEl.className = 'bracket-matches';

    final.matches.forEach(match => {
        const matchEl = renderMatch(match, showScores, showDates, true);
        matchesEl.appendChild(matchEl);
    });

    finalEl.appendChild(matchesEl);
    return finalEl;
}

/**
 * Renderiza el partido del tercer puesto
 * @param {Object} thirdPlace - Datos del partido del tercer puesto
 * @param {boolean} showScores
 * @param {boolean} showDates
 * @returns {HTMLElement}
 */
function renderThirdPlace(thirdPlace, showScores, showDates) {
    const thirdPlaceEl = document.createElement('div');
    thirdPlaceEl.className = 'bracket-round bracket-third-place';

    const thirdPlaceTitle = document.createElement('h3');
    thirdPlaceTitle.className = 'bracket-round-title bracket-third-place-title';
    thirdPlaceTitle.textContent = 'Tercer Puesto';
    thirdPlaceEl.appendChild(thirdPlaceTitle);

    const matchesEl = document.createElement('div');
    matchesEl.className = 'bracket-matches';

    const match = thirdPlace.match;
    const matchEl = renderMatch(match, showScores, showDates, false);
    matchesEl.appendChild(matchEl);

    thirdPlaceEl.appendChild(matchesEl);
    return thirdPlaceEl;
}

/**
 * Calcula el ganador de un doble partido (ida y vuelta)
 * @param {Array} allLegs - Array con los partidos de ida y vuelta
 * @param {number} homeTeamId - ID del equipo local del primer partido
 * @param {number} awayTeamId - ID del equipo visitante del primer partido
 * @returns {Object} - { winner: teamId | null, totalHome: number, totalAway: number }
 */
function calculateTwoLeggedWinner(allLegs, homeTeamId, awayTeamId) {
    if (!allLegs || allLegs.length < 2) {
        return { winner: null, totalHome: 0, totalAway: 0 };
    }

    // Encontrar partido de ida y vuelta
    const ida = allLegs.find(m => m.cup_leg === 'first');
    const vuelta = allLegs.find(m => m.cup_leg === 'second');

    if (!ida || !vuelta) {
        return { winner: null, totalHome: 0, totalAway: 0 };
    }

    // Verificar que ambos partidos estén jugados
    if (ida.home_goals === null || ida.away_goals === null ||
        vuelta.home_goals === null || vuelta.away_goals === null) {
        return { winner: null, totalHome: 0, totalAway: 0 };
    }

    // Calcular marcador agregado desde la perspectiva del equipo local del primer partido
    // En la ida: home_goals del equipo local, away_goals del equipo visitante
    // En la vuelta: se invierten los equipos, así que away_goals del equipo local, home_goals del equipo visitante
    const totalHome = ida.home_goals + vuelta.away_goals;
    const totalAway = ida.away_goals + vuelta.home_goals;

    let winner = null;
    if (totalHome > totalAway) {
        winner = homeTeamId;
    } else if (totalAway > totalHome) {
        winner = awayTeamId;
    } else {
        // Empate en marcador agregado: gana el que tiene más goles fuera de casa
        const awayGoalsHome = ida.away_goals; // Goles del equipo local fuera de casa
        const awayGoalsAway = vuelta.away_goals; // Goles del equipo visitante fuera de casa
        
        if (awayGoalsHome > awayGoalsAway) {
            winner = homeTeamId;
        } else if (awayGoalsAway > awayGoalsHome) {
            winner = awayTeamId;
        } else {
            // Empate total: usar el ganador del segundo partido (vuelta)
            if (vuelta.home_goals > vuelta.away_goals) {
                winner = vuelta.home_league_team_id;
            } else if (vuelta.away_goals > vuelta.home_goals) {
                winner = vuelta.away_league_team_id;
            }
        }
    }

    return { winner, totalHome, totalAway };
}

/**
 * Renderiza un partido individual
 * @param {Object} match - Datos del partido
 * @param {boolean} showScores
 * @param {boolean} showDates
 * @param {boolean} isFinal
 * @returns {HTMLElement}
 */
function renderMatch(match, showScores, showDates, isFinal) {
    const matchEl = document.createElement('div');
    const isPlaceholder = match.placeholder === true;
    matchEl.className = `bracket-match ${isFinal ? 'bracket-match-final' : ''} ${isPlaceholder ? 'bracket-match-placeholder' : ''}`;

    const homeTeam = match.home_team || { nickname: 'TBD', display_name: 'Por determinar' };
    const awayTeam = match.away_team || { nickname: 'TBD', display_name: 'Por determinar' };

    const homeName = homeTeam.display_name || homeTeam.nickname || 'TBD';
    const awayName = awayTeam.display_name || awayTeam.nickname || 'TBD';

    // Añadir etiqueta de eliminatoria si está disponible
    const eliminatoriaLabel = match.eliminatoria_number 
        ? `<div class="bracket-eliminatoria-label">Eliminatoria ${match.eliminatoria_number}</div>` 
        : '';

    // Verificar si hay doble partido (ida y vuelta)
    const hasTwoLegs = match.all_legs && match.all_legs.length >= 2;
    
    let matchHTML = eliminatoriaLabel;

    if (hasTwoLegs) {
        // Renderizar doble partido (ida y vuelta)
        const ida = match.all_legs.find(m => m.cup_leg === 'first');
        const vuelta = match.all_legs.find(m => m.cup_leg === 'second');

        if (ida && vuelta) {
            // Calcular ganador del doble partido
            const homeTeamId = ida.home_league_team_id;
            const awayTeamId = ida.away_league_team_id;
            const twoLeggedResult = calculateTwoLeggedWinner(match.all_legs, homeTeamId, awayTeamId);

            // Obtener nombres de equipos desde los partidos
            const idaHomeTeam = ida.home || { nickname: 'TBD', display_name: 'Por determinar' };
            const idaAwayTeam = ida.away || { nickname: 'TBD', display_name: 'Por determinar' };
            const vueltaHomeTeam = vuelta.home || { nickname: 'TBD', display_name: 'Por determinar' };
            const vueltaAwayTeam = vuelta.away || { nickname: 'TBD', display_name: 'Por determinar' };

            const idaHomeName = idaHomeTeam.display_name || idaHomeTeam.nickname || 'TBD';
            const idaAwayName = idaAwayTeam.display_name || idaAwayTeam.nickname || 'TBD';
            const vueltaHomeName = vueltaHomeTeam.display_name || vueltaHomeTeam.nickname || 'TBD';
            const vueltaAwayName = vueltaAwayTeam.display_name || vueltaAwayTeam.nickname || 'TBD';

            const idaHomeScore = ida.home_goals !== null ? ida.home_goals : '-';
            const idaAwayScore = ida.away_goals !== null ? ida.away_goals : '-';
            const vueltaHomeScore = vuelta.home_goals !== null ? vuelta.home_goals : '-';
            const vueltaAwayScore = vuelta.away_goals !== null ? vuelta.away_goals : '-';

            // Determinar ganador para resaltar
            const homeWon = twoLeggedResult.winner === homeTeamId;
            const awayWon = twoLeggedResult.winner === awayTeamId;

            // Determinar si hay empate (para mostrar opción de penaltis)
            const isTied = twoLeggedResult.totalHome === twoLeggedResult.totalAway;
            
            // Mostrar ambos partidos
            matchHTML += `
                <div class="bracket-two-legged">
                    <div class="bracket-leg-match">
                        <div class="bracket-leg-label">Ida</div>
                        <div class="bracket-team ${homeWon && showScores ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                            <span class="bracket-team-name">${escapeHtml(idaHomeName)}</span>
                            ${showScores && !isPlaceholder ? `<span class="bracket-score">${idaHomeScore}</span>` : ''}
                        </div>
                        <div class="bracket-team ${awayWon && showScores ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                            <span class="bracket-team-name">${escapeHtml(idaAwayName)}</span>
                            ${showScores && !isPlaceholder ? `<span class="bracket-score">${idaAwayScore}</span>` : ''}
                        </div>
                    </div>
                    <div class="bracket-leg-match">
                        <div class="bracket-leg-label">Vuelta</div>
                        <div class="bracket-team ${awayWon && showScores ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                            <span class="bracket-team-name">${escapeHtml(vueltaHomeName)}</span>
                            ${showScores && !isPlaceholder ? `<span class="bracket-score">${vueltaHomeScore}</span>` : ''}
                        </div>
                        <div class="bracket-team ${homeWon && showScores ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                            <span class="bracket-team-name">${escapeHtml(vueltaAwayName)}</span>
                            ${showScores && !isPlaceholder ? `<span class="bracket-score">${vueltaAwayScore}</span>` : ''}
                        </div>
                    </div>
                    ${showScores && twoLeggedResult.totalHome !== 0 && twoLeggedResult.totalAway !== 0 ? `
                        <div class="bracket-aggregate">
                            <span class="bracket-aggregate-label">Total:</span>
                            <span class="bracket-aggregate-score">${twoLeggedResult.totalHome} - ${twoLeggedResult.totalAway}</span>
                            ${isTied && match.penalties_enabled !== false ? `
                                <div class="bracket-penalties-control" 
                                     data-eliminatoria-ids="${match.eliminatoria_match_ids ? match.eliminatoria_match_ids.join(',') : ''}"
                                     data-home-team-id="${match.home_team_id || ''}"
                                     data-away-team-id="${match.away_team_id || ''}"
                                     data-home-team-name="${escapeHtml((match.home_team?.display_name || match.home_team?.nickname || 'Equipo Local'))}"
                                     data-away-team-name="${escapeHtml((match.away_team?.display_name || match.away_team?.nickname || 'Equipo Visitante'))}">
                                    <label class="bracket-penalties-label">
                                        <input type="checkbox" class="bracket-penalties-checkbox" ${match.has_penalties ? 'checked' : ''} />
                                        <span>Resuelto por penaltis</span>
                                    </label>
                                    ${match.has_penalties ? `
                                        <div class="bracket-penalties-winner">
                                            <label class="bracket-penalties-winner-label">
                                                <span>Ganador:</span>
                                                <select class="bracket-penalties-winner-select">
                                                    <option value="">Selecciona ganador</option>
                                                    <option value="${match.home_team_id}" ${match.penalties_winner_id === match.home_team_id ? 'selected' : ''}>
                                                        ${escapeHtml((match.home_team?.display_name || match.home_team?.nickname || 'Equipo Local'))}
                                                    </option>
                                                    <option value="${match.away_team_id}" ${match.penalties_winner_id === match.away_team_id ? 'selected' : ''}>
                                                        ${escapeHtml((match.away_team?.display_name || match.away_team?.nickname || 'Equipo Visitante'))}
                                                    </option>
                                                </select>
                                            </label>
                                            ${match.penalties_winner ? `
                                                <div class="bracket-penalties-winner-badge">
                                                    🏆 Ganador: ${escapeHtml((match.penalties_winner.display_name || match.penalties_winner.nickname || 'Ganador'))}
                                                </div>
                                            ` : ''}
                                        </div>
                                    ` : ''}
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}
                </div>
            `;
        } else {
            // Fallback si no se encuentran ambos partidos
            const homeScore = match.home_goals !== null ? match.home_goals : '-';
            const awayScore = match.away_goals !== null ? match.away_goals : '-';
            const isPlayed = match.home_goals !== null && match.away_goals !== null;
            const homeWon = isPlayed && match.home_goals > match.away_goals;
            const awayWon = isPlayed && match.away_goals > match.home_goals;

            matchHTML += `
                <div class="bracket-team ${homeWon ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                    <span class="bracket-team-name">${escapeHtml(homeName)}</span>
                    ${showScores && !isPlaceholder ? `<span class="bracket-score">${homeScore}</span>` : ''}
                </div>
                <div class="bracket-team ${awayWon ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                    <span class="bracket-team-name">${escapeHtml(awayName)}</span>
                    ${showScores && !isPlaceholder ? `<span class="bracket-score">${awayScore}</span>` : ''}
                </div>
                ${match.leg ? `<div class="bracket-leg">${match.leg === 'first' ? 'Ida' : match.leg === 'second' ? 'Vuelta' : 'Final'}</div>` : ''}
            `;
        }
    } else {
        // Partido único (sin doble partido)
        const homeScore = match.home_goals !== null ? match.home_goals : '-';
        const awayScore = match.away_goals !== null ? match.away_goals : '-';

        const isPlayed = match.home_goals !== null && match.away_goals !== null;
        const homeWon = isPlayed && match.home_goals > match.away_goals;
        const awayWon = isPlayed && match.away_goals > match.home_goals;
        const isTied = isPlayed && match.home_goals === match.away_goals;

        matchHTML += `
            <div class="bracket-team ${homeWon ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                <span class="bracket-team-name">${escapeHtml(homeName)}</span>
                ${showScores && !isPlaceholder ? `<span class="bracket-score">${homeScore}</span>` : ''}
            </div>
            <div class="bracket-team ${awayWon ? 'bracket-winner' : ''} ${isPlaceholder ? 'bracket-team-placeholder' : ''}">
                <span class="bracket-team-name">${escapeHtml(awayName)}</span>
                ${showScores && !isPlaceholder ? `<span class="bracket-score">${awayScore}</span>` : ''}
            </div>
            ${match.leg ? `<div class="bracket-leg">${match.leg === 'first' ? 'Ida' : match.leg === 'second' ? 'Vuelta' : 'Final'}</div>` : ''}
            ${isTied && showScores && !isPlaceholder && match.penalties_enabled !== false ? `
                <div class="bracket-penalties-control" 
                     data-eliminatoria-ids="${match.eliminatoria_match_ids ? match.eliminatoria_match_ids.join(',') : match.id}"
                     data-home-team-id="${match.home_team_id || ''}"
                     data-away-team-id="${match.away_team_id || ''}"
                     data-home-team-name="${escapeHtml((homeTeam.display_name || homeTeam.nickname || 'Equipo Local'))}"
                     data-away-team-name="${escapeHtml((awayTeam.display_name || awayTeam.nickname || 'Equipo Visitante'))}">
                    <label class="bracket-penalties-label">
                        <input type="checkbox" class="bracket-penalties-checkbox" ${match.has_penalties ? 'checked' : ''} />
                        <span>Resuelto por penaltis</span>
                    </label>
                    ${match.has_penalties ? `
                        <div class="bracket-penalties-winner">
                            <label class="bracket-penalties-winner-label">
                                <span>Ganador:</span>
                                <select class="bracket-penalties-winner-select">
                                    <option value="">Selecciona ganador</option>
                                    <option value="${match.home_team_id}" ${match.penalties_winner_id === match.home_team_id ? 'selected' : ''}>
                                        ${escapeHtml((homeTeam.display_name || homeTeam.nickname || 'Equipo Local'))}
                                    </option>
                                    <option value="${match.away_team_id}" ${match.penalties_winner_id === match.away_team_id ? 'selected' : ''}>
                                        ${escapeHtml((awayTeam.display_name || awayTeam.nickname || 'Equipo Visitante'))}
                                    </option>
                                </select>
                            </label>
                            ${match.penalties_winner ? `
                                <div class="bracket-penalties-winner-badge">
                                    🏆 Ganador: ${escapeHtml((match.penalties_winner.display_name || match.penalties_winner.nickname || 'Ganador'))}
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}
                </div>
            ` : ''}
        `;
    }

    matchEl.innerHTML = matchHTML;

    if (match.id) {
        matchEl.setAttribute('data-match-id', match.id);
        matchEl.classList.add('bracket-match-clickable');
    }

    // Añadir listeners para checkbox y selector de penaltis si existe (solo cuando hay empate)
    const penaltiesControl = matchEl.querySelector('.bracket-penalties-control');
    const penaltiesCheckbox = matchEl.querySelector('.bracket-penalties-checkbox');
    const penaltiesWinnerSelect = matchEl.querySelector('.bracket-penalties-winner-select');
    
    if (penaltiesControl && penaltiesCheckbox && match.is_tied) {
        // Obtener IDs de partidos de la eliminatoria (puede ser array o un solo ID)
        const eliminatoriaIds = match.eliminatoria_match_ids || (match.id ? [match.id] : []);
        const homeTeamId = penaltiesControl.dataset.homeTeamId;
        const awayTeamId = penaltiesControl.dataset.awayTeamId;
        
        // Listener para checkbox de penaltis
        penaltiesCheckbox.addEventListener('change', async (e) => {
            const hasPenalties = e.target.checked;
            const penaltiesWinnerDiv = penaltiesControl.querySelector('.bracket-penalties-winner');
            
            try {
                // Mostrar/ocultar selector dinámicamente
                if (hasPenalties && !penaltiesWinnerDiv) {
                    // Crear el selector de ganador si no existe
                    const homeTeamName = penaltiesControl.dataset.homeTeamName || 'Equipo Local';
                    const awayTeamName = penaltiesControl.dataset.awayTeamName || 'Equipo Visitante';
                    const currentWinnerId = match.penalties_winner_id || '';
                    
                    const winnerDiv = document.createElement('div');
                    winnerDiv.className = 'bracket-penalties-winner';
                    winnerDiv.innerHTML = `
                        <label class="bracket-penalties-winner-label">
                            <span>Ganador:</span>
                            <select class="bracket-penalties-winner-select">
                                <option value="">Selecciona ganador</option>
                                <option value="${homeTeamId}" ${currentWinnerId === homeTeamId ? 'selected' : ''}>
                                    ${escapeHtml(homeTeamName)}
                                </option>
                                <option value="${awayTeamId}" ${currentWinnerId === awayTeamId ? 'selected' : ''}>
                                    ${escapeHtml(awayTeamName)}
                                </option>
                            </select>
                        </label>
                    `;
                    penaltiesControl.appendChild(winnerDiv);
                    
                    // Añadir listener al nuevo selector
                    const newSelect = winnerDiv.querySelector('.bracket-penalties-winner-select');
                    if (newSelect) {
                        newSelect.addEventListener('change', async (selectEvent) => {
                            const winnerId = selectEvent.target.value ? parseInt(selectEvent.target.value) : null;
                            if (!winnerId) return;
                            
                            try {
                                // Obtener datos de competición del contenedor
                                const container = matchEl.closest('.bracket-container');
                                const competitionId = container?.dataset?.competitionId;
                                const cupRound = match.cup_round || match.round;
                                const matchId = match.id;
                                
                                const competitionData = competitionId ? { 
                                    competitionId: parseInt(competitionId), 
                                    cupRound, 
                                    matchId 
                                } : null;
                                
                                await updateEliminatoriaPenalties(eliminatoriaIds, true, winnerId, competitionData);
                                await reloadBracket(matchEl);
                            } catch (error) {
                                console.error('Error actualizando ganador de penaltis:', error);
                                alert('Error al actualizar el ganador de los penaltis. Por favor, intenta de nuevo.');
                            }
                        });
                    }
                } else if (!hasPenalties && penaltiesWinnerDiv) {
                    // Ocultar selector si se desmarca
                    penaltiesWinnerDiv.remove();
                }
                
                // Si se desmarca, limpiar también el ganador
                const winnerId = hasPenalties ? null : null;
                await updateEliminatoriaPenalties(eliminatoriaIds, hasPenalties, winnerId);
                
                // Solo recargar si se desmarcó o si ya había un ganador seleccionado
                if (!hasPenalties || (hasPenalties && match.penalties_winner_id)) {
                    await reloadBracket(matchEl);
                }
            } catch (error) {
                console.error('Error actualizando penaltis:', error);
                // Revertir el checkbox si hay error
                e.target.checked = !hasPenalties;
                alert('Error al actualizar los penaltis. Por favor, intenta de nuevo.');
            }
        });
        
        // Listener para selector de ganador de penaltis
        if (penaltiesWinnerSelect) {
            penaltiesWinnerSelect.addEventListener('change', async (e) => {
                const winnerId = e.target.value ? parseInt(e.target.value) : null;
                if (!winnerId) return; // No hacer nada si no hay selección
                
                try {
                    // Obtener datos de competición del contenedor
                    const container = matchEl.closest('.bracket-container');
                    const competitionId = container?.dataset?.competitionId;
                    const cupRound = match.cup_round || match.round;
                    const matchId = match.id;
                    
                    const competitionData = competitionId ? { 
                        competitionId: parseInt(competitionId), 
                        cupRound, 
                        matchId 
                    } : null;
                    
                    await updateEliminatoriaPenalties(eliminatoriaIds, true, winnerId, competitionData);
                    // Recargar el bracket para reflejar los cambios
                    await reloadBracket(matchEl);
                } catch (error) {
                    console.error('Error actualizando ganador de penaltis:', error);
                    alert('Error al actualizar el ganador de los penaltis. Por favor, intenta de nuevo.');
                }
            });
        }
    }

    return matchEl;
}

/**
 * Recarga el bracket después de actualizar penaltis
 * @param {HTMLElement} matchEl - Elemento del partido
 * @returns {Promise<void>}
 */
async function reloadBracket(matchEl) {
    const container = matchEl.closest('.bracket-container');
    if (container && container.dataset.competitionId) {
        const competitionId = container.dataset.competitionId;
        const { getCompetitionStandings } = await import('./competition-standings.js');
        const standings = await getCompetitionStandings(competitionId);
        if (standings.type === 'cup' && standings.data.bracket) {
            container.innerHTML = '';
            renderBracket(container, standings.data.bracket, {
                showScores: true,
                totalTeams: standings.data.totalTeams || null,
                competitionId: competitionId
            });
        }
    }
}

/**
 * Obtiene el nombre de la ronda según el número de partidos de la ronda.
 * Si numMatches no está disponible, cae a "Ronda N".
 * El Loser Bracket conserva "Ronda N (Perdedores)" porque los mapeos de
 * octavos/cuartos no aplican igual ahí.
 * @param {number} roundNumber - Número de ronda (1 = primera ronda)
 * @param {number} numMatches - Número de partidos en esta ronda
 * @param {number} totalTeams - Número total de equipos en la competición (no usado)
 * @param {boolean} isLoserBracket - Si es ronda del Loser Bracket
 * @returns {string}
 */
function getRoundName(roundNumber, numMatches = null, totalTeams = null, isLoserBracket = false) {
    if (isLoserBracket) {
        return `Ronda ${roundNumber} (Perdedores)`;
    }

    // Nombres por número de partidos de la ronda actual
    if (numMatches === 1) return 'Final';
    if (numMatches === 2) return 'Semifinales';
    if (numMatches === 4) return 'Cuartos de final';
    if (numMatches === 8) return 'Octavos de final';
    if (numMatches === 16) return 'Dieciseisavos de final';
    if (numMatches === 32) return 'Treintaidosavos';

    return `Ronda ${roundNumber}`;
}

/**
 * Escapa HTML
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

