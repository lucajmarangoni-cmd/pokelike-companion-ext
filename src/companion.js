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
    mode: 'compact',          // compact (barra com o essencial) | extended (abas completas)
    routeAdvisor: true,       // trilha sugerida no mapa
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
    return [s.runSeed, s.currentMap, s.eliteIndex || 0, s.isEndlessMode ? 1 : 0, s.gen2Mode, s.gen3Mode, s.gen4Mode, s.gen5Mode, s.gen6Mode,
      es && es.regionNumber, es && es.mapIndexInRegion].join('|');
  }

  /**
   * Membros restantes da Elite Four (a partir do atual), montados como o jogo monta:
   * mesmos níveis, golpes no nível máximo e itens do ás. Só cria instâncias (sem RNG).
   */
  async function eliteMembers() {
    const s = S();
    let list = null;
    try {
      list = s.gen6Mode ? KALOS_ELITE_4 : s.gen5Mode ? UNOVA_ELITE_4 : s.gen4Mode ? SINNOH_ELITE_4
        : s.gen3Mode ? HOENN_ELITE_4 : s.gen2Mode ? GEN2_ELITE_4 : ELITE_4;
    } catch { return []; }
    if (!Array.isArray(list)) return [];
    const mult = s.challengeLevelMult || 1;
    let uid; try { uid = _pokeUidCounter; } catch { uid = undefined; }
    try {
      const out = [];
      for (let i = s.eliteIndex || 0; i < list.length; i++) {
        const m = list[i];
        let base = await window.resolveTrainerTeamEvolutions(m.team);
        if (fn('gen1AceOnlyHeldItems')) base = window.gen1AceOnlyHeldItems(base);
        const lvl = x => (fn('slEnemyLevel') ? window.slEnemyLevel(Math.max(1, Math.round(x.level * mult))) : x.level);
        const team = base.map(x => (s.gen6Mode && fn('kalosBuildEnemy'))
          ? window.kalosBuildEnemy(x, lvl(x), 2)
          : { ...window.createInstance(x, lvl(x), false, 2), heldItem: x.heldItem || null, ...(x.hiddenAbility ? { _hiddenAbility: true } : {}) });
        out.push({ name: m.name, team });
      }
      return out;
    } finally {
      try { if (uid !== undefined) _pokeUidCounter = uid; } catch { /* ignore */ }
    }
  }

  /** "vence tudo: 12%" ou, se for baixo, até onde costuma chegar. */
  function gauntletText(g, members) {
    if (g.all >= 0.1) return `vence todos em sequência: <b>${pct(g.all)}</b>`;
    // primeiro membro em que a chance de passar cai abaixo de 50%
    const k = g.perMember.findIndex(p => p < 0.5);
    const who = members[Math.max(0, k)] ? members[Math.max(0, k)].name : 'o fim';
    return `vence todos: <b>${pct(g.all)}</b> · costuma parar em <b>${esc(who)}</b>`;
  }

  /** Liga inteira em sequência: o HP NÃO recupera entre os membros. */
  async function simGauntlet(team, members, n, job) {
    const s = S();
    const reach = members.map(() => 0);
    let all = 0;
    for (let i = 0; i < n; i++) {
      const won = guarded(() => {
        window.seedRng((Math.random() * 4294967296) >>> 0);
        let pt = clone(team);
        for (let k = 0; k < members.length; k++) {
          const cur = clone(pt);
          try { if (fn('applyMegaEvolution')) cur.forEach(window.applyMegaEvolution); } catch { /* ignore */ }
          const res = window.runBattle(cur, clone(members[k].team), s.items || [], [], null, battleConfig(cur), s.passives || []);
          if (!res || !res.playerWon) return k;
          reach[k]++;
          // leva o HP de cada um pra próxima luta
          pt = pt.map((mon, j) => ({ ...mon, currentHp: Math.max(0, ((res.pTeam || [])[j] || mon).currentHp) }));
        }
        return members.length;
      });
      if (won === members.length) all++;
      await breathe(job);
    }
    return { all: all / n, perMember: reach.map(r => r / n), n };
  }

  /** Time do próximo chefe (líder de ginásio / treinador do Battle Tower). */
  async function nextBoss() {
    const key = bossKey();
    if (!key) return null;
    if (bossCache.key === key) return bossCache.data;
    const s = S();
    let data = null;
    try {
      if (!s.isEndlessMode && s.currentMap >= 8) {
        const members = await eliteMembers();
        if (members.length) data = { name: members[0].name, team: members[0].team, approx: false, elite: members };
      } else if (!s.isEndlessMode && fn('campaignGymTeam') && s.currentMap < 8) {
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
  async function bestOrder(team, enemy, onProgress, outerJob = null) {
    const job = {}; orderJob = job;
    const idx = team.map((_, i) => i);
    const all = [...permutations(idx)];
    const quick = all.length > 120 ? 12 : all.length > 24 ? 30 : 60;
    const scored = [];
    let t = performance.now();
    for (let k = 0; k < all.length; k++) {
      if (orderJob !== job) return null;
      const order = all[k];
      const r = await winRate(order.map(i => team[i]), enemy, quick, outerJob);
      scored.push({ order, p: r.p, alive: r.avgSurvivors, score: orderScore(r, team.length) });
      if (performance.now() - t > 25) { onProgress && onProgress(k / all.length * 0.6); await sleep(0); t = performance.now(); }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 8);
    // garante que a ordem atual também entra no refinamento
    if (!top.some(x => x.order.every((v, i) => v === i))) top.push({ order: idx, p: 0, alive: 0, score: 0 });
    for (let k = 0; k < top.length; k++) {
      if (orderJob !== job) return null;
      const r = await winRate(top[k].order.map(i => team[i]), enemy, 200, outerJob);
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
    // "NOVO NA DEX" só quando diferencia as opções (se todas são novas, não ajuda a escolher)
    const dx = dexes();
    const newOnes = inst.filter(c => !inDex(dx.dex, c.speciesId)).length;
    const showNew = newOnes > 0 && newOnes < inst.length;
    const staticLines = inst.map(cand => {
      const lines = [];
      if (cand.isAurora) lines.push('<b class="pkc-aurora">🌈 AURORA</b>');
      else if (cand.isShiny) lines.push('<b class="pkc-shiny">✨ SHINY</b>');
      const mt = moveType(cand);
      const d = dexes();
      const tags = [];
      if ((cand.isShiny || cand.isAurora) && !inDex(d.shiny, cand.speciesId)) tags.push('<span class="pkc-pill pkc-pill-sh">SHINY NOVO</span>');
      else if (showNew && !inDex(d.dex, cand.speciesId)) tags.push('<span class="pkc-pill">NOVO NA DEX</span>');
      lines.push(`Ataca com <span class="pkc-t pkc-t-${mt.toLowerCase()}">${esc(tType(mt))}</span> ${tags.join('')}`);
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
    equalizeHeights(boxes);
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
    }
    equalizeHeights(boxes);    advisorKey = key; // só marca como pronto quando terminou tudo (se cancelar no meio, refaz)
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
            ensureGap(c);
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

  const tierCls = res => 'pkc-tier-' + res.tier.replace('+', 'p');

  /** Caixa compacta (tamanho fixo) que vai na base do card: nota + o essencial. */
  function tierBadge(res, isBest) {
    // na caixa compacta o motivo vai encurtado; o texto completo fica na janelinha do mouse
    const short = w => String(w || '').replace(/ na simulação contra .*/, ' na simulação').replace(/^Quase não muda a luta contra .*/, 'Quase não muda a luta');
    const line1 = res.holder ? `${res.verb || 'Equipar em'} <b>${esc(res.holder.name)}</b>` : esc(short(res.why[0]));
    const line2 = res.holder ? esc(short(res.why[0])) : esc(short(res.why[1]));
    return `<div class="pkc-tier ${tierCls(res)}">
      <span class="pkc-tier-g">${res.tier}</span>
      <div class="pkc-tier-txt"><div class="pkc-tier-l1">${line1}</div><div class="pkc-tier-l2">${line2}</div></div>
      ${isBest ? '<span class="pkc-tier-best">MELHOR</span>' : ''}</div>`;
  }

  /** Janelinha com todos os motivos, aberta ao passar o mouse no card. */
  function tierDetails(res) {
    return `<div class="pkc-pop-head"><span class="pkc-tier-g ${tierCls(res)}">${res.tier}</span>
      ${res.holder ? `<span>${res.verb || 'Equipar em'} <b>${esc(res.holder.name)}</b></span>` : ''}</div>
      <ul>${res.why.map(w => `<li>${esc(w)}</li>`).join('')}</ul>`;
  }

  const popHtml = new WeakMap();
  let pop = null;
  function showPop(card) {
    const html = popHtml.get(card);
    if (!html) return;
    if (!pop) { pop = document.createElement('div'); pop.id = 'pkc-pop'; document.body.appendChild(pop); }
    pop.innerHTML = html;
    pop.style.display = 'block';
    const r = card.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8); // sem espaço embaixo: abre em cima
    pop.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
    pop.style.top = top + 'px';
  }
  const hidePop = () => { if (pop) pop.style.display = 'none'; };
  document.addEventListener('mouseover', e => {
    const card = e.target.closest && e.target.closest('.pkc-has-tip');
    if (card) showPop(card); else hidePop();
  }, true);
  document.addEventListener('pointerdown', hidePop, true);

  /** Todas as caixas de uma tela com a mesma altura (a da maior), pra ficarem alinhadas. */
  function equalizeHeights(boxes) {
    boxes = boxes.filter(Boolean);
    if (boxes.length < 2) return;
    boxes.forEach(b => { b.style.minHeight = ''; });
    const h = Math.max(...boxes.map(b => b.offsetHeight));
    boxes.forEach(b => { b.style.minHeight = h + 'px'; });
  }

  function ensureGap(card) {
    // espaçador flexível: empurra a nota pra base, mas nunca deixa menos de 10px até o texto
    let gap = card.querySelector(':scope > .pkc-gap');
    if (!gap) { gap = document.createElement('div'); gap.className = 'pkc-gap'; }
    const box = card.querySelector(':scope > .pkc-tier');
    card.insertBefore(gap, box || null);
  }

  function paintCards(cards, results) {
    const valid = results.filter(Boolean);
    const sorted = valid.map(r => r.score).sort((a, b) => b - a);
    // "★ MELHOR" só quando um ganha com folga (empate não tem melhor)
    const bestScore = sorted.length > 1 && sorted[0] - sorted[1] >= 1 ? sorted[0] : null;
    cards.forEach((card, i) => {
      const r = results[i];
      let box = card.querySelector(':scope > .pkc-tier');
      if (!r) { if (box) box.remove(); card.classList.remove('pkc-has-tip'); return; }
      if (!box) { box = document.createElement('div'); card.appendChild(box); }
      box.outerHTML = tierBadge(r, r.score === bestScore && r.tier !== 'C');
      ensureGap(card);
      popHtml.set(card, tierDetails(r));
      card.classList.add('pkc-has-tip');
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
    ui.boss = await nextBoss(); // sempre o chefe atual (resposta guardada por posição na run)
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
      ui.lastHolders = ids.map((id, i) => { const it = itemById(id); const r = results[i]; return it && r && r.holder ? { itemName: itemNameOf(it), uid: r.holder._uid, tier: r.tier } : null; }).filter(Boolean);
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
    jobs: () => ({ advisorBusy, advKey: advJob && advJob.key, advCancelled: advJob && advJob.cancelled, prepKey, screen: screenId() }),
    buffs: async () => (await buffTable('debug-' + Date.now())).map(r => ({ mon: r.mon.name, best: r.best && r.best.label, stats: r.stats.map(x => x.label + ':' + (x.res ? x.res.tier + ' ' + x.res.score.toFixed(1) : '-')).join(' ') })),
  };

  // ------------------------------------------------------ decisões da run ---

  // ---- rota no mapa: soma o valor de cada nó no caminho até o chefe
  const NODE_LABEL = {
    catch: 'Captura', battle: 'Selvagem', trainer: 'Treinador', item: 'Item', pokecenter: 'Centro', question: '?',
    legendary: 'Lendário', move_tutor: 'Tutor', trade: 'Troca', pokemart: 'Loja', boss: 'Chefe', moonstone: 'Pedra',
    levelup: 'Nível+', mutation: 'Mutante', evilteam: 'Vilões', silver: 'Rival', rival_n: 'Rival', masterball: 'Master Ball',
    magma: 'Vilões', aqua: 'Vilões', reward: 'Prêmio', underground: 'Subsolo', distortion: 'Distorção',
  };
  function nodeValue(n, ctx) {
    switch (n.type) {
      case 'catch': return ctx.room ? (ctx.size <= 2 ? 8 : 6) : 2;
      case 'pokecenter': return 1 + ctx.missing * 14 + (ctx.fainted ? 5 : 0);
      case 'item': return 4;
      case 'legendary': return 9;
      case 'masterball': return 7;
      case 'levelup': return 5;
      case 'moonstone': return ctx.canEvolve ? 4 : 0.5;
      case 'move_tutor': return ctx.canTutor ? 3.5 : 0.5;
      case 'question': return 3.5;
      case 'trainer': case 'evilteam': case 'magma': case 'aqua': case 'silver': case 'rival_n':
        return ctx.missing > 0.5 ? 1 : 3;
      case 'battle': return ctx.missing > 0.5 ? 0.5 : 2;
      case 'trade': return 2;
      case 'mutation': return 3;
      case 'pokemart': return 1;
      default: return 2;
    }
  }

  function planRoute() {
    const s = S();
    if (!s || !s.map || !s.map.nodes || !s.team || !s.team.length) return null;
    const nodes = s.map.nodes, out = {};
    for (const e of s.map.edges || []) (out[e.from] = out[e.from] || []).push(e.to);
    const maxHp = s.team.reduce((a, m) => a + (m.maxHp || 0), 0) || 1;
    const curHp = s.team.reduce((a, m) => a + Math.max(0, m.currentHp || 0), 0);
    const ctx = {
      size: s.team.length, room: s.team.length < 6, missing: 1 - curHp / maxHp,
      fainted: s.team.some(m => m.currentHp <= 0),
      canEvolve: s.team.some(m => { try { return window.canEverEvolve(m); } catch { return false; } }),
      canTutor: s.team.some(m => (m.moveTier != null ? m.moveTier : 1) < 2),
    };
    const memo = {};
    const best = id => {
      if (memo[id]) return memo[id];
      const n = nodes[id];
      const kids = (out[id] || []).filter(k => nodes[k]);
      let tail = { v: 0, path: [] };
      for (const k of kids) { const r = best(k); if (r.v > tail.v || !tail.path.length) tail = r; }
      return (memo[id] = { v: (n && n.type !== 'boss' ? nodeValue(n, ctx) : 0) + tail.v, path: [id, ...tail.path] });
    };
    const starts = window.getAccessibleNodes(s.map);
    if (!starts.length) return null;
    let pick = null;
    for (const n of starts) { const r = best(n.id); if (!pick || r.v > pick.v) pick = r; }
    const types = pick.path.map(id => nodes[id].type);
    const labels = types.map(t => NODE_LABEL[t] || t);
    let why = 'Soma o valor dos nós até o chefe: captura vale mais com espaço no time, centro vale mais com HP baixo.';
    if (types.includes('pokecenter') && ctx.missing > 0.3) why = `Passa no Centro: o time está com ${Math.round((1 - ctx.missing) * 100)}% do HP.`;
    else if (types[0] === 'catch' && ctx.room) why = 'Começa capturando: ainda tem espaço no time.';
    const from = s.currentNode && nodes[s.currentNode.id] && nodes[s.currentNode.id].visited ? s.currentNode.id
      : (Object.values(nodes).find(n => n.type === 'start') || {}).id;
    return { path: pick.path, from, labels: labels.length > 6 ? [...labels.slice(0, 5), '…', labels[labels.length - 1]] : labels, why };
  }

  function drawRoute(route) {
    const svg = document.querySelector('#map-screen svg');
    if (!svg) return;
    const old = svg.querySelector('.pkc-route');
    if (old) old.remove();
    if (!route || !cfg.routeAdvisor) return;
    // os nós ficam num subgrupo do SVG: desenha nesse mesmo grupo, nas coordenadas dele
    const firstNode = svg.querySelector('g.map-node');
    const layer = firstNode ? firstNode.parentNode : svg;
    const ctm = layer.getScreenCTM && layer.getScreenCTM();
    if (!ctm) return;
    const im = ctm.inverse();
    const center = id => {
      const g = svg.querySelector(`g.map-node[data-node-id="${id}"]`);
      if (!g) return null;
      const r = g.getBoundingClientRect();
      const pt = svg.createSVGPoint(); pt.x = r.left + r.width / 2; pt.y = r.top + r.height / 2;
      return pt.matrixTransform(im);
    };
    const ids = (route.from ? [route.from] : []).concat(route.path);
    const pts = ids.map(center).filter(Boolean);
    if (pts.length < 2) return;
    const ns = 'http://www.w3.org/2000/svg';
    const grp = document.createElementNS(ns, 'g');
    grp.setAttribute('class', 'pkc-route');
    grp.setAttribute('pointer-events', 'none');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
    line.setAttribute('class', 'pkc-route-line');
    for (const [k, v] of Object.entries({ fill: 'none', stroke: '#f8d030', 'stroke-width': '7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': '1 12', opacity: '0.95' })) line.setAttribute(k, v);
    grp.appendChild(line);
    const nextPt = pts[route.from ? 1 : 0];
    const ring = document.createElementNS(ns, 'circle');
    ring.setAttribute('cx', nextPt.x.toFixed(1)); ring.setAttribute('cy', nextPt.y.toFixed(1)); ring.setAttribute('r', '24');
    ring.setAttribute('class', 'pkc-route-next');
    for (const [k, v] of Object.entries({ fill: 'none', stroke: '#f8d030', 'stroke-width': '3' })) ring.setAttribute(k, v);
    grp.appendChild(ring);
    layer.insertBefore(grp, firstNode || null); // por baixo dos nós, por cima das linhas do jogo
  }

  let routeKey = null;
  function routeAdvisor() {
    const s = S();
    if (!cfg.routeAdvisor || hunt.running || blocked() || screenId() !== 'map-screen' || !s || !s.map) return;
    const key = bossKey() + '|' + Object.values(s.map.nodes).filter(n => n.visited).length + '|' + s.team.map(m => `${m._uid}:${m.currentHp}`).join(',');
    const svg = document.querySelector('#map-screen svg');
    if (key !== routeKey) { routeKey = key; ui.route = planRoute(); if (compact()) renderBody(); }
    if (svg && !svg.querySelector('.pkc-route')) drawRoute(ui.route);
  }

  // ---- tela de preparação do chefe (antes de ginásios e de cada membro da Elite Four)
  let prepKey = null;
  async function prepAdvisor() {
    if (!cfg.choiceAdvisor || blocked()) return;
    const s = S();
    const sub = document.getElementById('elite-prep-sub');
    if (!sub || !s.team.length) return;
    ui.boss = await nextBoss(); // sempre o chefe atual (resposta guardada por posição na run)
    const boss = ui.boss;
    if (!boss) return;
    const key = bossKey() + '|' + s.team.map(m => `${m._uid}:${m.currentHp}`).join(',');
    let box = document.getElementById('pkc-prep');
    if (key === prepKey && box) return;
    const job = advJob = { key, cancelled: false };
    if (!box) { box = document.createElement('div'); box.id = 'pkc-prep'; sub.insertAdjacentElement('afterend', box); }
    box.className = 'pkc-prep';
    const paint = (w, g, order) => {
      const cls = !w ? '' : w.p >= 0.5 ? 'pkc-hp-hi' : w.p >= 0.2 ? 'pkc-hp-mid' : 'pkc-hp-lo';
      let orderTxt = '<span class="pkc-muted">Ordem sugerida: calculando…</span>';
      if (order) {
        const same = order.best.order.every((v, i) => v === i) || (order.current && order.best.score - order.current.score < 0.02);
        orderTxt = same ? '<span class="pkc-good">Sua ordem já é a melhor.</span>'
          : `Ordem sugerida: <b>${order.best.order.map(i => esc(s.team[i].name)).join(' › ')}</b> <small>(${pct(order.best.p)} contra ${pct(order.current && order.current.p)})</small>`;
      }
      box.innerHTML = `<div class="pkc-prep-row"><span class="pkc-lbl">CHANCE</span>
          <div class="pkc-bar ${cls}"><span style="width:${w ? Math.round(w.p * 100) : 0}%"></span></div><b>${w ? pct(w.p) : '…'}</b></div>
        ${boss.elite && boss.elite.length > 1 ? `<div class="pkc-prep-row" title="Sem recuperar HP entre as lutas"><span class="pkc-lbl">LIGA</span><span>${g ? gauntletText(g, boss.elite) : 'calculando…'}</span></div>` : ''}
        <div class="pkc-prep-row pkc-prep-order">${orderTxt}</div>`;
    };
    paint(null, null, null);
    const w = await winRate(s.team, boss.team, 200, job);
    paint(w, null, null);
    const g = boss.elite && boss.elite.length > 1 ? await simGauntlet(s.team, boss.elite, 120, job) : null;
    paint(w, g, null);
    const order = s.team.length > 1 ? await bestOrder(s.team.slice(), boss.team, null, job) : null;
    if (job.cancelled) return;
    paint(w, g, order || { best: { order: s.team.map((_, i) => i), score: 0, p: w.p }, current: { score: 0, p: w.p } });
    prepKey = key;
  }

  // ---- troca com time cheio: qual soltar?
  let swapKey = null;
  async function swapAdvisor() {
    if (!cfg.choiceAdvisor || blocked()) return;
    const s = S();
    const choices = document.getElementById('swap-choices');
    if (!choices || s.team.length < 6) return;
    const cards = [...choices.children].filter(c => c.matches('.poke-card') || c.querySelector('.poke-card'));
    if (cards.length !== s.team.length) return;
    const incoming = s.savedCatch && s.savedCatch.pendingSwap || null;
    const inName = (document.querySelector('#swap-incoming .poke-name') || {}).textContent || '';
    const cand = incoming || findIncoming(inName);
    if (!cand) return;
    const key = 'swap|' + cand.name + '|' + s.team.map(m => m._uid).join(',');
    if (key === swapKey && choices.querySelector('.pkc-corner')) return;
    advJob = { key, cancelled: false };
    ui.boss = await nextBoss(); // sempre o chefe atual (resposta guardada por posição na run)
    const ctx = await advisorCtx();
    const results = [];
    for (let j = 0; j < s.team.length; j++) {
      const m = s.team[j];
      const why = [];
      let simPts = null;
      if (ctx.enemy) {
        const t2 = s.team.slice(); t2[j] = cand;
        simPts = ((await simPower(t2, ctx.enemy, s.passives || [])).power - ctx.base.power) * SIM_WEIGHT;
      }
      if (m.isShiny || m.isAurora) why.push(`${m.name} é ${m.isAurora ? 'aurora' : 'shiny'}${traitsMatter() ? ' (vale mais nos traits)' : ''}`);
      if (j === 0) why.push(`${m.name} vai na frente`);
      const res = finish(m.isShiny || m.isAurora ? -2 : 0, simPts, why, null, ctx);
      if (res.why[0]) res.why[0] = res.why[0].replace(/^([+-]?\d+) pts na simulação/, `Trocar por ${cand.name}: $1 pts`).replace(/^Quase não muda a luta/, `Trocar por ${cand.name} quase não muda a luta`);
      results.push(res);
    }
    if (results.every(r => r.score < 1)) results.forEach(r => r.why.push('Talvez valha não trocar (pular)'));
    paintCorners(cards, results);
    swapKey = key;
  }
  /** Selo no canto do card: nota + pontos, sem mudar o tamanho do card. Detalhes no mouse. */
  function paintCorners(cards, results) {
    const sc = results.filter(Boolean).map(r => r.score).sort((a, b) => b - a);
    const bestScore = sc.length > 1 && sc[0] - sc[1] >= 1 && sc[0] >= 1 ? sc[0] : null;
    cards.forEach((c, i) => {
      const card = c.matches('.poke-card') ? c : c.querySelector('.poke-card');
      const r = results[i];
      if (!card) return;
      const old = card.querySelector(':scope > .pkc-corner');
      if (old) old.remove();
      if (!r) return;
      const pts = (r.why[0] || '').match(/([+-]?\d+) pts/);
      const el = document.createElement('div');
      el.className = 'pkc-corner ' + tierCls(r) + (r.score === bestScore ? ' pkc-corner-best' : '');
      el.innerHTML = `<span class="pkc-tier-g">${r.tier}</span>${pts ? (Number(pts[1]) > 0 ? '+' : '') + Number(pts[1]) : '±0'}`;
      card.classList.add('pkc-has-corner', 'pkc-has-tip');
      card.appendChild(el);
      popHtml.set(card, tierDetails(r));
    });
  }

  function findIncoming(name) {
    const s = S();
    const inst = s.savedCatch && Array.isArray(s.savedCatch.instances) ? s.savedCatch.instances : [];
    return inst.find(i => i.name === name.trim()) || null;
  }

  // ---- Move Tutor: em quem vale subir o golpe
  let tutorKey = null;
  async function tutorAdvisor() {
    if (!cfg.choiceAdvisor || blocked()) return;
    const s = S();
    const modal = document.getElementById('item-equip-modal');
    if (!modal || !modal.querySelector('button[data-tutor]')) return;
    const rows = [...modal.querySelectorAll('.equip-pokemon-row')];
    if (rows.length !== s.team.length) return;
    const key = 'tutor|' + s.team.map(m => `${m._uid}:${m.moveTier}`).join(',');
    if (key === tutorKey && modal.querySelector('.pkc-chip')) return;
    advJob = { key, cancelled: false };
    ui.boss = await nextBoss(); // sempre o chefe atual (resposta guardada por posição na run)
    const ctx = await advisorCtx();
    const scored = [];
    for (let i = 0; i < s.team.length; i++) {
      const m = s.team[i];
      if (!rows[i].querySelector('button[data-tutor]') || !ctx.enemy) { scored.push(null); continue; }
      const t2 = s.team.slice(); t2[i] = { ...clone(m), moveTier: Math.min(2, (m.moveTier != null ? m.moveTier : 1) + 1) };
      const pts = ((await simPower(t2, ctx.enemy, s.passives || [])).power - ctx.base.power) * SIM_WEIGHT;
      scored.push(finish(0, pts, [], null, ctx));
    }
    paintChips(rows, scored);
    tutorKey = key;
  }

  /** Selo de nota no fim de cada linha de uma lista (atributos, tutor, equipar). */
  function paintChips(rows, results) {
    const sc = results.filter(Boolean).map(r => r.score).sort((a, b) => b - a);
    const bestScore = sc.length > 1 && sc[0] - sc[1] >= 0.5 ? sc[0] : null;
    rows.forEach((row, i) => {
      const r = results[i];
      const old = row.querySelector('.pkc-chip');
      if (old) old.remove();
      if (!r) return;
      const chip = document.createElement('span');
      chip.className = 'pkc-chip pkc-tier-' + r.tier.replace('+', 'p') + (r.score === bestScore ? ' pkc-chip-best' : '');
      chip.textContent = r.tier;
      chip.title = r.why.join(' · ');
      row.appendChild(chip);
    });
  }

  // ---- ao equipar um item: marca quem a nota sugeriu
  function equipHint() {
    const modal = document.getElementById('item-equip-modal');
    if (!modal || modal.querySelector('button[data-tutor]') || modal.querySelector('.pkc-chip') || !ui.lastHolders) return;
    const header = (modal.querySelector('.equip-item-header') || {}).textContent || '';
    const hit = ui.lastHolders.find(h => h.itemName && header.includes(h.itemName));
    if (!hit) return;
    const s = S();
    const idx = s.team.findIndex(m => m._uid === hit.uid);
    const rows = [...modal.querySelectorAll('.equip-pokemon-row')];
    if (idx < 0 || !rows[idx]) return;
    const chip = document.createElement('span');
    chip.className = 'pkc-chip pkc-chip-best pkc-tier-' + hit.tier.replace('+', 'p');
    chip.textContent = '★';
    chip.title = 'Sugerido pela nota do item';
    rows[idx].appendChild(chip);
  }

  // ------------------------------------------------------------- coleção ---
  const REGIONS = [
    ['Kanto', 1, 151], ['Johto', 152, 251], ['Hoenn', 252, 386],
    ['Sinnoh', 387, 493], ['Unova', 494, 649], ['Kalos', 650, 721],
  ];
  const readDex = name => { try { return (fn(name) && window[name]()) || {}; } catch { return {}; } };
  const speciesName = id => { try { return window.getSpeciesName(id); } catch { return '#' + id; } };
  const spriteOf = id => `img/sprites/pokemon/${id}.png`;

  /** Lê as três Dex uma vez por segundo no máximo (elas vivem no localStorage). */
  let dexCache = { t: 0, dex: {}, shiny: {}, aurora: {} };
  function dexes() {
    if (Date.now() - dexCache.t > 1000) dexCache = { t: Date.now(), dex: readDex('getPokedex'), shiny: readDex('getShinyDex'), aurora: readDex('getAuroraDex') };
    return dexCache;
  }
  const inDex = (d, id) => d[id] === 1 || d[String(id)] === 1;

  function currentRegionIdx() {
    const s = S();
    if (!s) return 0;
    if (s.gen6Mode) return 5; if (s.gen5Mode) return 4; if (s.gen4Mode) return 3; if (s.gen3Mode) return 2; if (s.gen2Mode) return 1;
    return 0;
  }

  /** Espécies que podem aparecer na captura do mapa atual (mesma tabela que o jogo usa). */
  let poolCache = { key: null, ids: [] };
  function mapPoolIds() {
    const s = S();
    if (!s || !s.map || !s.starterSpeciesId) return [];
    const key = bossKey();
    if (poolCache.key === key) return poolCache.ids;
    let ids = [];
    try {
      const idx = window.getEncounterMapIndex();
      const g = fn('handPlacedEncounterGen') ? window.handPlacedEncounterGen() : 0;
      let pool;
      if (g && fn('gen' + g + 'EncounterPool')) pool = window['gen' + g + 'EncounterPool'](idx);
      else {
        const ranges = s.gen5Mode ? GEN5_MAP_BST_RANGES : s.gen4Mode ? GEN4_MAP_BST_RANGES : s.gen3Mode ? GEN3_MAP_BST_RANGES : s.gen2Mode ? GEN2_MAP_BST_RANGES : MAP_BST_RANGES;
        pool = window.getBstBucket(ranges[Math.min(idx, ranges.length - 1)].min, s.isEndlessMode ? 'endless' : s.gen2Mode ? 'gen2' : 'none');
      }
      const { minGenId, maxGenId } = window.getCatchGenRange();
      const legends = typeof LEGENDARY_IDS !== 'undefined' ? new Set(LEGENDARY_IDS) : new Set();
      ids = [...new Set(pool || [])].filter(id => id >= minGenId && id <= maxGenId && !legends.has(id)).sort((a, b) => a - b);
    } catch { ids = []; }
    poolCache = { key, ids };
    return ids;
  }

  let nameIndex = null;
  function searchSpecies(q) {
    q = String(q || '').trim().toLowerCase();
    if (q.length < 2) return [];
    if (!nameIndex) { nameIndex = []; for (let id = 1; id <= 721; id++) nameIndex.push([id, speciesName(id).toLowerCase()]); }
    return nameIndex.filter(([, n]) => n.startsWith(q)).concat(nameIndex.filter(([, n]) => !n.startsWith(q) && n.includes(q))).slice(0, 4).map(([id]) => id);
  }

  function whereToFind(id) {
    let maps = [], tower = [];
    try {
      const entry = fn('getStaticPokedexEntry') ? window.getStaticPokedexEntry(id) : null;
      maps = (window.getPokemonLocations(id, entry && entry.bst) || {}).regularMaps || [];
    } catch { /* ignore */ }
    try { tower = (window.getBattleTowerLocations(id) || []).map(x => x.label); } catch { /* ignore */ }
    return { maps, tower };
  }

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
    else if (act === 'mode') { cfg.mode = compact() ? 'extended' : 'compact'; saveCfg(); render(); refreshTab(false); }
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
      if (el.dataset && el.dataset.ui) {
        ui[el.dataset.ui] = el.dataset.ui === 'dexRegion' ? Number(el.value) : el.value;
        if (el.dataset.ui === 'dexQuery') debounceRender(); else renderBody();
      }
      return;
    }
    const k = el.dataset.cfg;
    cfg[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    saveCfg();
    if (e.type === 'change' && el.tagName === 'SELECT') render();
  }

  // re-render da busca sem perder o foco do campo de texto
  let qTimer = null;
  function debounceRender() {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      const inp = root.querySelector('[data-ui="dexQuery"]');
      const pos = inp ? inp.selectionStart : null;
      renderBody();
      const again = root.querySelector('[data-ui="dexQuery"]');
      if (again) { again.focus(); if (pos != null) again.setSelectionRange(pos, pos); }
    }, 180);
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

  const compact = () => cfg.mode !== 'extended';

  function render() {
    if (!root) return;
    const tabs = [['hunt', 'Caça'], ['fight', 'Luta'], ['team', 'Time'], ['dex', 'Dex'], ['types', 'Tipos']];
    const open = isOpen();
    root.className = (open ? 'pkc-open' : 'pkc-closed') + (compact() ? ' pkc-compact' : ' pkc-extended');
    root.innerHTML = `
      <div class="pkc-head">
        <span class="pkc-ball" aria-hidden="true"><img src="img/sprites/items/ultra-ball.png" alt="" onerror="this.remove()"></span>
        <span class="pkc-title">COMPANION</span>
        ${hunt.running ? '<span class="pkc-live">CAÇANDO</span>' : ''}
        ${open ? `<button class="pkc-x pkc-mode" data-act="mode" title="${compact() ? 'Modo estendido: todas as ferramentas' : 'Modo compacto: só o essencial'}">${compact() ? '⤢' : '⤡'}</button>` : ''}
        <button class="pkc-x" data-act="toggle" title="Abrir/fechar">${open ? '–' : '+'}</button>
      </div>
      ${open ? (compact() ? '<div class="pkc-body pkc-cbody"></div>' : `
      <div class="pkc-tabs">${tabs.map(([id, l]) => `<button data-act="tab" data-tab="${id}" class="${cfg.tab === id ? 'on' : ''}"><span class="pkc-cur">▶</span>${l}</button>`).join('')}</div>
      <div class="pkc-body"></div>`) : ''}`;
    renderBody();
  }

  /*
   * Modo compacto: no máximo 3 linhas, só o que importa na tela atual.
   * Caça (sempre), chefe (quando há run) e rota (no mapa).
   */
  function compactView() {
    const s = S();
    const b = blocked();
    if (b) return `<div class="pkc-crow pkc-muted">${esc(b.split(':')[0])}: desligado</div>`;
    const rows = [];
    // caça
    if (hunt.running) {
      const { p, aur } = shinyOdds();
      const k = s && s.nuzlockeMode ? 1 : 3;
      const per = 1 - Math.pow(1 - (cfg.huntTarget === 'aurora' ? p * aur : p), k);
      rows.push(`<div class="pkc-crow"><span class="pkc-clbl">CAÇA</span><span class="pkc-cval">${hunt.attempts} resets · ${pct(1 - Math.pow(1 - per, hunt.attempts))}</span>
        <button class="pkc-mini pkc-mini-stop" data-act="hunt-stop" title="Parar a caça">■</button></div>`);
    } else if (hunt.found) {
      rows.push(`<div class="pkc-crow pkc-found"><span class="pkc-clbl">ACHOU</span><span class="pkc-cval">${hunt.found.kind === 'AURORA' ? '🌈' : '✨'} ${esc(hunt.found.name)}</span>
        <button class="pkc-mini" data-act="hunt-start" title="Caçar de novo">▶</button></div>`);
    } else {
      rows.push(`<div class="pkc-crow"><span class="pkc-clbl">CAÇA</span><span class="pkc-cval pkc-muted">${esc(huntTargetLabel())}</span>
        <button class="pkc-mini" data-act="hunt-start" title="Começar a caça">▶</button></div>`);
    }
    if (hunt.msg && !hunt.running && !hunt.found && /parad|pausad|limite|segurança|Erro|Comece|Aurora só|Digite/.test(hunt.msg)) {
      rows.push(`<div class="pkc-crow pkc-cnote">${esc(hunt.msg)}</div>`);
    }
    // chefe
    if (s && s.team && s.team.length && ui.boss) {
      const w = ui.bossWin;
      const cls = !w ? '' : w.p >= 0.5 ? 'pkc-hp-hi' : w.p >= 0.2 ? 'pkc-hp-mid' : 'pkc-hp-lo';
      rows.push(`<div class="pkc-crow" title="Chance de vencer o próximo chefe com o time e a ordem atuais"><span class="pkc-clbl">${esc(shortName(ui.boss.name))}</span>
        <div class="pkc-bar ${cls}"><span style="width:${w ? Math.round(w.p * 100) : 0}%"></span></div><b class="pkc-cpct">${w ? pct(w.p) : '…'}</b></div>`);
      if (ui.gauntlet) rows.push(`<div class="pkc-crow" title="Simula a liga inteira em sequência, sem recuperar HP entre as lutas"><span class="pkc-clbl">LIGA</span><span class="pkc-cval">${gauntletText(ui.gauntlet, ui.boss.elite)}</span></div>`);
    }
    // rota
    if (screenId() === 'map-screen' && ui.route && ui.route.labels.length) {
      rows.push(`<div class="pkc-crow" title="${esc(ui.route.why || '')}"><span class="pkc-clbl">ROTA</span><span class="pkc-cval">${ui.route.labels.map(esc).join(' › ')}</span></div>`);
    }
    return rows.slice(0, 4).join('');
  }

  const shortName = n => { const t = String(n || 'CHEFE'); return (t.length > 10 ? t.slice(0, 9) + '…' : t).toUpperCase(); };
  function huntTargetLabel() {
    if (cfg.huntTarget === 'aurora') return 'alvo: Aurora';
    if (cfg.huntTarget === 'newshiny') return 'alvo: shiny novo na Dex';
    if (cfg.huntTarget === 'species') return 'alvo: ' + (cfg.huntSpecies || '—');
    return 'alvo: Shiny';
  }

  function renderBody() {
    const body = root && root.querySelector('.pkc-body');
    if (!body) return;
    if (compact()) { body.innerHTML = compactView(); return; }
    const b = blocked();
    if (b && cfg.tab !== 'types' && cfg.tab !== 'dex') { body.innerHTML = `<p class="pkc-muted">${esc(b)}</p>`; return; }
    if (cfg.tab === 'hunt') body.innerHTML = huntView();
    else if (cfg.tab === 'fight') body.innerHTML = fightView();
    else if (cfg.tab === 'team') body.innerHTML = teamView();
    else if (cfg.tab === 'dex') body.innerHTML = dexView();
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
          <option value="newshiny" ${cfg.huntTarget === 'newshiny' ? 'selected' : ''}>Shiny que falta na minha Dex</option>
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
      ${eggLine()}
      ${huntLog.length ? `<details><summary>Histórico (${huntLog.length})</summary>${statsLine()}
        <ul class="pkc-log">${huntLog.slice().reverse().map(h => `<li>${h.kind === 'AURORA' ? '🌈' : '✨'} ${esc(h.name)} — ${h.attempts} resets, ${h.secs}s <small>${new Date(h.at).toLocaleString()}</small></li>`).join('')}</ul>
        <button class="pkc-link" data-act="clear-log">limpar</button></details>` : ''}`;
  }

  function eggLine() {
    let pity = 0, chance = null;
    try { pity = window.getLegendaryShinyPity(); chance = window.legendaryShinyChanceNow(); } catch { return ''; }
    return `<div class="pkc-kv"><span class="pkc-lbl">OVO LENDÁRIO</span><span>${(chance * 100).toFixed(1)}% de shiny no próximo${pity ? ` <small>(${pity} sem shiny acumulados)</small>` : ''}</span></div>`;
  }
  function statsLine() {
    const st = huntStats();
    if (!st) return '';
    return `<div class="pkc-statgrid">
      <div><b>${st.n}</b><span>achados${st.aurora ? ` (${st.aurora} 🌈)` : ''}</span></div>
      <div><b>${st.avg}</b><span>resets em média</span></div>
      <div><b>${st.best}–${st.worst}</b><span>melhor–pior</span></div>
      <div><b>${st.mins}</b><span>min caçando</span></div></div>`;
  }

  function dexView() {
    const d = dexes();
    if (ui.dexRegion == null) ui.dexRegion = currentRegionIdx();
    const [rname, lo, hi] = REGIONS[ui.dexRegion];
    const count = obj => { let n = 0; for (let id = lo; id <= hi; id++) if (inDex(obj, id)) n++; return n; };
    const total = hi - lo + 1;
    const bar = (label, n, cls) => `<div class="pkc-dexrow"><span class="pkc-lbl">${label}</span>
      <div class="pkc-bar ${cls}"><span style="width:${Math.round(n / total * 100)}%"></span></div><b>${n}/${total}</b></div>`;
    let h = `<label>Região<select data-ui="dexRegion">${REGIONS.map(([n], i) => `<option value="${i}" ${i === ui.dexRegion ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      ${bar('POKÉDEX', count(d.dex), 'pkc-bar-dex')}${bar('SHINY', count(d.shiny), 'pkc-bar-shiny')}${bar('AURORA', count(d.aurora), 'pkc-bar-aurora')}`;
    const pool = mapPoolIds();
    if (pool.length) {
      const noDex = pool.filter(id => !inDex(d.dex, id)).length;
      const noShiny = pool.filter(id => !inDex(d.shiny, id)).length;
      h += `<div class="pkc-sect"><span class="pkc-lbl">NESTE MAPA</span><small>${noDex ? `${noDex} novos na Dex · ` : ''}${noShiny} shinies faltando</small></div>
        <div class="pkc-dexgrid">${pool.map(id => {
          const got = inDex(d.dex, id), sh = inDex(d.shiny, id);
          const tip = `${speciesName(id)} — ${got ? 'na Dex' : 'falta na Dex'} · ${sh ? 'shiny ✔' : 'falta shiny'}`;
          return `<span class="pkc-dexmon${got ? '' : ' pkc-dex-miss'}${sh ? ' pkc-dex-sh' : ''}" title="${esc(tip)}"><img src="${spriteOf(id)}" alt="" loading="lazy"></span>`;
        }).join('')}</div>
        <p class="pkc-muted">Apagado: falta na Dex · ✨: já tem o shiny.</p>`;
    }
    h += `<label>Buscar Pokémon<input data-ui="dexQuery" value="${esc(ui.dexQuery || '')}" placeholder="ex.: dratini"></label>`;
    for (const id of searchSpecies(ui.dexQuery)) {
      const w = whereToFind(id);
      h += `<div class="pkc-dexhit"><img class="pkc-spr" src="${spriteOf(id)}" alt="">
        <div><b>${esc(speciesName(id))}</b> <small>#${id}</small><br>
        <small>${inDex(d.dex, id) ? '✔ Dex' : '✘ Dex'} · ${inDex(d.shiny, id) ? '✔ shiny' : '✘ shiny'}${inDex(d.aurora, id) ? ' · ✔ aurora' : ''}</small><br>
        <small class="pkc-muted">${w.maps.length ? 'Story: ' + esc(w.maps.join(', ')) : 'Fora dos mapas do Story'}${w.tower.length ? ' · Tower: ' + esc(w.tower.slice(0, 4).join(', ')) : ''}</small></div></div>`;
    }
    return h;
  }

  function fightView() {
    const s = S();
    if (!s || !s.team || !s.team.length) return '<p class="pkc-muted">Comece uma run para ver as previsões.</p>';
    const boss = ui.boss;
    let h = '';
    if (!boss) {
      h += `<p class="pkc-muted">Calculando próximo chefe…</p>`;
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
    if ((compact() || cfg.tab === 'fight') && !blocked() && !hunt.running) {
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
            ui.gauntlet = ui.boss && ui.boss.elite && ui.boss.elite.length > 1 ? await simGauntlet(s.team, ui.boss.elite, 150, job) : null;
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
        if (screenChanged) {
          cancelJob(advJob);
          // a faixa da preparação nunca mostra números de um chefe anterior
          const prep = document.getElementById('pkc-prep');
          if (prep) prep.remove();
          prepKey = null;
        }
        if (!hunt.running) refreshTab(false).catch(e => console.warn('[Pokelike Companion] refresh', e));
      }
      if (hunt.running && cfg.tab === 'hunt') renderBody();
      const scr = screenId();
      if (!hunt.running && ['item-screen', 'passive-screen', 'stat-buff-screen'].includes(scr)) runAdvisor(choiceAdvisor);
      if (!hunt.running && scr === 'elite-prep-screen') runAdvisor(prepAdvisor);
      if (!hunt.running && scr === 'swap-screen') runAdvisor(swapAdvisor);
      if (!hunt.running && document.querySelector('#item-equip-modal button[data-tutor]')) runAdvisor(tutorAdvisor);
      if (!hunt.running && document.getElementById('item-equip-modal')) equipHint();
      if (scr === 'map-screen') routeAdvisor();
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
