/*
 * Pokelike Companion: módulo de caça a shiny/aurora (auto-reroll opcional).
 * Encaixa no núcleo pela API window.__pkc (src/companion.js).
 */
(() => {
  'use strict';
  const start = api => {
  const { cfg, L, esc, pct, S, fn, sleep, waitFor, blocked, screenId, shinyOdds, currentCatchInstances, highlightCatchCards, dexes, inDex } = api;
  const render = () => api.render();

  const STATS_KEY = 'pkc:huntlog';
  let huntLog = [];
  try { huntLog = JSON.parse(localStorage.getItem(STATS_KEY) || '[]'); } catch { huntLog = []; }
  const saveLog = () => { try { localStorage.setItem(STATS_KEY, JSON.stringify(huntLog.slice(-50))); } catch { /* ignore */ } };

  const hunt = { confirmedReset: false, running: false, attempts: 0, t0: 0, msg: '', lastSeen: '', found: null };

  function speciesList() {
    return cfg.huntSpecies.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  }

  function isHit(inst) {
    if (!inst) return false;
    if (cfg.huntTarget === 'aurora') return !!inst.isAurora;
    if (cfg.huntTarget === 'newshiny') {
      const d = dexes();
      if (inst.isAurora) return !inDex(d.aurora, inst.speciesId) || !inDex(d.shiny, inst.speciesId);
      return !!inst.isShiny && !inDex(d.shiny, inst.speciesId);
    }
    if (cfg.huntTarget === 'species') {
      const list = speciesList();
      const name = String(inst.name || '').toLowerCase();
      const okName = list.some(n => name === n || name.startsWith(n));
      return okName && (!cfg.huntSpeciesNeedShiny || inst.isShiny || inst.isAurora);
    }
    return !!(inst.isShiny || inst.isAurora);
  }

  function firstCatchNode() {
    const s = S();
    if (!s || !s.map) return null;
    const acc = window.getAccessibleNodes(s.map).sort((a, b) => a.layer - b.layer || a.col - b.col);
    return acc.find(n => n.type === 'catch') || null;
  }

  /** Run recém-começada: só o inicial e no máximo o 1º nó visitado. Resetar não perde nada. */
  function runIsFresh() {
    const s = S();
    if (!s || !s.map) return false;
    // Mesma regra que o jogo usa pra pular a confirmação do R ("run vazia").
    try { if (fn('isRunEmpty')) return !!window.isRunEmpty(); } catch { /* cai no fallback */ }
    const visited = Object.values(s.map.nodes).filter(n => n.visited && n.type !== 'start');
    return (s.currentMap || 0) === 0 && s.team.length <= 1 && visited.length === 0;
  }

  async function clickNodeAndWait(node) {
    // Não dá await no onNodeClick: ele pode ficar esperando a sua escolha na tela.
    Promise.resolve(window.onNodeClick(node)).catch(e => console.warn('[Pokelike Companion] onNodeClick', e));
    return waitFor(() => currentCatchInstances() && S().savedCatch.nodeId === node.id, 15000);
  }

  function stopHunt(msg) {
    hunt.running = false;
    if (msg) hunt.msg = msg;
    render();
  }

  async function startHunt() {
    if (hunt.running) return;
    const b = blocked();
    if (b) { hunt.msg = b; render(); return; }
    const s = S();
    if (!s.starterSpeciesId) { hunt.msg = L('Comece uma run (escolha o inicial) antes de caçar.', 'Start a run (pick your starter) before hunting.'); render(); return; }
    if (cfg.huntTarget === 'aurora' && !s.isEndlessMode) {
      hunt.msg = L('Aurora só aparece no Battle Tower / Challenges. No Story ela nunca sai — escolha "Shiny".', 'Aurora only exists in Battle Tower / Challenges. It never shows up in Story — pick "Shiny".');
      render(); return;
    }
    if (cfg.huntTarget === 'species' && !speciesList().length) { hunt.msg = L('Digite pelo menos um nome de Pokémon.', 'Type at least one Pokémon name.'); render(); return; }
    if (!runIsFresh() && !window.confirm(
      L(`A caça reseta a run, e a sua já tem progresso (${s.team.length} Pokémon no time) — ele será perdido. Continuar?`,
        `Hunting resets the run, and yours already has progress (${s.team.length} Pokémon on the team) — it will be lost. Continue?`))) {
      return;
    }
    hunt.confirmedReset = !runIsFresh();
    hunt.running = true; hunt.attempts = 0; hunt.t0 = Date.now(); hunt.msg = L('Caçando…', 'Hunting…'); hunt.found = null;
    render();
    try {
      await huntLoop();
    } catch (e) {
      console.error('[Pokelike Companion] hunt', e);
      stopHunt(L('Erro: ', 'Error: ') + (e && e.message || e));
    }
  }

  async function huntLoop() {
    while (hunt.running) {
      const b = blocked();
      if (b) return stopHunt(b);
      // 1) Se já estamos numa tela de captura, confere antes de resetar (nunca joga fora um shiny visível).
      const inst = currentCatchInstances();
      if (inst) {
        hunt.lastSeen = inst.map(i => (i.isAurora ? '🌈' : i.isShiny ? '✨' : '') + i.name).join(', ');
        const hit = inst.find(isHit);
        if (hit) return onFound(hit, inst);
      } else if (screenId() === 'map-screen' && runIsFresh()) {
        // Run nova ainda no mapa: olha o nó de captura antes de resetar.
        const node = firstCatchNode();
        if (node && node.layer === 1) {
          if (!(await clickNodeAndWait(node))) return stopHunt(L('A tela de captura não abriu — parei por segurança.', "The catch screen didn't open — stopped to be safe."));
          continue;
        }
      }
      if (!runIsFresh() && !hunt.confirmedReset) return stopHunt(L('A run avançou (você capturou ou andou no mapa) — caça parada.', 'The run moved on (you caught something or moved on the map) — hunt stopped.'));
      hunt.confirmedReset = false;
      if (hunt.attempts >= cfg.huntMax) return stopHunt(L(`Limite de ${cfg.huntMax} tentativas atingido.`, `Reached the ${cfg.huntMax}-attempt limit.`));

      // 2) Reset da run (mesmo efeito da tecla R, sem o modal de confirmação).
      const s = S();
      const oldSeed = s.runSeed;
      window.executeResetRun();
      const ok = await waitFor(() => {
        const ns = S();
        return ns && ns.runSeed !== oldSeed && ns.map && screenId() === 'map-screen' && !document.getElementById('reset-loading-overlay');
      }, 20000);
      if (!hunt.running) return;
      if (!ok) return stopHunt(L('O reset demorou demais — parei por segurança.', 'The reset took too long — stopped to be safe.'));
      hunt.attempts++;
      render();

      // 3) Clica no primeiro nó de captura disponível (o da esquerda).
      const node = firstCatchNode();
      if (!node) { await sleep(cfg.huntDelay); continue; }
      const got = await clickNodeAndWait(node);
      if (!hunt.running) return;
      if (!got) return stopHunt(L('A tela de captura não abriu — parei por segurança.', "The catch screen didn't open — stopped to be safe."));
      if (cfg.huntDelay) await sleep(cfg.huntDelay);
    }
  }

  function onFound(hit, inst) {
    const kind = hit.isAurora ? 'AURORA' : hit.isShiny ? 'SHINY' : L('Alvo', 'Target');
    hunt.found = { name: hit.name, kind };
    huntLog.push({ at: Date.now(), name: hit.name, kind, attempts: hunt.attempts, secs: Math.round((Date.now() - hunt.t0) / 1000) });
    saveLog();
    stopHunt(L(`${kind} encontrado: ${hit.name} (tentativa ${hunt.attempts}). Escolha ele na tela!`, `${kind} found: ${hit.name} (attempt ${hunt.attempts}). Pick it on screen!`));
    alertUser(`${kind}: ${hit.name}`);
    highlightCatchCards();
  }

  function alertUser(text) {
    if (cfg.huntSound) {
      try {
        const ac = new (window.AudioContext || window.webkitAudioContext)();
        [0, 0.18, 0.36].forEach((t, i) => {
          const o = ac.createOscillator(), g = ac.createGain();
          o.frequency.value = [880, 1175, 1568][i];
          g.gain.setValueAtTime(0.15, ac.currentTime + t);
          g.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + t + 0.16);
          o.connect(g); g.connect(ac.destination);
          o.start(ac.currentTime + t); o.stop(ac.currentTime + t + 0.17);
        });
      } catch { /* ignore */ }
    }
    try { if (window.Notification && Notification.permission === 'granted') new Notification('Pokelike Companion', { body: text }); } catch { /* ignore */ }
    const orig = document.title; let n = 0;
    const iv = setInterval(() => { document.title = (n++ % 2) ? orig : '✨ ' + text; if (n > 20) { clearInterval(iv); document.title = orig; } }, 700);
  }

  // Qualquer tecla/clique real fora do painel interrompe a caça (você retoma o controle na hora).
  const interrupt = e => {
    if (!hunt.running || !e.isTrusted) return;
    if (api.root && api.root.contains(e.target)) return;
    stopHunt(L('Caça pausada (você interagiu com o jogo).', 'Hunt paused (you touched the game).'));
  };
  window.addEventListener('keydown', interrupt, true);
  window.addEventListener('pointerdown', interrupt, true);


  function huntStats() {
    if (!huntLog.length) return null;
    const r = huntLog.map(h => h.attempts);
    return {
      n: huntLog.length,
      aurora: huntLog.filter(h => h.kind === 'AURORA').length,
      avg: Math.round(r.reduce((a, b) => a + b, 0) / r.length),
      best: Math.min(...r), worst: Math.max(...r),
      mins: Math.round(huntLog.reduce((a, h) => a + (h.secs || 0), 0) / 60),
    };
  }


  function huntTargetLabel() {
    const a = L('alvo: ', 'target: ');
    if (cfg.huntTarget === 'aurora') return a + 'Aurora';
    if (cfg.huntTarget === 'newshiny') return a + L('shiny novo na Dex', 'shiny missing from Dex');
    if (cfg.huntTarget === 'species') return a + (cfg.huntSpecies || '—');
    return a + 'Shiny';
  }


  function huntView() {
    const s = S();
    const { p, aur } = shinyOdds();
    const k = s && s.nuzlockeMode ? 1 : 3;
    const pTarget = cfg.huntTarget === 'aurora' ? p * aur : p;
    const perReset = 1 - Math.pow(1 - pTarget, k);
    const expected = perReset > 0 ? Math.round(1 / perReset) : Infinity;
    const secs = hunt.running || hunt.attempts ? Math.round((Date.now() - hunt.t0) / 1000) : 0;
    const chanceSoFar = 1 - Math.pow(1 - perReset, hunt.attempts);
    const opt = (v, label) => `<option value="${v}" ${cfg.huntTarget === v ? 'selected' : ''}>${label}</option>`;
    return `
      <label>${L('Alvo', 'Target')}
        <select data-cfg="huntTarget">
          ${opt('shiny', L('Shiny (ou Aurora)', 'Shiny (or Aurora)'))}
          ${opt('aurora', L('Só Aurora', 'Aurora only'))}
          ${opt('newshiny', L('Shiny que falta na minha Dex', 'Shiny missing from my Dex'))}
          ${opt('species', L('Pokémon específico', 'Specific Pokémon'))}
        </select>
      </label>
      ${cfg.huntTarget === 'species' ? `
        <label>${L('Nomes (separados por vírgula)', 'Names (comma-separated)')}<input data-cfg="huntSpecies" value="${esc(cfg.huntSpecies)}" placeholder="abra, dratini"></label>
        <label class="pkc-check"><input type="checkbox" data-cfg="huntSpeciesNeedShiny" ${cfg.huntSpeciesNeedShiny ? 'checked' : ''}> ${L('precisa ser shiny', 'must be shiny')}</label>` : ''}
      <div class="pkc-row">
        <label>${L('Pausa (ms)', 'Delay (ms)')}<input type="number" min="0" max="5000" step="50" data-cfg="huntDelay" value="${cfg.huntDelay}"></label>
        <label>${L('Máx. tentativas', 'Max attempts')}<input type="number" min="1" max="100000" data-cfg="huntMax" value="${cfg.huntMax}"></label>
      </div>
      <label class="pkc-check"><input type="checkbox" data-cfg="huntSound" ${cfg.huntSound ? 'checked' : ''}> ${L('som ao achar', 'sound when found')}</label>
      ${window.Notification && Notification.permission === 'default' ? `<button class="pkc-link" data-act="notif">${L('ativar notificação do navegador', 'enable browser notification')}</button>` : ''}
      <div class="pkc-row">
        ${hunt.running
          ? `<button class="pkc-btn pkc-stop" data-act="hunt-stop">${L('Parar', 'Stop')}</button>`
          : `<button class="pkc-btn" data-act="hunt-start" title="${L('Aperte qualquer tecla ou clique no jogo para pausar', 'Press any key or click the game to pause')}">${L('Começar caça', 'Start hunt')}</button>`}
      </div>
      <div class="pkc-dialog ${hunt.found ? 'pkc-dialog-found' : ''}">
        <div>${L('Chance por reset', 'Chance per reset')}: <b>${(perReset * 100).toFixed(2)}%</b> <small>(~${expected} ${L('resets em média', 'resets on average')})</small></div>
        <div>${L('Shiny base', 'Base shiny')}: ${(p * 100).toFixed(1)}% ${L('por Pokémon', 'per Pokémon')}${aur ? ` · Aurora: ${Math.round(aur * 100)}% ${L('dos shinies', 'of shinies')}` : ` · Aurora: ${L('só no Battle Tower', 'Battle Tower only')}`}</div>
        ${hunt.attempts ? `
          <div class="pkc-meter"><span class="pkc-meter-lbl">RESETS</span><b>${hunt.attempts}</b><span class="pkc-meter-sub">${secs}s</span></div>
          <div class="pkc-bar pkc-bar-exp" title="${L('Chance de já ter saído um alvo até agora', 'Chance a target should have shown up by now')}"><span style="width:${Math.round(chanceSoFar * 100)}%"></span></div>
          <div class="pkc-meter-sub">${L(`Já devia ter saído com ${pct(chanceSoFar)} de chance`, `${pct(chanceSoFar)} chance it should have shown up by now`)}</div>` : ''}
        ${hunt.lastSeen ? `<div class="pkc-muted">${L('Último', 'Last')}: ${esc(hunt.lastSeen)}</div>` : ''}
        ${hunt.msg ? `<div class="pkc-msg ${hunt.found ? 'pkc-found' : ''}">${esc(hunt.msg)}</div>` : ''}
        <span class="pkc-next" aria-hidden="true">▼</span>
      </div>

      ${huntLog.length ? `<details><summary>${L('Histórico', 'History')} (${huntLog.length})</summary>${statsLine()}
        <ul class="pkc-log">${huntLog.slice().reverse().map(h => `<li>${h.kind === 'AURORA' ? '🌈' : '✨'} ${esc(h.name)} — ${h.attempts} resets, ${h.secs}s <small>${new Date(h.at).toLocaleString()}</small></li>`).join('')}</ul>
        <button class="pkc-link" data-act="clear-log">${L('limpar', 'clear')}</button></details>` : ''}`;
  }


  function statsLine() {
    const st = huntStats();
    if (!st) return '';
    return `<div class="pkc-statgrid">
      <div><b>${st.n}</b><span>${L('achados', 'found')}${st.aurora ? ` (${st.aurora} 🌈)` : ''}</span></div>
      <div><b>${st.avg}</b><span>${L('resets em média', 'avg resets')}</span></div>
      <div><b>${st.best}–${st.worst}</b><span>${L('melhor–pior', 'best–worst')}</span></div>
      <div><b>${st.mins}</b><span>${L('min caçando', 'min hunting')}</span></div></div>`;
  }


  function compactRow() {
    const s = S();
    if (hunt.running) {
      const { p, aur } = shinyOdds();
      const k = s && s.nuzlockeMode ? 1 : 3;
      const per = 1 - Math.pow(1 - (cfg.huntTarget === 'aurora' ? p * aur : p), k);
      return `<div class="pkc-crow"><span class="pkc-clbl">${L('CAÇA', 'HUNT')}</span><span class="pkc-cval">${hunt.attempts} resets · ${pct(1 - Math.pow(1 - per, hunt.attempts))}</span>
        <button class="pkc-mini pkc-mini-stop" data-act="hunt-stop" title="${L('Parar a caça', 'Stop hunting')}">■</button></div>`;
    }
    if (hunt.found) return `<div class="pkc-crow pkc-found"><span class="pkc-clbl">${L('ACHOU', 'FOUND')}</span><span class="pkc-cval">${hunt.found.kind === 'AURORA' ? '🌈' : '✨'} ${esc(hunt.found.name)}</span>
        <button class="pkc-mini" data-act="hunt-start" title="${L('Caçar de novo', 'Hunt again')}">▶</button></div>`;
    return `<div class="pkc-crow"><span class="pkc-clbl">${L('CAÇA', 'HUNT')}</span><span class="pkc-cval pkc-muted">${esc(hunt.msg || huntTargetLabel())}</span>
        <button class="pkc-mini" data-act="hunt-start" title="${L('Começar a caça', 'Start hunting')}">▶</button></div>`;
  }

  api.use({
    defaults: { huntTarget: 'shiny', huntSpecies: '', huntSpeciesNeedShiny: true, huntDelay: 150, huntMax: 2000, huntSound: true },
    tab: { id: 'hunt', label: () => L('Caça', 'Hunt'), view: huntView },
    compactRow,
    badge: () => hunt.running ? `<span class="pkc-live">${L('CAÇANDO', 'HUNTING')}</span>` : '',
    busy: () => hunt.running,
    onTick: () => {
      if (hunt.running && api.cfg.tab === 'hunt') api.renderBody();
      if (hunt.running && screenId() === 'catch-screen') highlightCatchCards();
    },
    actions: {
      'hunt-start': () => startHunt(),
      'hunt-stop': () => stopHunt(L('Caça parada.', 'Hunt stopped.')),
      'notif': () => { try { Notification.requestPermission().then(render); } catch { /* ignore */ } },
      'clear-log': () => { huntLog = []; saveLog(); render(); },
    },
  });
  console.info('[Pokelike Companion] módulo de caça carregado');
  };
  if (window.__pkc) start(window.__pkc);
  else window.addEventListener('pkc:ready', () => start(window.__pkc), { once: true });
})();
