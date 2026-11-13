/*
 * Pokelike Companion — roda no "MAIN world" da página do jogo, então enxerga
 * as funções globais do Pokelike (runBattle, getTypeEffectiveness, ...) e o
 * estado da run (`state`, que é um `let` global do jogo).
 *
 * Regras de segurança que o código segue:
 *  - Nunca altera o estado da run, exceto no Caçador (que só faz o mesmo que
 *    você faria na mão: reset da run + clicar no nó de captura).
 *  - Toda simulação salva e restaura a seed do RNG do jogo, igual o próprio
 *    jogo faz nas simulações internas dele.
 *  - Tudo fica desligado no modo Ranked e no Soul Link.
 */
(() => {
  'use strict';
  if (window.__pkcLoaded) return;
  window.__pkcLoaded = true;

  // ---------------------------------------------------------------- utils ---
  const S = () => { try { return typeof state !== 'undefined' ? state : null; } catch { return null; } };
  const ES = () => { try { return typeof endlessState !== 'undefined' ? endlessState : null; } catch { return null; } };
  const fn = name => (typeof window[name] === 'function' ? window[name] : null);
  const screenId = () => { try { return typeof _currentScreenId !== 'undefined' ? _currentScreenId : ''; } catch { return ''; } };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pct = x => (x == null || isNaN(x) ? '—' : Math.round(x * 100) + '%');
  const clone = x => { try { return structuredClone(x); } catch { return JSON.parse(JSON.stringify(x)); } };
  const tType = t => { try { return (fn('tType') && window.tType(t)) || t; } catch { return t; } };

  async function waitFor(cond, timeout = 15000, every = 50) {
    const t0 = Date.now();
    for (;;) {
      let ok = false;
      try { ok = !!cond(); } catch { ok = false; }
      if (ok) return true;
      if (Date.now() - t0 > timeout) return false;
      await sleep(every);
    }
  }

  /*
   * Roda f() preservando o que uma simulação mexe por fora: a seed do RNG do
   * jogo, o contador de IDs de Pokémon e a flag de habilidades da luta.
   * Só para código síncrono (nada de await dentro), para não "voltar no tempo"
   * por cima de algo que o jogo fez no meio.
   */
  function guarded(f) {
    const seed = window.getRngSeed();
    let uid, abil;
    try { uid = _pokeUidCounter; } catch { uid = undefined; }
    try { abil = _abilitiesLive; } catch { abil = undefined; }
    try { return f(); } finally {
      window.seedRng(seed);
      try { if (uid !== undefined) _pokeUidCounter = uid; } catch { /* ignore */ }
      try { if (abil !== undefined) _abilitiesLive = abil; } catch { /* ignore */ }
    }
  }

  /*
   * Trabalho em pedaços: as simulações rodam em fatias curtas e devolvem o controle pro
   * navegador entre elas, então cliques e animações do jogo nunca ficam esperando.
   * Um job pode ser cancelado (ex.: você saiu da tela) e aí para na próxima fatia.
   */
  const CANCELLED = Symbol('pkc-cancelled');
  const SLICE_MS = 10;
  let sliceStart = 0;
  const yieldNow = () => new Promise(r => setTimeout(r, 0));
  async function breathe(job) {
    if (performance.now() - sliceStart > SLICE_MS) { await yieldNow(); sliceStart = performance.now(); }
    if (job && job.cancelled) throw CANCELLED;
  }
  let advJob = null; // job das dicas na tela (captura, itens, relíquias, boosts)
  const cancelJob = j => { if (j) j.cancelled = true; };

  const TYPES = () => (typeof TYPE_CHART !== 'undefined' ? Object.keys(TYPE_CHART) : []);
  const eff = (atk, defTypes) => { try { return window.getTypeEffectiveness(atk, defTypes || []); } catch { return 1; } };
  const moveOf = mon => { try { return window.getMoveForPokemon(mon); } catch { return null; } };
  const moveType = mon => { const m = moveOf(mon); return (m && m.type) || (mon.types && mon.types[0]) || 'Normal'; };

  function blocked() {
    const s = S();
    if (!s) return 'Nenhuma run carregada.';
    if (s.rankedMode) return 'Modo Ranked: o Companion fica desligado para não interferir no anti-cheat.';
    try { if (fn('slIsActive') && window.slIsActive()) return 'Soul Link ativo: Companion desligado.'; } catch { /* ignore */ }
    return null;
  }

  // ------------------------------------------------------------- settings ---
  const SETTINGS_KEY = 'pkc:settings';
  const defaults = {
    open: true, tab: 'hunt', x: null, y: null,
    huntTarget: 'shiny',      // shiny | aurora | species
    huntSpecies: '',          // lista separada por vírgula
    huntSpeciesNeedShiny: true,
    huntDelay: 150,
    huntMax: 2000,
    huntSound: true,
    sims: 300,
    catchAdvisor: true,
    choiceAdvisor: true,      // notas S+..C em relíquias, itens e boosts
  };
  let cfg = { ...defaults };
  try { cfg = { ...defaults, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* ignore */ }
  const saveCfg = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ } };

  const STATS_KEY = 'pkc:huntlog';
  let huntLog = [];
  try { huntLog = JSON.parse(localStorage.getItem(STATS_KEY) || '[]'); } catch { huntLog = []; }
  const saveLog = () => { try { localStorage.setItem(STATS_KEY, JSON.stringify(huntLog.slice(-50))); } catch { /* ignore */ } };

  // ---------------------------------------------------------- type helpers ---
  function teamDefense(team) {
    // Para cada tipo de ataque: quantos do time tomam 2x+, quantos resistem/imunes.
    return TYPES().map(t => {
      let weak = 0, resist = 0, immune = 0;
      for (const m of team) {
        const e = eff(t, m.types);
        if (e >= 2) weak++;
        else if (e === 0) immune++;
        else if (e < 1) resist++;
      }
      return { type: t, weak, resist, immune, score: weak - resist - immune };
    }).sort((a, b) => b.score - a.score || b.weak - a.weak);
  }

  function teamOffense(team) {
    // Cada Pokémon ataca com UM tipo só (o do golpe). Vê quais tipos defensores o time acerta 2x.
    const moves = team.map(moveType);
    return TYPES().map(def => {
      const best = Math.max(0, ...moves.map(mt => eff(mt, [def])));
      return { type: def, best };
    });
  }

  function traitPoints(team) {
    const s = S();
    const passives = (s && s.passives) || [];
    const has = id => passives.some(p => p.id === id && p.enabled !== false);
    const pts = {};
    team.forEach((m, i) => {
      const shiny = m.isShiny || (has('shiny_first') && i === 0);
      const w = 1 + (shiny ? 1 : 0) + (m.isAurora ? 1 : 0) + (m._mutated ? 1 : 0) + (has('team_reroll') ? 1 : 0);
      for (const t of m.types || []) pts[t] = (pts[t] || 0) + w;
    });
    return pts;
  }
  function traitTiers(team) {
    const s = S();
    try { return window.computeTraitTiers(team, 0, (s && s.passives) || []); } catch { return {}; }
  }
  const traitsMatter = () => { const s = S(); return !!(s && s.isEndlessMode); };

  // ------------------------------------------------------------ simulation ---
  function battleConfig(team, passivesOverride) {
    const s = S();
    const passives = passivesOverride || s.passives || [];
    let c = null;
    try {
      if (s.isEndlessMode) {
        c = window.buildTraitsConfig(window.computeTraitTiers(team, 0, passives), {}, passives);
        if ((s.challengeGen3 || s.challengeGen4 || s.challengeGen5 || s.challengeGen6) && fn('buildGen3AbilityConfig')) {
          c = window.mergeBattleConfigs(c, window.buildGen3AbilityConfig());
        }
      } else if ((s.gen3Mode || s.gen4Mode || s.gen5Mode || s.gen6Mode) && fn('buildGen3AbilityConfig')) {
        c = window.mergeBattleConfigs(window.buildGen3AbilityConfig(), window.buildTraitsConfig({}, {}, passives));
      }
    } catch { /* aproximação sem config */ }
    return c;
  }

  /** Probabilidade de vitória por Monte Carlo. Não mexe no estado da run. */
  async function winRate(team, enemy, n, job = null) {
    const s = S();
    if (!team.length || !enemy || !enemy.length) return null;
    let wins = 0, survivors = 0;
    for (let i = 0; i < n; i++) {
      // cada luta é "guardada" (seed do jogo restaurada) e entre elas o navegador respira
      const res = guarded(() => {
        window.seedRng((Math.random() * 4294967296) >>> 0);
        const pt = clone(team);
        try { if (fn('applyMegaEvolution')) pt.forEach(window.applyMegaEvolution); } catch { /* ignore */ }
        return window.runBattle(pt, clone(enemy), s.items || [], [], null, battleConfig(pt), s.passives || []);
      });
      if (res && res.playerWon) {
        wins++;
        survivors += (res.pTeam || []).filter(m => m.currentHp > 0).length;
      }
      await breathe(job);
    }
    return { p: wins / n, avgSurvivors: wins ? survivors / wins : 0, n };
  }

  let bossCache = { key: null, data: null };
  function bossKey() {
    const s = S(); const es = ES();
    if (!s) return null;
    return [s.runSeed, s.currentMap, s.isEndlessMode ? 1 : 0, s.gen2Mode, s.gen3Mode, s.gen4Mode, s.gen5Mode, s.gen6Mode,
      es && es.regionNumber, es && es.mapIndexInRegion].join('|');
  }

  /** Time do próximo chefe (líder de ginásio / treinador do Battle Tower). */
  async function nextBoss() {
    const key = bossKey();
    if (!key) return null;
    if (bossCache.key === key) return bossCache.data;
    const s = S();
    let data = null;
    try {
      if (!s.isEndlessMode && fn('campaignGymTeam') && s.currentMap < 8) {
        // campaignGymTeam não usa RNG; só cria instâncias (contador de IDs), que restauramos.
        let uid; try { uid = _pokeUidCounter; } catch { uid = undefined; }
        let r;
        try { r = await window.campaignGymTeam(s.currentMap); } finally {
          try { if (uid !== undefined) _pokeUidCounter = uid; } catch { /* ignore */ }
        }
        if (r && r.enemyTeam && r.enemyTeam.length) {
          data = { name: (r.leader && r.leader.name) || 'Líder', type: r.leader && r.leader.type, team: r.enemyTeam, approx: false };
        }
      } else if (s.isEndlessMode) {
        const es = ES();
        const tr = es && es.currentRegion && es.currentRegion.trainers && es.currentRegion.trainers[es.mapIndexInRegion];
        if (tr && Array.isArray(tr.speciesIds) && tr.speciesIds.length && fn('fetchPokemonById') && fn('createInstance')) {
          const lvl = tr.level || 10;
          const species = [];
          for (const id of tr.speciesIds) {
            const sp = await window.fetchPokemonById(id);
            if (sp) species.push(sp);
          }
          const team = guarded(() => species.map(sp => window.createInstance(sp, lvl, false, tr.moveTier != null ? tr.moveTier : 1)));
          if (team.length) data = { name: tr.name || 'o chefe do mapa', type: tr.archetype && tr.archetype.type, team, approx: true };
        }
      }
    } catch (e) {
      console.warn('[Pokelike Companion] nextBoss', e);
    }
    bossCache = { key, data };
    return data;
  }

  function* permutations(arr) {
    if (arr.length <= 1) { yield arr.slice(); return; }
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permutations(rest)) yield [arr[i], ...p];
    }
  }

  /** Vitória vem primeiro; Pokémon vivos no fim desempatam (pesa pouco). */
  const orderScore = (r, n) => r.p + 0.05 * (r.avgSurvivors / Math.max(1, n)) * r.p;

  let orderJob = null;
  async function bestOrder(team, enemy, onProgress) {
    const job = {}; orderJob = job;
    const idx = team.map((_, i) => i);
    const all = [...permutations(idx)];
    const quick = all.length > 120 ? 24 : 60;
    const scored = [];
    let t = performance.now();
    for (let k = 0; k < all.length; k++) {
      if (orderJob !== job) return null;
      const order = all[k];
      const r = await winRate(order.map(i => team[i]), enemy, quick);
      scored.push({ order, p: r.p, alive: r.avgSurvivors, score: orderScore(r, team.length) });
      if (performance.now() - t > 25) { onProgress && onProgress(k / all.length * 0.6); await sleep(0); t = performance.now(); }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 8);
    // garante que a ordem atual também entra no refinamento
    if (!top.some(x => x.order.every((v, i) => v === i))) top.push({ order: idx, p: 0, alive: 0, score: 0 });
    for (let k = 0; k < top.length; k++) {
      if (orderJob !== job) return null;
      const r = await winRate(top[k].order.map(i => team[i]), enemy, Math.max(300, cfg.sims));
      Object.assign(top[k], { p: r.p, alive: r.avgSurvivors, score: orderScore(r, team.length) });
      onProgress && onProgress(0.6 + 0.4 * (k + 1) / top.length);
      await sleep(0);
    }
    top.sort((a, b) => b.score - a.score);
    const current = top.find(x => x.order.every((v, i) => v === i));
    return { best: top[0], current, tried: all.length };
  }

  // --------------------------------------------------------------- hunter ---
  const hunt = { confirmedReset: false, running: false, attempts: 0, t0: 0, msg: '', lastSeen: '', found: null };

  function shinyOdds() {
    const s = S();
    let p = 0.01;
    try { if (fn('hasShinyCharm') && window.hasShinyCharm()) p = 0.02; } catch { /* ignore */ }
    if (s && s.passives && s.passives.some(x => x.id === 'shiny_rate' && x.enabled !== false)) p *= 2;
    if (s && s.challengeDoubleShiny) p *= 2;
    let aur = 0;
    try { aur = s && s.isEndlessMode && fn('auroraShare') ? window.auroraShare() : 0; } catch { aur = 0; }
    return { p, aur };
  }

  function speciesList() {
    return cfg.huntSpecies.split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  }

  function isHit(inst) {
    if (!inst) return false;
    if (cfg.huntTarget === 'aurora') return !!inst.isAurora;
    if (cfg.huntTarget === 'species') {
      const list = speciesList();
      const name = String(inst.name || '').toLowerCase();
      const okName = list.some(n => name === n || name.startsWith(n));
      return okName && (!cfg.huntSpeciesNeedShiny || inst.isShiny || inst.isAurora);
    }
    return !!(inst.isShiny || inst.isAurora);
  }

  function currentCatchInstances() {
    const s = S();
    if (screenId() !== 'catch-screen' || !s || !s.savedCatch || !Array.isArray(s.savedCatch.instances)) return null;
    if (s.currentNode && s.savedCatch.nodeId !== s.currentNode.id) return null;
    return s.savedCatch.instances;
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
    if (!s.starterSpeciesId) { hunt.msg = 'Comece uma run (escolha o inicial) antes de caçar.'; render(); return; }
    if (cfg.huntTarget === 'aurora' && !s.isEndlessMode) {
      hunt.msg = 'Aurora só aparece no Battle Tower / Challenges. No Story ela nunca sai — escolha "Shiny".';
      render(); return;
    }
    if (cfg.huntTarget === 'species' && !speciesList().length) { hunt.msg = 'Digite pelo menos um nome de Pokémon.'; render(); return; }
    if (!runIsFresh() && !window.confirm(
      `A caça reseta a run, e a sua já tem progresso (${s.team.length} Pokémon no time) — ele será perdido. Continuar?`)) {
      return;
    }
    hunt.confirmedReset = !runIsFresh();
    hunt.running = true; hunt.attempts = 0; hunt.t0 = Date.now(); hunt.msg = 'Caçando…'; hunt.found = null;
    render();
    try {
      await huntLoop();
    } catch (e) {
      console.error('[Pokelike Companion] hunt', e);
      stopHunt('Erro: ' + (e && e.message || e));
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
          if (!(await clickNodeAndWait(node))) return stopHunt('A tela de captura não abriu — parei por segurança.');
          continue;
        }
      }
      if (!runIsFresh() && !hunt.confirmedReset) return stopHunt('A run avançou (você capturou ou andou no mapa) — caça parada.');
      hunt.confirmedReset = false;
      if (hunt.attempts >= cfg.huntMax) return stopHunt(`Limite de ${cfg.huntMax} tentativas atingido.`);

      // 2) Reset da run (mesmo efeito da tecla R, sem o modal de confirmação).
      const s = S();
      const oldSeed = s.runSeed;
      window.executeResetRun();
      const ok = await waitFor(() => {
        const ns = S();
        return ns && ns.runSeed !== oldSeed && ns.map && screenId() === 'map-screen' && !document.getElementById('reset-loading-overlay');
      }, 20000);
      if (!hunt.running) return;
      if (!ok) return stopHunt('O reset demorou demais — parei por segurança.');
      hunt.attempts++;
      render();

      // 3) Clica no primeiro nó de captura disponível (o da esquerda).
      const node = firstCatchNode();
      if (!node) { await sleep(cfg.huntDelay); continue; }
      const got = await clickNodeAndWait(node);
      if (!hunt.running) return;
      if (!got) return stopHunt('A tela de captura não abriu — parei por segurança.');
      if (cfg.huntDelay) await sleep(cfg.huntDelay);
    }
  }

  function onFound(hit, inst) {
    const kind = hit.isAurora ? 'AURORA' : hit.isShiny ? 'SHINY' : 'Alvo';
    hunt.found = { name: hit.name, kind };
    huntLog.push({ at: Date.now(), name: hit.name, kind, attempts: hunt.attempts, secs: Math.round((Date.now() - hunt.t0) / 1000) });
    saveLog();
    stopHunt(`${kind} encontrado: ${hit.name} (tentativa ${hunt.attempts}). Escolha ele na tela!`);
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
    if (root && root.contains(e.target)) return;
    stopHunt('Caça pausada (você interagiu com o jogo).');
  };
  window.addEventListener('keydown', interrupt, true);
  window.addEventListener('pointerdown', interrupt, true);

  // --------------------------------------------------------- catch advisor ---
  let advisorKey = null;
  async function catchAdvisor() {
    if (!cfg.catchAdvisor || blocked()) return;
    const inst = currentCatchInstances();
    const wraps = [...document.querySelectorAll('#catch-choices .poke-choice-wrap')];
    if (!inst || !wraps.length || wraps.length !== inst.length) return;
    const s = S();
    const key = s.savedCatch.nodeId + '|' + inst.map(i => i._uid || i.name).join(',') + '|' + s.team.map(m => m._uid + ':' + m.level).join(',');
    if (advisorKey === key && document.querySelector('#catch-choices .pkc-advice:not(.pkc-pending)')) return;
    const job = advJob = { key, cancelled: false };
    const team = s.team;
    const before = teamDefense(team);
    const beforeOff = teamOffense(team);
    const beforeTiers = traitTiers(team);
    const room = team.length < 6; // o jogo aceita até 6; com time cheio ele pede pra trocar

    // 1) tudo que é instantâneo (tipos, cobertura, traits) aparece na hora
    const staticLines = inst.map(cand => {
      const lines = [];
      if (cand.isAurora) lines.push('<b class="pkc-aurora">🌈 AURORA</b>');
      else if (cand.isShiny) lines.push('<b class="pkc-shiny">✨ SHINY</b>');
      const mt = moveType(cand);
      lines.push(`Ataca com <span class="pkc-t pkc-t-${mt.toLowerCase()}">${esc(tType(mt))}</span>`);
      const newHits = TYPES().filter(d => eff(mt, [d]) >= 2 && beforeOff.find(o => o.type === d).best < 2);
      if (newHits.length) lines.push('Nova cobertura: ' + newHits.map(t => esc(tType(t))).join(', '));
      // defesa: ele cobre ou piora as maiores fraquezas do time?
      const threats = before.filter(d => d.weak > 0 && d.score > 0).slice(0, 4).map(d => d.type);
      const covers = threats.filter(t => eff(t, cand.types) < 1);
      const stacks = threats.filter(t => eff(t, cand.types) >= 2);
      if (covers.length) lines.push('<span class="pkc-good">Resiste a ' + covers.map(t => esc(tType(t))).join(', ') + ' (fraqueza do time)</span>');
      if (stacks.length) lines.push('<span class="pkc-bad">Também é fraco a ' + stacks.map(t => esc(tType(t))).join(', ') + '</span>');
      if (traitsMatter()) {
        const afterTiers = traitTiers([...team, cand]);
        const ups = Object.keys(afterTiers).filter(t => (afterTiers[t] || 0) > (beforeTiers[t] || 0));
        if (ups.length) lines.push('Trait: ' + ups.map(t => `${esc(tType(t))} T${afterTiers[t]}`).join(', '));
      }
      return lines;
    });
    const boxes = wraps.map(w => {
      let box = w.querySelector('.pkc-advice');
      if (!box) { box = document.createElement('div'); w.appendChild(box); }
      box.className = 'pkc-advice';
      return box;
    });
    const boss = hunt.running ? null : await nextBoss();
    const simLine = i => `<span class="pkc-sim" data-i="${i}">${boss ? `vs ${esc(boss.name)}: <small class="pkc-muted">calculando…</small>` : ''}</span>`;
    boxes.forEach((box, i) => { box.innerHTML = staticLines[i].join('<br>') + (boss ? '<br>' + simLine(i) : ''); });
    highlightCatchCards();
    if (!boss) { advisorKey = key; return; }

    // 2) chance contra o chefe, em pedaços (mesmas sementes pra tudo: dá pra simular menos)
    const passives = s.passives || [];
    const base = await simPower(team, boss.team, passives, 100, 1, job);
    for (let i = 0; i < inst.length; i++) {
      const cand = inst[i];
      let best = null;
      if (room) best = { p: (await simPower([...team, cand], boss.team, passives, 100, 1, job)).p, label: '' };
      else {
        for (let j = 0; j < team.length; j++) {
          const t2 = team.slice(); t2[j] = cand;
          const r = (await simPower(t2, boss.team, passives, 60, 1, job)).p;
          if (!best || r > best.p) best = { p: r, label: ` (no lugar de ${team[j].name})` };
        }
      }
      const d = best.p - base.p;
      const cls = d > 0.02 ? 'pkc-good' : d < -0.02 ? 'pkc-bad' : '';
      const el = boxes[i].querySelector('.pkc-sim');
      if (el) el.innerHTML = `vs ${esc(boss.name)}: <span class="${cls}">${pct(best.p)}</span> <small>(${d >= 0 ? '+' : ''}${Math.round(d * 100)} pts${esc(best.label)})</small>`;
    }    advisorKey = key; // só marca como pronto quando terminou tudo (se cancelar no meio, refaz)
  }

  /*
   * Reserva o espaço das dicas no MESMO instante em que o jogo desenha os cards
   * (antes de a tela aparecer), pra nada se mexer quando as dicas chegarem.
   * Card que pula de lugar embaixo do mouse = clique no lugar errado.
   */
  function reserveAdviceSpace() {
    if (hunt.running || blocked()) return;
    if (cfg.catchAdvisor) {
      for (const w of document.querySelectorAll('#catch-choices .poke-choice-wrap')) {
        if (!w.querySelector('.pkc-advice')) {
          const ph = document.createElement('div');
          ph.className = 'pkc-advice pkc-pending';
          ph.textContent = 'Analisando…';
          w.appendChild(ph);
        }
      }
    }
    if (cfg.choiceAdvisor) {
      const box = document.getElementById('passive-choices');
      const h2 = document.querySelector('#passive-screen h2');
      let martTitle = null;
      try { martTitle = window.t('mart.title'); } catch { /* ignore */ }
      const isMart = !!(h2 && martTitle && h2.textContent.trim() === martTitle);
      const groups = [
        document.querySelectorAll('#item-choices .item-card'),
        box && !box.classList.contains('is-replace-grid') && !isMart ? box.querySelectorAll('.passive-card') : [],
        document.querySelectorAll('#stat-buff-choices .stat-buff-poke-wrap'),
      ];
      for (const cards of groups) {
        for (const c of cards) {
          if (!c.querySelector(':scope > .pkc-tier')) {
            const ph = document.createElement('div');
            ph.className = 'pkc-tier pkc-pending';
            ph.textContent = 'Calculando nota…';
            c.appendChild(ph);
          }
        }
      }
    }
  }

  function highlightCatchCards() {
    const inst = currentCatchInstances();
    if (!inst) return;
    const wraps = [...document.querySelectorAll('#catch-choices .poke-choice-wrap')];
    inst.forEach((c, i) => { if (wraps[i]) wraps[i].classList.toggle('pkc-hit', !!(c.isShiny || c.isAurora)); });
  }

  // -------------------------------------------------------- choice advisor ---
  /*
   * Notas S+ / S / A / B / C para relíquias, itens e boosts de atributo.
   * A nota soma duas coisas:
   *  - simulação: quanto a opção melhora as lutas contra o próximo chefe (mesmas
   *    sementes pra todas as opções, então a diferença vem da opção e não da sorte);
   *  - sinergia: regras com o motivo explicado (tipo do golpe, traits, HP do time...).
   */
  const TIERS = [['S+', 14], ['S', 9], ['A', 5], ['B', 1.5], ['C', -Infinity]];
  const tierOf = score => TIERS.find(([, min]) => score >= min)[0];
  const SIM_N = 120;
  const SIM_WEIGHT = 60; // +0,1 de "poder" (~+10% de vitória) ≈ 6 pontos

  const ARCHETYPE_PT = {
    damage: 'mais dano', defense: 'defesa', heal: 'cura', xp: 'XP / níveis', eot: 'efeito por turno',
    start: 'efeito no início da luta', onhit: 'efeito ao acertar', ko: 'efeito ao nocautear', faint: 'efeito ao desmaiar',
    survive: 'sobrevivência', stats: 'atributos', drops: 'drops', speed: 'velocidade', crit: 'crítico',
    dodge: 'esquiva', status: 'status', trait: 'traits', charm: 'fora de batalha',
  };

  let simSeeds = [];
  function seedsFor(n) {
    while (simSeeds.length < n) simSeeds.push((Math.random() * 4294967296) >>> 0);
    return simSeeds.slice(0, n);
  }

  const hpFrac = arr => {
    let c = 0, m = 0;
    for (const x of arr || []) { c += Math.max(0, x.currentHp || 0); m += x.maxHp || 0; }
    return m ? c / m : 0;
  };

  /**
   * "Poder" do time contra o inimigo: vitória vale 1 (+ até 0,5 pelo HP que sobra);
   * derrota vale até 0,9 pelo quanto do HP do inimigo você tirou.
   */
  async function simPower(team, enemy, passives, n = SIM_N, teamHp = curTeamHp, job = advJob) {
    const s = S();
    const seeds = seedsFor(n);
    let tot = 0, wins = 0;
    for (const sd of seeds) {
      const res = guarded(() => {
        window.seedRng(sd);
        const pt = clone(scaleHp(team, teamHp));
        try { if (fn('applyMegaEvolution')) pt.forEach(window.applyMegaEvolution); } catch { /* ignore */ }
        return window.runBattle(pt, clone(enemy), s.items || [], [], null, battleConfig(pt, passives), passives);
      });
      if (res) {
        if (res.playerWon) { wins++; tot += 1 + 0.5 * hpFrac(res.pTeam); } else tot += 0.9 * (1 - hpFrac(res.eTeam));
      }
      await breathe(job);
    }
    return { power: tot / seeds.length, p: wins / seeds.length };
  }

  const withLevels = (m, n) => {
    const c = clone(m);
    try {
      const oldBase = window.calcHp(c.baseStats.hp, c.level);
      const ratio = oldBase ? c.maxHp / oldBase : 1;
      c.level += n;
      const newMax = Math.round(window.calcHp(c.baseStats.hp, c.level) * ratio);
      c.currentHp = c.currentHp > 0 ? Math.min(newMax, c.currentHp + (newMax - c.maxHp)) : c.currentHp;
      c.maxHp = newMax;
    } catch { c.level += n; }
    return c;
  };

  const withBuff = (m, stat) => {
    const c = clone(m);
    c.statBuffs = { ...(c.statBuffs || {}) };
    const inc = k => { c.statBuffs[k] = Math.min(10, (c.statBuffs[k] || 0) + 1); };
    inc(stat);
    if (stat === 'atk') inc('special');
    if (stat === 'special') inc('atk');
    if (stat === 'hp') {
      try { const add = Math.floor(window.calcHp(c.baseStats.hp, c.level) * 0.05); c.maxHp += add; if (c.currentHp > 0) c.currentHp += add; } catch { /* ignore */ }
    }
    return c;
  };

  const specialAttacker = m => { try { return !!window.attacksWithSpecial(m); } catch { return false; } };
  const canEvo = m => { try { return !!window.canEvolve(m.speciesId); } catch { return false; } };
  const itemNameOf = it => { try { return window.tItemName(it.id, it.name) || it.name; } catch { return it.name; } };
  const teamNames = arr => arr.map(m => m.name).join(', ');

  /** Testa variações do time e devolve a melhor (com o ganho em pontos). */
  async function bestVariant(base, enemy, passives, variants) {
    let best = null;
    for (const v of variants) {
      const r = await simPower(v.team, enemy, passives);
      const pts = (r.power - base.power) * SIM_WEIGHT;
      if (!best || pts > best.pts) best = { ...v, pts, p: r.p };
    }
    return best;
  }

  async function evaluateItem(item, ctx) {
    const s = S();
    const team = s.team;
    const why = [];
    let pts = 0, holder = null, simPts = null;
    const invType = {};
    try { for (const [t, id] of Object.entries(TYPE_ITEM_MAP || {})) invType[id] = t; } catch { /* ignore */ }

    if (item.usable) {
      if (item.id === 'sacred_ash') {
        const fainted = team.filter(m => m.currentHp <= 0);
        const hurt = team.filter(m => m.currentHp > 0 && m.currentHp < m.maxHp * 0.5);
        if (fainted.length) { pts += 9; why.push(`Revive ${teamNames(fainted)}`); }
        else if (hurt.length) { pts += 4; why.push(`Cura ${teamNames(hurt)} (menos de 50% de HP)`); }
        else why.push('Time com HP bom: guarda pra depois');
      } else if (item.id === 'moon_stone') {
        const evo = team.filter(m => { try { return window.canEverEvolve(m); } catch { return false; } });
        if (evo.length) { pts += 5; why.push(`Evolui na hora: ${teamNames(evo)}`); } else { pts -= 4; why.push('Ninguém do time pode evoluir'); }
      } else if (ctx.enemy && (item.id === 'rare_candy' || item.id === 'tm_normal')) {
        const variants = team.map((m, i) => {
          if (item.id === 'tm_normal' && (m.moveTier != null ? m.moveTier : 1) >= 2) return null;
          const t2 = team.slice();
          t2[i] = item.id === 'rare_candy' ? withLevels(m, 3) : { ...clone(m), moveTier: Math.min(2, (m.moveTier != null ? m.moveTier : 1) + 1) };
          return { team: t2, holder: m };
        }).filter(Boolean);
        if (!variants.length) { pts -= 4; why.push('Todos já estão com o golpe no máximo'); }
        else {
          const b = await bestVariant(ctx.base, ctx.enemy, s.passives || [], variants);
          simPts = b.pts; holder = b.holder;
          why.push(item.id === 'rare_candy' ? `+3 níveis em ${b.holder.name}` : `Golpe mais forte pra ${b.holder.name}`);
        }
      }
    } else {
      // item segurado: testa em cada Pokémon e fica com o melhor portador
      const T = invType[item.id];
      let candidates = team.map((m, i) => i);
      if (T) {
        // Mecânica do jogo: quem segura o item do próprio tipo passa a atacar com ele, com +40% de dano.
        const users = team.filter(m => (m.types || []).includes(T));
        candidates = team.map((m, i) => i).filter(i => (team[i].types || []).includes(T));
        if (users.length) {
          pts += 3;
          why.push(`+40% no dano ${tType(T)} de ${teamNames(users)}`);
          const switchers = users.filter(m => moveType(m) !== T);
          if (switchers.length) why.push(`${teamNames(switchers)} passa a atacar com ${tType(T)}`);
        } else { pts -= 6; why.push(`Ninguém do time é do tipo ${tType(T)}: não faz efeito`); }
      }
      if (item.id === 'choice_band') {
        const phys = team.filter(m => !specialAttacker(m));
        if (phys.length) why.push(`Atacantes físicos: ${teamNames(phys)}`); else { pts -= 6; why.push('Ninguém ataca físico'); }
      }
      if (item.id === 'choice_specs') {
        const spec = team.filter(specialAttacker);
        if (spec.length) why.push(`Atacantes especiais: ${teamNames(spec)}`); else { pts -= 6; why.push('Ninguém ataca especial'); }
      }
      if (item.id === 'eviolite') {
        const ev = team.filter(canEvo);
        if (ev.length) why.push(`${teamNames(ev)} ainda evolui (mas o item trava a evolução)`); else { pts -= 6; why.push('Todo o time já evoluiu'); }
      }
      if (item.id === 'metronome') {
        const dual = team.filter(m => (m.types || []).length > 1);
        if (dual.length) why.push(`Tipo duplo: ${teamNames(dual)} passam a atacar com o outro tipo`); else { pts -= 6; why.push('Ninguém tem tipo duplo'); }
      }
      if (item.id === 'lucky_egg') { pts += 2; why.push('Mais níveis ao longo da run: melhor cedo'); }
      if (ctx.enemy && candidates.length) {
        const variants = candidates.map(i => {
          const t2 = team.slice(); t2[i] = { ...clone(team[i]), heldItem: { ...item } };
          return { team: t2, holder: team[i] };
        });
        const b = await bestVariant(ctx.base, ctx.enemy, s.passives || [], variants);
        simPts = b.pts; holder = b.holder;
      }
      if (holder && ctx.enemy && simPts != null && simPts >= 1) {
        const hi = team.indexOf(holder);
        if (hi === 0) why.push(`${holder.name} vai na frente: é quem mais luta`);
        if (T || ['choice_specs', 'choice_band', 'metronome'].includes(item.id)) {
          const mt = T && (holder.types || []).includes(T) ? T : moveType(holder);
          const effs = ctx.enemy.map(e => eff(mt, e.types));
          const avg = effs.reduce((a, b) => a + b, 0) / effs.length;
          if (avg >= 2) why.push(`${tType(mt)} é super efetivo no time do chefe`);
          else if (avg < 1) why.push(`Ajuda mesmo com ${tType(mt)} resistido pelo chefe`);
        }
      }
      if (simPts != null && Math.abs(simPts) < 1 && pts === 0) {
        holder = null;
        why.push('Efeito fora das lutas (ou pequeno demais pra aparecer)');
      }
      if (holder && holder.heldItem) why.push(`Troca o ${itemNameOf(holder.heldItem)} de ${holder.name}`);
    }
    return { ...finish(pts, simPts, why, holder, ctx), verb: item.usable ? 'Usar em' : 'Equipar em' };
  }

  async function evaluateRelic(relic, ctx) {
    const s = S();
    const team = s.team;
    const why = [];
    let pts = 0, simPts = null;
    let syn = [];
    try { syn = window.passiveSynergyTypes(relic.id) || []; } catch { syn = []; }
    const tiers = traitTiers(team);
    const arche = (() => { try { return window.passiveArchetype(relic.id); } catch { return null; } })();

    if (relic.curse) { pts -= 8; why.push('Maldição: tem um lado ruim forte'); }
    if (relic.charm) { pts -= 3; why.push('Charm: não muda as lutas' + (relic.id === 'shiny_rate' ? ' (mas dobra a chance de shiny!)' : '')); }
    if (relic.capstone) { pts += 6; why.push(`Relíquia final de ${tType(relic.capstone)}`); }

    if (ctx.enemy && !relic.charm) {
      const passives = [...(s.passives || []), { ...relic, enabled: true }];
      const r = await simPower(team, ctx.enemy, passives);
      simPts = (r.power - ctx.base.power) * SIM_WEIGHT;
    }

    if (syn.length) {
      const members = team.filter(m => (m.types || []).some(t => syn.includes(t)));
      const active = syn.filter(t => (tiers[t] || 0) > 0);
      if (active.length) { pts += 5; why.push(`Trait ${active.map(t => `${tType(t)} T${tiers[t]}`).join(', ')} ativo no seu time`); }
      if (members.length) { pts += Math.min(6, 2 * members.length); why.push(`Combina com ${teamNames(members)}`); }
      else if (simPts != null && simPts >= 1) { pts -= 1; why.push(`É do kit ${syn.map(tType).join('/')}, mas ajuda seu time mesmo assim`); }
      else { pts -= 6; why.push(`Nenhum Pokémon ${syn.map(tType).join('/')} no time`); }
    } else if (relic.kit === 'generalist') {
      pts += 1; why.push('Funciona com qualquer time');
    }
    if (relic.id === 'shiny_dmg' || relic.id === 'shiny_def' || relic.id === 'shiny_first') {
      const sh = team.filter(m => m.isShiny || m.isAurora);
      if (sh.length) { pts += 4; why.push(`Seus shinies: ${teamNames(sh)}`); } else { pts -= 5; why.push('Nenhum shiny no time'); }
    }
    if (arche && ARCHETYPE_PT[arche] && !relic.charm) why.push('Foco: ' + ARCHETYPE_PT[arche]);

    try {
      const free = window.passiveSlotCap() - window.combatPassiveCount(s.passives || []);
      if (free <= 0 && !relic.charm && !relic.oneShot) why.push('Slots cheios: vai substituir uma relíquia');
    } catch { /* ignore */ }

    return finish(pts, simPts, why, null, ctx);
  }

  function finish(pts, simPts, why, holder, ctx) {
    let score = pts;
    if (simPts != null) {
      score += simPts;
      const r = Math.round(simPts);
      if (Math.abs(r) >= 1) why.unshift(`${r > 0 ? '+' : ''}${r} pts na simulação contra ${ctx.enemyName}`);
      else why.push(`Quase não muda a luta contra ${ctx.enemyName}`);
    }
    return { score, tier: tierOf(score), why: why.slice(0, 4), holder };
  }

  /*
   * Se a luta contra o chefe é fácil (ou difícil) demais, toda opção dá 100% (ou 0%) e
   * não dá pra comparar. Então a simulação ALONGA a luta até ficar perto de 50%:
   *  - fácil demais: o chefe ganha mais vida;
   *  - difícil demais: o seu time ganha mais vida.
   * (Encurtar a luta não serve: com tudo morrendo num golpe, bônus de dano não aparece.)
   */
  let calCache = { key: null, cal: { side: null, f: 1 } };
  let curTeamHp = 1; // multiplicador de vida do seu time durante uma avaliação
  const scaleHp = (mons, f) => (f === 1 ? mons : mons.map(e => {
    const c = clone(e);
    c.maxHp = Math.max(1, Math.round(e.maxHp * f));
    c.currentHp = e.currentHp > 0 ? Math.max(1, Math.round(e.currentHp * f)) : e.currentHp;
    return c;
  }));
  async function calibrate(team, enemy, passives, key) {
    if (calCache.key === key) return calCache.cal;
    const run = async (side, f) => side === 'enemy'
      ? (await simPower(team, scaleHp(enemy, f), passives, 60, 1)).p
      : (await simPower(team, enemy, passives, 60, f)).p;
    const p0 = await run('enemy', 1);
    let cal = { side: null, f: 1 };
    if (p0 > 0.8 || p0 < 0.2) {
      const side = p0 > 0.8 ? 'enemy' : 'team';
      let lo = 0, hi = Math.log(60), best = { f: 1, d: Math.abs(p0 - 0.5) };
      for (let k = 0; k < 8; k++) {
        const mid = (lo + hi) / 2, f = Math.exp(mid), p = await run(side, f);
        if (Math.abs(p - 0.5) < best.d) best = { f, d: Math.abs(p - 0.5) };
        const tooEasy = p > 0.5;
        // aumentar a vida do chefe deixa mais difícil; aumentar a sua deixa mais fácil
        if ((side === 'enemy') === tooEasy) lo = mid; else hi = mid;
      }
      cal = { side, f: best.f };
    }
    calCache = { key, cal };
    return cal;
  }

  async function advisorCtx() {
    const s = S();
    const boss = ui.boss;
    if (!boss || !boss.team || !s.team.length) return { enemy: null, enemyName: '', base: null };
    const passives = s.passives || [];
    const key = bossKey() + '|' + s.team.map(m => `${m._uid}:${m.level}:${m.currentHp}:${m.heldItem ? m.heldItem.id : ''}`).join(',') + '|' + passives.map(p => p.id).join(',');
    const cal = await calibrate(s.team, boss.team, passives, key);
    const enemy = cal.side === 'enemy' ? scaleHp(boss.team, cal.f) : boss.team;
    curTeamHp = cal.side === 'team' ? cal.f : 1;
    return { enemy, enemyName: boss.name, cal, base: await simPower(s.team, enemy, passives) };
  }

  function tierBadge(res, isBest) {
    const cls = 'pkc-tier-' + res.tier.replace('+', 'p');
    return `<div class="pkc-tier ${cls}">
      <div class="pkc-tier-top"><span class="pkc-tier-g">${res.tier}</span>${isBest ? '<span class="pkc-tier-best">MELHOR</span>' : ''}</div>
      ${res.holder ? `<div class="pkc-tier-holder">${res.verb || 'Equipar em'} <b>${esc(res.holder.name)}</b></div>` : ''}
      <ul>${res.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>`;
  }

  function paintCards(cards, results) {
    const valid = results.filter(Boolean);
    const sorted = valid.map(r => r.score).sort((a, b) => b - a);
    // "★ MELHOR" só quando um ganha com folga (empate não tem melhor)
    const bestScore = sorted.length > 1 && sorted[0] - sorted[1] >= 1 ? sorted[0] : null;
    cards.forEach((card, i) => {
      const r = results[i];
      let box = card.querySelector(':scope > .pkc-tier');
      if (!r) { if (box) box.remove(); return; }
      const html = tierBadge(r, r.score === bestScore && r.tier !== 'C');
      if (!box) { box = document.createElement('div'); card.appendChild(box); }
      box.outerHTML = html;
    });
  }

  let relicIndex = null;
  function relicByCardName(name) {
    if (!relicIndex) {
      relicIndex = new Map();
      try {
        for (const p of PASSIVE_ITEM_POOL) {
          relicIndex.set(p.name.trim().toLowerCase(), p);
          try { relicIndex.set(String(window.tItemName(p.id, p.name)).trim().toLowerCase(), p); } catch { /* ignore */ }
        }
      } catch { /* ignore */ }
    }
    return relicIndex.get(String(name || '').trim().toLowerCase()) || null;
  }

  function itemById(id) {
    try {
      const all = [...ITEM_POOL, ...USABLE_ITEM_POOL];
      const f = all.find(x => x.id === id);
      if (f) return f;
      if (typeof MEGA_STONE_BY_ID !== 'undefined' && MEGA_STONE_BY_ID[id] && fn('makeMegaStoneItem')) return window.makeMegaStoneItem(MEGA_STONE_BY_ID[id]);
    } catch { /* ignore */ }
    return null;
  }

  let choiceKey = null;
  async function choiceAdvisor() {
    if (!cfg.choiceAdvisor || blocked() || hunt.running) return;
    const s = S();
    if (!s || !s.team || !s.team.length) return;
    const scr = screenId();
    if (scr !== 'item-screen' && scr !== 'passive-screen' && scr !== 'stat-buff-screen') return;
    if (!ui.boss) ui.boss = await nextBoss();
    const teamSig = s.team.map(m => `${m._uid}:${m.level}:${m.currentHp}:${m.heldItem ? m.heldItem.id : ''}`).join(',') + '|' + (s.passives || []).map(p => p.id).join(',');

    if (scr === 'item-screen') {
      const cards = [...document.querySelectorAll('#item-choices .item-card')];
      const ids = (s.itemOffer && s.itemOffer.ids) || [];
      if (!cards.length || cards.length !== ids.length) return;
      const key = 'item|' + ids.join(',') + '|' + teamSig;
      if (key === choiceKey && document.querySelector('#item-choices .pkc-tier:not(.pkc-pending)')) return;
      advJob = { key, cancelled: false };
      const ctx = await advisorCtx();
      const results = [];
      for (const id of ids) { const it = itemById(id); results.push(it ? await evaluateItem(it, ctx) : null); }
      paintCards(cards, results);
      choiceKey = key;
    } else if (scr === 'passive-screen') {
      const box = document.getElementById('passive-choices');
      if (!box || box.classList.contains('is-replace-grid')) return;
      const h2 = document.querySelector('#passive-screen h2');
      let martTitle = null;
      try { martTitle = window.t('mart.title'); } catch { /* ignore */ }
      if (h2 && martTitle && h2.textContent.trim() === martTitle) return; // loja de venda: não é escolha de relíquia
      const cards = [...box.querySelectorAll('.passive-card')];
      if (!cards.length) return;
      const names = cards.map(c => (c.querySelector('.item-name') || {}).textContent || '');
      const key = 'relic|' + names.join(',') + '|' + teamSig;
      if (key === choiceKey && box.querySelector('.pkc-tier:not(.pkc-pending)')) return;
      advJob = { key, cancelled: false };
      const ctx = await advisorCtx();
      const results = [];
      for (const n of names) { const r = relicByCardName(n); results.push(r ? await evaluateRelic(r, ctx) : null); }
      paintCards(cards, results);
      choiceKey = key;
    } else if (scr === 'stat-buff-screen') {
      if (buffCache.key !== teamSig) advJob = { key: 'buff|' + teamSig, cancelled: false };
      await statBuffAdvisor(teamSig);
    }
  }

  const BUFF_STATS = [['hp', 'HP'], ['atk', 'ATK'], ['def', 'DEF'], ['speed', 'SPE'], ['special', 'SP.A'], ['spdef', 'SP.D']];
  let buffCache = { key: null, table: null };

  async function buffTable(teamSig) {
    const s = S();
    if (buffCache.key === teamSig) return buffCache.table;
    const ctx = await advisorCtx();
    let maxPts = 10;
    try { maxPts = window.getMaxBuffPoints(); } catch { /* ignore */ }
    const stat = (mon, k) => { try { return window.getEffectiveStat(mon, k, mon.heldItem ? [mon.heldItem] : []); } catch { return 0; } };
    const enemy = (ui.boss && ui.boss.team) || [];
    // quem mais causa dano: ataque efetivo × eficácia média do golpe contra o chefe
    const dmg = s.team.map((m, i) => {
      const atk = stat(m, specialAttacker(m) ? 'special' : 'atk');
      const mt = moveType(m);
      const e = enemy.length ? enemy.reduce((a, x) => a + eff(mt, x.types), 0) / enemy.length : 1;
      return { i, v: m.currentHp > 0 ? atk * e * ((m.types || []).includes(mt) ? 1.5 : 1) : 0 };
    });
    const dealers = dmg.sort((a, b) => b.v - a.v).map(x => x.i);
    const bossPhysical = enemy.length ? enemy.filter(e => !specialAttacker(e)).length / enemy.length : 0.5;
    const table = [];
    for (let i = 0; i < s.team.length; i++) table.push(await (async m => {
      let used = 0;
      try { used = window.getTotalBuffPoints(m.statBuffs || {}); } catch { /* ignore */ }
      const skip = specialAttacker(m) ? 'atk' : 'special'; // o jogo só mostra o atributo de ataque que ele usa
      const stats = [];
      for (const [k, label] of BUFF_STATS.filter(([kk]) => kk !== skip)) stats.push(await (async () => {
        if (used >= maxPts || ((m.statBuffs || {})[k] || 0) >= 10) return { k, label, res: null };
        const why = [];
        let pts = 1; // fica salvo pra linha evolutiva: sempre vale um pouco
        const atkStat = specialAttacker(m) ? 'special' : 'atk';
        if (k === atkStat) {
          const rank = dealers.indexOf(i);
          if (rank === 0) { pts += 6; why.push(`${m.name} é quem mais causa dano no time`); }
          else if (rank === 1) { pts += 3; why.push(`${m.name} é o 2º que mais causa dano`); }
          else why.push(`Aumenta o ataque que ${m.name} usa`);
        } else if (k === 'speed') {
          const now = stat(m, 'speed'), after = stat(withBuff(m, 'speed'), 'speed');
          const flips = enemy.filter(e => { const es = stat(e, 'speed'); return now <= es && after > es; });
          if (flips.length) { pts += 8; why.push(`Passa a atacar antes de ${teamNames(flips)}`); }
          else {
            const slower = enemy.filter(e => stat(e, 'speed') >= now);
            why.push(slower.length ? `Ainda fica mais lento que ${teamNames(slower)}` : 'Já é mais rápido que o time do chefe');
          }
        } else if (k === 'hp' || k === 'def' || k === 'spdef') {
          if (i === 0) { pts += 3; why.push(`${m.name} vai na frente: é quem mais apanha`); }
          if (k === 'def' && bossPhysical > 0.6) { pts += 2; why.push('O chefe ataca mais com golpes físicos'); }
          if (k === 'spdef' && bossPhysical < 0.4) { pts += 2; why.push('O chefe ataca mais com golpes especiais'); }
          if (k === 'hp') why.push('+5% de HP máximo');
        }
        let simPts = null;
        if (ctx.enemy) {
          const t2 = s.team.slice(); t2[i] = withBuff(m, k);
          // a simulação entra com peso limitado: com números pequenos o arredondamento distorce
          simPts = Math.max(-2, Math.min(4, ((await simPower(t2, ctx.enemy, s.passives || [])).power - ctx.base.power) * SIM_WEIGHT));
        }
        why.push('Fica salvo pra linha evolutiva nas próximas runs');
        return { k, label, res: finish(pts, simPts, why, null, ctx) };
      })());
      const best = stats.filter(x => x.res).sort((a, b) => b.res.score - a.res.score)[0] || null;
      return { mon: m, stats, best };
    })(s.team[i]));
    buffCache = { key: teamSig, table };
    return table;
  }

  async function statBuffAdvisor(teamSig) {
    const s = S();
    const table = await buffTable(teamSig);
    const wraps = [...document.querySelectorAll('#stat-buff-choices .stat-buff-poke-wrap')];
    if (wraps.length) {
      // passo 1: escolher o Pokémon
      if (wraps.length !== table.length) return;
      const results = table.map(row => row.best ? { ...row.best.res, why: [`Melhor atributo: ${row.best.label}`, ...row.best.res.why.slice(0, 2)] } : null);
      if (!wraps[0].querySelector(':scope > .pkc-tier:not(.pkc-pending)')) paintCards(wraps, results);
      return;
    }
    // passo 2: escolher o atributo do Pokémon aberto (título = nome dele)
    const rows = [...document.querySelectorAll('#stat-buff-choices .stat-buff-row')];
    if (!rows.length || rows[0].querySelector('.pkc-chip')) return;
    const title = (document.getElementById('stat-buff-title') || {}).textContent || '';
    const idx = s.team.findIndex(m => { try { return window.displayName(m) === title; } catch { return m.name === title; } });
    if (idx < 0) return;
    const stats = table[idx].stats;
    if (stats.length !== rows.length) return;
    const sc = stats.filter(x => x.res).map(x => x.res.score).sort((a, b) => b - a);
    const bestScore = sc.length > 1 && sc[0] - sc[1] >= 0.5 ? sc[0] : null;
    rows.forEach((row, i) => {
      const r = stats[i].res;
      if (!r) return;
      const chip = document.createElement('span');
      chip.className = 'pkc-chip pkc-tier-' + r.tier.replace('+', 'p') + (r.score === bestScore ? ' pkc-chip-best' : '');
      chip.textContent = r.tier;
      chip.title = r.why.join(' · ');
      row.appendChild(chip);
    });
  }

  // Diagnóstico pelo console: __pkcDebug.ctx(), __pkcDebug.relic('id')
  window.__pkcDebug = {
    ctx: async () => { const c = await advisorCtx(); return { cal: c.cal, base: c.base, enemy: c.enemy && c.enemy.map(e => e.name + ' Lv' + e.level) }; },
    relic: async id => evaluateRelic(PASSIVE_ITEM_POOL.find(p => p.id === id), await advisorCtx()),
    item: async id => evaluateItem(itemById(id), await advisorCtx()),
    buffs: async () => (await buffTable('debug-' + Date.now())).map(r => ({ mon: r.mon.name, best: r.best && r.best.label, stats: r.stats.map(x => x.label + ':' + (x.res ? x.res.tier + ' ' + x.res.score.toFixed(1) : '-')).join(' ') })),
  };

  // -------------------------------------------------------------------- UI ---
  let root = null;
  const ui = { boss: null, bossWin: null, order: null, orderProgress: null, orderBusy: false, defA: '', defB: '', lastSig: '' };

  function mount() {
    root = document.createElement('div');
    root.id = 'pkc-root';
    document.body.appendChild(root);
    if (cfg.x != null && cfg.y != null) { root.style.left = cfg.x + 'px'; root.style.top = cfg.y + 'px'; root.style.bottom = 'auto'; }
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onChange);
    root.addEventListener('pointerdown', dragStart);
    // Impede que teclas digitadas no painel virem atalhos do jogo (ex.: R = reset).
    root.addEventListener('keydown', e => e.stopPropagation());
    render();
  }

  function onClick(e) {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    if (act === 'toggle') {
      if (onMenuScreen() && cfg.open && !isOpen()) forcedOpenOn = screenId();
      else { cfg.open = !cfg.open; forcedOpenOn = null; saveCfg(); }
      render();
    }
    else if (act === 'tab') { cfg.tab = el.dataset.tab; saveCfg(); render(); refreshTab(true); }
    else if (act === 'hunt-start') startHunt();
    else if (act === 'hunt-stop') stopHunt('Caça parada.');
    else if (act === 'notif') { try { Notification.requestPermission().then(render); } catch { /* ignore */ } }
    else if (act === 'clear-log') { huntLog = []; saveLog(); render(); }
    else if (act === 'sim') { bossCache.key = null; refreshTab(true); }
    else if (act === 'order') runOrder();
  }

  function onChange(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.cfg) {
      if (el.dataset && el.dataset.def) { ui[el.dataset.def] = el.value; renderBody(); }
      return;
    }
    const k = el.dataset.cfg;
    cfg[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    saveCfg();
    if (e.type === 'change' && el.tagName === 'SELECT') render();
  }

  let drag = null;
  function dragStart(e) {
    if (!e.target.closest('.pkc-head') || e.target.closest('[data-act]')) return;
    const r = root.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    const move = ev => {
      const x = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - drag.dx));
      const y = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - drag.dy));
      root.style.left = x + 'px'; root.style.top = y + 'px'; root.style.bottom = 'auto';
      cfg.x = x; cfg.y = y;
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); saveCfg(); drag = null; };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const sprite = m => m && m.spriteUrl ? `<img class="pkc-spr" src="${esc(m.spriteUrl)}" alt="">` : '';
  const monRow = m => `<li>${sprite(m)}<span>${m.isAurora ? '🌈' : m.isShiny ? '✨' : ''}${esc(m.name)} <small>Lv${m.level}</small><br>${(m.types || []).map(typeChip).join('')}</span></li>`;
  const typeChip = t => `<span class="pkc-t pkc-t-${esc(String(t).toLowerCase())}">${esc(tType(t))}</span>`;

  // Fora de uma run (tela inicial, escolha de região/inicial) o painel fica só na barrinha
  // pra não tapar os botões do jogo. Abrir na mão (+) vale até sair dessas telas.
  const MENU_SCREENS = ['title-screen', 'history-region-select', 'trainer-screen', 'starter-screen',
    // telas de escolha: as notas já aparecem nos cards, o painel só atrapalharia
    'item-screen', 'passive-screen', 'stat-buff-screen'];
  let forcedOpenOn = null;
  const onMenuScreen = () => MENU_SCREENS.includes(screenId());
  function isOpen() {
    if (!cfg.open) return false;
    return !onMenuScreen() || forcedOpenOn === screenId();
  }

  function render() {
    if (!root) return;
    const tabs = [['hunt', 'Caça'], ['fight', 'Luta'], ['team', 'Time'], ['types', 'Tipos']];
    const open = isOpen();
    root.className = open ? 'pkc-open' : 'pkc-closed';
    root.innerHTML = `
      <div class="pkc-head">
        <span class="pkc-ball" aria-hidden="true"><img src="img/sprites/items/ultra-ball.png" alt="" onerror="this.remove()"></span>
        <span class="pkc-title">COMPANION</span>
        ${hunt.running ? '<span class="pkc-live">CAÇANDO</span>' : ''}
        <button class="pkc-x" data-act="toggle" title="Abrir/fechar">${open ? '–' : '+'}</button>
      </div>
      ${open ? `
      <div class="pkc-tabs">${tabs.map(([id, l]) => `<button data-act="tab" data-tab="${id}" class="${cfg.tab === id ? 'on' : ''}"><span class="pkc-cur">▶</span>${l}</button>`).join('')}</div>
      <div class="pkc-body"></div>` : ''}`;
    renderBody();
  }

  function renderBody() {
    const body = root && root.querySelector('.pkc-body');
    if (!body) return;
    const b = blocked();
    if (b && cfg.tab !== 'types') { body.innerHTML = `<p class="pkc-muted">${esc(b)}</p>`; return; }
    if (cfg.tab === 'hunt') body.innerHTML = huntView();
    else if (cfg.tab === 'fight') body.innerHTML = fightView();
    else if (cfg.tab === 'team') body.innerHTML = teamView();
    else body.innerHTML = typesView();
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
    return `
      <label>Alvo
        <select data-cfg="huntTarget">
          <option value="shiny" ${cfg.huntTarget === 'shiny' ? 'selected' : ''}>Shiny (ou Aurora)</option>
          <option value="aurora" ${cfg.huntTarget === 'aurora' ? 'selected' : ''}>Só Aurora</option>
          <option value="species" ${cfg.huntTarget === 'species' ? 'selected' : ''}>Pokémon específico</option>
        </select>
      </label>
      ${cfg.huntTarget === 'species' ? `
        <label>Nomes (separados por vírgula)<input data-cfg="huntSpecies" value="${esc(cfg.huntSpecies)}" placeholder="abra, dratini"></label>
        <label class="pkc-check"><input type="checkbox" data-cfg="huntSpeciesNeedShiny" ${cfg.huntSpeciesNeedShiny ? 'checked' : ''}> precisa ser shiny</label>` : ''}
      <div class="pkc-row">
        <label>Pausa (ms)<input type="number" min="0" max="5000" step="50" data-cfg="huntDelay" value="${cfg.huntDelay}"></label>
        <label>Máx. tentativas<input type="number" min="1" max="100000" data-cfg="huntMax" value="${cfg.huntMax}"></label>
      </div>
      <label class="pkc-check"><input type="checkbox" data-cfg="huntSound" ${cfg.huntSound ? 'checked' : ''}> som ao achar</label>
      ${window.Notification && Notification.permission === 'default' ? '<button class="pkc-link" data-act="notif">ativar notificação do navegador</button>' : ''}
      <div class="pkc-row">
        ${hunt.running
          ? '<button class="pkc-btn pkc-stop" data-act="hunt-stop">Parar</button>'
          : '<button class="pkc-btn" data-act="hunt-start">Começar caça</button>'}
      </div>
      <div class="pkc-dialog ${hunt.found ? 'pkc-dialog-found' : ''}">
        <div>Chance por reset: <b>${(perReset * 100).toFixed(2)}%</b> <small>(~${expected} resets em média)</small></div>
        <div>Shiny base: ${(p * 100).toFixed(1)}% por Pokémon${aur ? ` · Aurora: ${Math.round(aur * 100)}% dos shinies` : ' · Aurora: só no Battle Tower'}</div>
        ${hunt.attempts ? `
          <div class="pkc-meter"><span class="pkc-meter-lbl">RESETS</span><b>${hunt.attempts}</b><span class="pkc-meter-sub">${secs}s</span></div>
          <div class="pkc-bar pkc-bar-exp" title="Chance de já ter saído um alvo até agora"><span style="width:${Math.round(chanceSoFar * 100)}%"></span></div>
          <div class="pkc-meter-sub">Já devia ter saído com ${pct(chanceSoFar)} de chance</div>` : ''}
        ${hunt.lastSeen ? `<div class="pkc-muted">Último: ${esc(hunt.lastSeen)}</div>` : ''}
        ${hunt.msg ? `<div class="pkc-msg ${hunt.found ? 'pkc-found' : ''}">${esc(hunt.msg)}</div>` : ''}
        <span class="pkc-next" aria-hidden="true">▼</span>
      </div>
      <p class="pkc-muted">Faz o mesmo que você: R (reset) → clica no nó de captura da esquerda → confere as 3 opções. Para sozinho quando acha. Apertar qualquer tecla ou clicar no jogo pausa.</p>
      ${huntLog.length ? `<details><summary>Histórico (${huntLog.length})</summary>
        <ul class="pkc-log">${huntLog.slice().reverse().map(h => `<li>${h.kind === 'AURORA' ? '🌈' : '✨'} ${esc(h.name)} — ${h.attempts} resets, ${h.secs}s <small>${new Date(h.at).toLocaleString()}</small></li>`).join('')}</ul>
        <button class="pkc-link" data-act="clear-log">limpar</button></details>` : ''}`;
  }

  function fightView() {
    const s = S();
    if (!s || !s.team || !s.team.length) return '<p class="pkc-muted">Comece uma run para ver as previsões.</p>';
    const boss = ui.boss;
    let h = '';
    if (!boss) {
      h += `<p class="pkc-muted">${s.currentMap >= 8 && !s.isEndlessMode ? 'Elite Four / Campeão: previsão ainda não suportada.' : 'Calculando próximo chefe…'}</p>`;
    } else {
      const w = ui.bossWin;
      const hpCls = !w ? '' : w.p >= 0.5 ? 'pkc-hp-hi' : w.p >= 0.2 ? 'pkc-hp-mid' : 'pkc-hp-lo';
      h += `<div class="pkc-boss"><span class="pkc-lbl">PRÓXIMO CHEFE</span><b>${esc(boss.name)}</b> ${boss.type ? typeChip(boss.type) : ''}${boss.approx ? ' <small>(aprox.)</small>' : ''}</div>
        <ul class="pkc-mons pkc-sprites">${boss.team.map(monRow).join('')}</ul>
        <div class="pkc-win">
          <div class="pkc-win-top"><span class="pkc-lbl">CHANCE DE VITÓRIA</span><b>${w ? pct(w.p) : '…'}</b></div>
          <div class="pkc-hpbar"><span class="pkc-hp-tag">HP</span><div class="pkc-bar ${hpCls}"><span style="width:${w ? Math.round(w.p * 100) : 0}%"></span></div></div>
          ${w && w.p > 0 ? `<div class="pkc-meter-sub">Sobram ~${w.avgSurvivors.toFixed(1)} Pokémon vivos quando você ganha</div>` : ''}
        </div>
        <div class="pkc-row"><button class="pkc-btn" data-act="sim">Recalcular</button>
        <button class="pkc-btn" data-act="order" ${ui.orderBusy || s.team.length < 2 ? 'disabled' : ''}>Melhor ordem</button></div>`;
      if (ui.orderBusy) h += `<div class="pkc-muted">Testando ordens… ${Math.round((ui.orderProgress || 0) * 100)}%</div>`;
      if (ui.order) {
        const o = ui.order;
        const same = o.best.order.every((v, i) => v === i) || (o.current && o.best.score - o.current.score < 0.005);
        const alive = x => x && x.p > 0 ? `, ~${x.alive.toFixed(1)} vivos` : '';
        h += same
          ? `<div class="pkc-good">Sua ordem atual já é a melhor (${pct(o.current ? o.current.p : o.best.p)}${alive(o.current || o.best)}).</div>`
          : `<div>Melhor ordem: <b>${pct(o.best.p)}</b>${alive(o.best)} <small>(atual: ${pct(o.current && o.current.p)}${alive(o.current)})</small></div>
             <ol class="pkc-mons pkc-sprites pkc-order">${o.best.order.map((i, n) => s.team[i] ? `<li><b class="pkc-num">${n + 1}</b>${sprite(s.team[i])}<span>${esc(s.team[i].name)} <small>Lv${s.team[i].level}</small></span></li>` : '').join('')}</ol>
             <p class="pkc-muted">Arraste no time do jogo (ou na tela de preparação do chefe) pra ficar nessa ordem.</p>`;
      }
      h += `<p class="pkc-muted">${cfg.sims} lutas simuladas com o próprio motor do jogo, usando o HP atual do time.</p>`;
    }
    // ameaças contra o chefe
    if (boss) {
      const threats = boss.team.map(e => {
        const et = moveType(e);
        const hurt = s.team.filter(m => eff(et, m.types) >= 2).map(m => m.name);
        const answers = s.team.filter(m => eff(moveType(m), e.types) >= 2).map(m => m.name);
        return `<li>${esc(e.name)} ataca com ${typeChip(et)} — ${hurt.length ? `<span class="pkc-bad">bate forte em ${esc(hurt.join(', '))}</span>` : 'sem vantagem sobre você'}; ${answers.length ? `<span class="pkc-good">resposta: ${esc(answers.join(', '))}</span>` : '<span class="pkc-bad">ninguém bate 2x nele</span>'}</li>`;
      });
      h += `<details open><summary>Duelo de tipos</summary><ul class="pkc-list">${threats.join('')}</ul></details>`;
    }
    h += `<details><summary>Dicas na tela do jogo</summary>
      <label class="pkc-check"><input type="checkbox" data-cfg="catchAdvisor" ${cfg.catchAdvisor ? 'checked' : ''}> na captura</label>
      <label class="pkc-check"><input type="checkbox" data-cfg="choiceAdvisor" ${cfg.choiceAdvisor ? 'checked' : ''}> notas S+ a C em relíquias, itens e boosts</label>
      <p class="pkc-muted">S+ ≥ 14 · S ≥ 9 · A ≥ 5 · B ≥ 1,5 · C abaixo. Os pontos somam a simulação contra o próximo chefe e a sinergia com o seu time. Se a luta for fácil ou difícil demais, a simulação aumenta a vida de um dos lados até ficar perto de 50%, pra conseguir medir a diferença entre as opções.</p></details>`;
    return h;
  }

  function teamView() {
    const s = S();
    if (!s || !s.team || !s.team.length) return '<p class="pkc-muted">Sem time ainda.</p>';
    const team = s.team;
    const def = teamDefense(team);
    const off = teamOffense(team);
    const holes = off.filter(o => o.best < 1).map(o => o.type);
    const noSE = off.filter(o => o.best < 2).map(o => o.type);
    // Estilo "tela do time": sprite, nome, nível, barra de HP e o golpe que ele usa.
    let h = `<ul class="pkc-party">${team.map(m => {
      const mv = moveOf(m);
      const hp = m.maxHp ? Math.max(0, m.currentHp) / m.maxHp : 0;
      const cls = hp > 0.5 ? 'pkc-hp-hi' : hp > 0.2 ? 'pkc-hp-mid' : 'pkc-hp-lo';
      return `<li>${sprite(m)}<div class="pkc-party-info">
        <div class="pkc-party-name">${m.isAurora ? '🌈' : m.isShiny ? '✨' : ''}${esc(m.name)}<small>Lv${m.level}</small></div>
        <div class="pkc-hpbar"><span class="pkc-hp-tag">HP</span><div class="pkc-bar ${cls}"><span style="width:${Math.round(hp * 100)}%"></span></div></div>
        <div class="pkc-party-sub">${(m.types || []).map(typeChip).join('')}${mv ? ` → ${esc(mv.name)} ${typeChip(mv.type)}` : ''}</div>
      </div></li>`;
    }).join('')}</ul>`;
    const top = def.filter(d => d.weak > 0).slice(0, 5);
    h += `<details open><summary>Fraquezas do time</summary>${top.length ? `<ul class="pkc-list">${top.map(d => `<li>${typeChip(d.type)} acerta 2x em <b>${d.weak}</b>${d.resist + d.immune ? `, ${d.resist + d.immune} resiste` : ''}</li>`).join('')}</ul>` : '<p class="pkc-good">Nenhuma fraqueza compartilhada.</p>'}</details>`;
    h += `<details open><summary>Cobertura de ataque</summary>
      <p>Sem golpe super efetivo contra: ${noSE.length ? noSE.map(typeChip).join('') : '<span class="pkc-good">nenhum — cobertura total!</span>'}</p>
      ${holes.length ? `<p class="pkc-bad">Resistem a todos os seus golpes: ${holes.map(typeChip).join('')}</p>` : ''}
      <p class="pkc-muted">Cada Pokémon ataca só com o tipo do golpe dele (o 1º tipo que não é Normal).</p></details>`;
    if (traitsMatter()) {
      const pts = traitPoints(team);
      const tiers = traitTiers(team);
      const rows = Object.keys(pts).sort((a, b) => pts[b] - pts[a]).map(t => {
        const tier = tiers[t] || 0;
        const next = (Math.floor(pts[t] / 2) + 1) * 2;
        return `<li>${typeChip(t)} <b>T${tier}</b> <small>${pts[t]} pts · próximo tier com ${next}</small></li>`;
      });
      h += `<details open><summary>Traits</summary><ul class="pkc-list">${rows.join('')}</ul>
        <p class="pkc-muted">Cada Pokémon = 1 pt por tipo (shiny 2, aurora 3). A cada 2 pts, +1 tier. Um tipo que está em número ímpar de pts sobe de tier com só mais 1.</p></details>`;
    } else {
      h += '<p class="pkc-muted">Traits só valem no Battle Tower / Challenges.</p>';
    }
    return h;
  }

  function typesView() {
    const types = TYPES();
    const opt = sel => `<option value="">—</option>${types.map(t => `<option value="${t}" ${sel === t ? 'selected' : ''}>${esc(tType(t))}</option>`).join('')}`;
    let h = `<div class="pkc-row"><label>Defensor<select data-def="defA">${opt(ui.defA)}</select></label>
      <label>2º tipo<select data-def="defB">${opt(ui.defB)}</select></label></div>`;
    const def = [ui.defA, ui.defB].filter(Boolean);
    if (def.length) {
      const groups = { 4: [], 2: [], 0.5: [], 0.25: [], 0: [] };
      types.forEach(a => { const e = eff(a, def); if (groups[e]) groups[e].push(a); });
      const g = (label, arr, cls) => arr.length ? `<div class="${cls}">${label}: ${arr.map(typeChip).join('')}</div>` : '';
      h += g('4x', groups[4], 'pkc-bad') + g('2x', groups[2], 'pkc-bad') + g('½x', groups[0.5], 'pkc-good') + g('¼x', groups[0.25], 'pkc-good') + g('Imune', groups[0], 'pkc-good');
      const s = S();
      if (s && s.team && s.team.length) {
        const ans = s.team.map(m => ({ m, e: eff(moveType(m), def) })).sort((a, b) => b.e - a.e);
        h += `<p>Seu time contra ele: ${ans.map(x => `${esc(x.m.name)} <b>${x.e}x</b>`).join(' · ')}</p>`;
      }
    } else {
      h += '<p class="pkc-muted">Escolha 1 ou 2 tipos pra ver fraquezas e resistências (usa a tabela do próprio jogo, inclusive no desafio Inverse).</p>';
    }
    return h;
  }

  async function runOrder() {
    const s = S();
    if (!ui.boss || !s || ui.orderBusy) return;
    ui.orderBusy = true; ui.order = null; ui.orderProgress = 0; renderBody();
    const r = await bestOrder(s.team.slice(), ui.boss.team, p => { ui.orderProgress = p; if (cfg.tab === 'fight') renderBody(); });
    ui.orderBusy = false;
    if (r) ui.order = r;
    renderBody();
  }

  // ----------------------------------------------------------- refresh loop ---
  function signature() {
    const s = S();
    if (!s) return 'none|' + screenId();
    return [screenId(), s.runSeed, s.currentMap, (s.team || []).map(m => `${m._uid}:${m.level}:${m.currentHp}`).join(','), s.currentNode && s.currentNode.id].join('|');
  }

  let fightJob = null;
  async function refreshTab(force) {
    if (!isOpen()) return;
    if (cfg.tab === 'fight' && !blocked() && !hunt.running) {
      const s = S();
      if (s && s.team && s.team.length) {
        const prev = ui.boss;
        ui.boss = await nextBoss();
        if (force || ui.boss !== prev || !ui.bossWin) {
          if (ui.boss !== prev) ui.order = null;
          cancelJob(fightJob);
          const job = fightJob = { cancelled: false };
          renderBody();
          try {
            ui.bossWin = ui.boss ? await winRate(s.team, ui.boss.team, cfg.sims, job) : null;
          } catch (e) { if (e !== CANCELLED) throw e; return; }
        }
      }
    }
    renderBody();
  }

  /** Roda uma dica em segundo plano (uma por vez); cancelamento não é erro. */
  let advisorBusy = false;
  function runAdvisor(f) {
    if (advisorBusy) return;
    advisorBusy = true;
    sliceStart = performance.now();
    f().catch(e => { if (e !== CANCELLED) console.warn('[Pokelike Companion] dica', e); })
      .finally(() => { advisorBusy = false; });
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const sig = signature();
      if (sig !== ui.lastSig) {
        const screenChanged = sig.split('|')[0] !== ui.lastSig.split('|')[0];
        ui.lastSig = sig;
        if (screenChanged) { if (forcedOpenOn && forcedOpenOn !== screenId()) forcedOpenOn = null; render(); }
        ui.bossWin = null; ui.order = null;
        if (screenChanged) cancelJob(advJob);
        if (!hunt.running) refreshTab(false).catch(e => console.warn('[Pokelike Companion] refresh', e));
      }
      if (hunt.running && cfg.tab === 'hunt') renderBody();
      if (!hunt.running && ['item-screen', 'passive-screen', 'stat-buff-screen'].includes(screenId())) runAdvisor(choiceAdvisor);
      if (screenId() === 'catch-screen') {
        if (hunt.running) highlightCatchCards(); else runAdvisor(catchAdvisor);
      }
    } catch (e) {
      console.warn('[Pokelike Companion] tick', e);
    } finally {
      ticking = false;
    }
  }

  // ------------------------------------------------------------------ boot ---
  (async () => {
    const ok = await waitFor(() => fn('runBattle') && fn('getRngSeed') && fn('executeResetRun') && document.body, 60000, 250);
    if (!ok) { console.warn('[Pokelike Companion] jogo não carregou as funções esperadas — versão nova?'); return; }
    mount();
    setInterval(tick, 600);
    // reserva o espaço das dicas antes de a tela ser pintada (callback roda antes do paint)
    new MutationObserver(() => { try { reserveAdviceSpace(); } catch { /* ignore */ } })
      .observe(document.body, { childList: true, subtree: true });
    console.info('[Pokelike Companion] pronto');
  })();
})();
