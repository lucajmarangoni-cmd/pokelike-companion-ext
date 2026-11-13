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
  function battleConfig(team) {
    const s = S();
    const passives = s.passives || [];
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
  function winRate(team, enemy, n) {
    const s = S();
    if (!team.length || !enemy || !enemy.length) return null;
    return guarded(() => {
      let wins = 0, survivors = 0;
      for (let i = 0; i < n; i++) {
        window.seedRng((Math.random() * 4294967296) >>> 0);
        const pt = clone(team);
        try { if (fn('applyMegaEvolution')) pt.forEach(window.applyMegaEvolution); } catch { /* ignore */ }
        const res = window.runBattle(pt, clone(enemy), s.items || [], [], null, battleConfig(pt), s.passives || []);
        if (res && res.playerWon) {
          wins++;
          survivors += (res.pTeam || []).filter(m => m.currentHp > 0).length;
        }
      }
      return { p: wins / n, avgSurvivors: wins ? survivors / wins : 0, n };
    });
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
          if (team.length) data = { name: tr.name || 'Chefe', type: tr.archetype && tr.archetype.type, team, approx: true };
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
      const r = winRate(order.map(i => team[i]), enemy, quick);
      scored.push({ order, p: r.p, alive: r.avgSurvivors, score: orderScore(r, team.length) });
      if (performance.now() - t > 25) { onProgress && onProgress(k / all.length * 0.6); await sleep(0); t = performance.now(); }
    }
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 8);
    // garante que a ordem atual também entra no refinamento
    if (!top.some(x => x.order.every((v, i) => v === i))) top.push({ order: idx, p: 0, alive: 0, score: 0 });
    for (let k = 0; k < top.length; k++) {
      if (orderJob !== job) return null;
      const r = winRate(top[k].order.map(i => team[i]), enemy, Math.max(300, cfg.sims));
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
    if (advisorKey === key && document.querySelector('.pkc-advice')) return;
    advisorKey = key;
    const team = s.team;
    const boss = hunt.running ? null : await nextBoss();
    const before = teamDefense(team);
    const beforeOff = teamOffense(team);
    const beforeTiers = traitTiers(team);
    const base = boss ? winRate(team, boss.team, 200) : null;
    const room = team.length < 6; // o jogo aceita até 6; com time cheio ele pede pra trocar

    inst.forEach((cand, i) => {
      const lines = [];
      if (cand.isAurora) lines.push('<b class="pkc-aurora">🌈 AURORA</b>');
      else if (cand.isShiny) lines.push('<b class="pkc-shiny">✨ SHINY</b>');
      const mt = moveType(cand);
      lines.push(`Ataca com <span class="pkc-t pkc-t-${mt.toLowerCase()}">${esc(tType(mt))}</span>`);

      // cobertura nova
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

      if (boss && base) {
        let best = null;
        if (room) best = { p: winRate([...team, cand], boss.team, 200).p, label: '' };
        else {
          team.forEach((m, j) => {
            const t2 = team.slice(); t2[j] = cand;
            const r = winRate(t2, boss.team, 120).p;
            if (!best || r > best.p) best = { p: r, label: ` (no lugar de ${m.name})` };
          });
        }
        const d = best.p - base.p;
        const cls = d > 0.02 ? 'pkc-good' : d < -0.02 ? 'pkc-bad' : '';
        lines.push(`vs ${esc(boss.name)}: <span class="${cls}">${pct(best.p)}</span> <small>(${d >= 0 ? '+' : ''}${Math.round(d * 100)} pts${esc(best.label)})</small>`);
      }

      let box = wraps[i].querySelector('.pkc-advice');
      if (!box) { box = document.createElement('div'); box.className = 'pkc-advice'; wraps[i].appendChild(box); }
      box.innerHTML = lines.join('<br>');
    });
    highlightCatchCards();
  }

  function highlightCatchCards() {
    const inst = currentCatchInstances();
    if (!inst) return;
    const wraps = [...document.querySelectorAll('#catch-choices .poke-choice-wrap')];
    inst.forEach((c, i) => { if (wraps[i]) wraps[i].classList.toggle('pkc-hit', !!(c.isShiny || c.isAurora)); });
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
  const MENU_SCREENS = ['title-screen', 'history-region-select', 'trainer-screen', 'starter-screen'];
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
        <span class="pkc-ball" aria-hidden="true"></span>
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

  async function refreshTab(force) {
    if (!isOpen()) return;
    if (cfg.tab === 'fight' && !blocked() && !hunt.running) {
      const s = S();
      if (s && s.team && s.team.length) {
        const prev = ui.boss;
        ui.boss = await nextBoss();
        if (force || ui.boss !== prev || !ui.bossWin) {
          ui.bossWin = ui.boss ? winRate(s.team, ui.boss.team, cfg.sims) : null;
          if (ui.boss !== prev) ui.order = null;
        }
      }
    }
    renderBody();
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
        if (!hunt.running) await refreshTab(false);
      }
      if (hunt.running && cfg.tab === 'hunt') renderBody();
      if (screenId() === 'catch-screen') {
        if (hunt.running) highlightCatchCards(); else await catchAdvisor();
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
    console.info('[Pokelike Companion] pronto');
  })();
})();
