/* ============================================================
   LaiAsaka Engine · Game Layer
   v3.1.0 · © 2026 ZpycuA · CC BY-NC 4.0
   ------------------------------------------------------------
   v3.1.0 更新：
     · 顶部 import THREE（修复 "three is not defined"）
     · 全系统读取 engine.profile，实现"仿真 ↔ 游戏性"平衡
     · HUD / 战斗 / 技能 / 敌人强度 / 结算全部随 profile 变化
   ============================================================ */

import * as THREE from 'three';
import { Body } from './engine.js';

/* ============================================================
   [0] 战斗公式常数
   ============================================================ */
const COMBAT = Object.freeze({
  PSI: 0.00335791,
  T_EFF: 0.5,
  BODY_COEFF_HUMAN: 34,
  BODY_COEFF_PRAZER: 48,
  HEAD_MULT: 2.0,
  RANGE_DECAY: 1.15,
  RANGE_DECAY_REALISTIC: 2.5,
  MELEE_RANGE: 3,
  MELEE_DAMAGE: 60,
  COUPLING_REGEN_IDLE: 3.0,
  COUPLING_REGEN_LONG: 1.5,
  COUPLING_REGEN_DELAY: 1.0,
  COUPLING_LONG_THRESHOLD: 10.0,
  PROTECT_DRAIN: { L1: 0.8, L2: 2.5, L3: 5.0 },
  PROTECT_ABSORB: { L1_MELEE: 1.0, L2_BALLISTIC: 0.7, L3_BALLISTIC: 0.5 },
  EXTRACT_TIME: 8,
  SEARCH_TIME: 2.5,
  SEARCH_RADIUS: 2.5,
  EXTRACT_RADIUS: 4.5,
});

/* ============================================================
   [1] 战斗系统 · 纯函数
   ============================================================ */
const CombatSystem = {
  kinetic(massG, v0){
    const m = massG / 1000;
    return 0.5 * m * v0 * v0;
  },

  energyAtRange(baseEnergy, traveled, range, decayK){
    if (!range || range <= 0) return baseEnergy;
    const k = decayK !== undefined ? decayK : COMBAT.RANGE_DECAY;
    const t = Math.min(traveled / range, 1.5);
    return baseEnergy * Math.exp(-k * t * t);
  },

  applyArmor(armorItem, energy, pen){
    if (!armorItem || armorItem.dur <= 0 || !armorItem.lv) {
      return { absorbed: 0, remaining: energy, wear: 0, pierced: pen >= 3 };
    }
    const spec = { 1: 0.22, 2: 0.38, 3: 0.52, 4: 0.64, 5: 0.74 };
    const lv = armorItem.lv;
    const penDiff = pen - lv;

    let effRed = spec[lv] || 0;
    if (penDiff >= 3) effRed *= 0.22;
    else if (penDiff >= 1) effRed *= (1 - penDiff * 0.2);
    else if (penDiff <= -2) effRed = Math.min(0.95, effRed * 1.35);

    const durRatio = Math.max(0, Math.min(1, armorItem.dur / armorItem.max));
    effRed *= (0.35 + 0.65 * durRatio);

    const absorbed = energy * effRed;
    const remaining = energy - absorbed;
    const wear = Math.min(armorItem.dur, absorbed / 20);
    armorItem.dur = Math.max(0, armorItem.dur - wear);

    return { absorbed, remaining, wear, pierced: penDiff >= 3 };
  },

  applyCoupling(player, energy, type){
    if (!player.charSpec.prazer) return { absorbed: 0, remaining: energy, cost: 0 };
    if (!player.protectionHold || !player.protection || player.coupling <= 0) {
      return { absorbed: 0, remaining: energy, cost: 0 };
    }
    let mult = 0;
    if (type === 'melee') mult = COMBAT.PROTECT_ABSORB.L1_MELEE;
    else if (type === 'ballistic') {
      if (player.protection === 'L2') mult = COMBAT.PROTECT_ABSORB.L2_BALLISTIC;
      else if (player.protection === 'L3') mult = COMBAT.PROTECT_ABSORB.L3_BALLISTIC;
    }
    if (mult <= 0) return { absorbed: 0, remaining: energy, cost: 0 };
    const absorbed = energy * mult;
    const remaining = energy - absorbed;
    const cost = COMBAT.PSI * absorbed * COMBAT.T_EFF;
    return { absorbed, remaining, cost };
  },

  energyToHP(energy, isPrazer){
    const coeff = isPrazer ? COMBAT.BODY_COEFF_PRAZER : COMBAT.BODY_COEFF_HUMAN;
    return energy / coeff;
  },
};

/* ============================================================
   [2] AI 系统
   ============================================================ */
const AISystem = {
  update(world, enemy, dt){
    if (!enemy.alive || enemy.trainingDummy) return;

    const p = world.player;
    const dx = p.body.position.x - enemy.body.position.x;
    const dz = p.body.position.z - enemy.body.position.z;
    const distToPlayer = Math.hypot(dx, dz);
    const hasLOS = distToPlayer < 40 && this._checkLOS(world, enemy, p);

    if (hasLOS) enemy.awareness = Math.min(1, enemy.awareness + dt * 2.5);
    else enemy.awareness = Math.max(0, enemy.awareness - dt * 0.5);

    if (enemy.awareness > 0.7 && enemy.state !== 'combat') {
      enemy.state = 'combat';
    } else if (enemy.awareness < 0.2 && enemy.state === 'combat') {
      enemy.state = 'search';
      enemy.stateT = 0;
    }

    switch (enemy.state) {
      case 'patrol': this._patrol(world, enemy, dt); break;
      case 'combat': this._combat(world, enemy, dt, distToPlayer); break;
      case 'search': this._search(world, enemy, dt); break;
    }

    const half = world.mapSpec.size / 2 - 2;
    enemy.body.position.x = Math.max(-half, Math.min(half, enemy.body.position.x));
    enemy.body.position.z = Math.max(-half, Math.min(half, enemy.body.position.z));

    if (enemy.hitFlash > 0) enemy.hitFlash -= dt;
  },

  _patrol(world, enemy, dt){
    enemy.wanderT -= dt;
    if (enemy.wanderT <= 0) {
      enemy.wanderT = 1.5 + Math.random() * 1.5;
      enemy.wanderDir = Math.random() * Math.PI * 2;
    }
    enemy.angle = enemy.wanderDir;
    enemy.body.velocity.x = Math.cos(enemy.wanderDir) * enemy.spec.speed * 0.4;
    enemy.body.velocity.z = Math.sin(enemy.wanderDir) * enemy.spec.speed * 0.4;
  },

  _combat(world, enemy, dt, dist){
    const p = world.player;
    const dx = p.body.position.x - enemy.body.position.x;
    const dz = p.body.position.z - enemy.body.position.z;
    const ang = Math.atan2(dz, dx);
    enemy.angle = ang;

    let moveAng;
    if (dist > 15) moveAng = ang;
    else if (dist < 8) moveAng = ang + Math.PI;
    else moveAng = ang + Math.PI / 2 * enemy.strafeDir;

    enemy.body.velocity.x = Math.cos(moveAng) * enemy.spec.speed;
    enemy.body.velocity.z = Math.sin(moveAng) * enemy.spec.speed;

    if (enemy.fireCd > 0) enemy.fireCd -= dt;
    if (enemy.fireCd <= 0 && enemy.weapon && this._checkLOS(world, enemy, p)) {
      world.enemyFire(enemy, p);
    }

    enemy.strafeT -= dt;
    if (enemy.strafeT <= 0) {
      enemy.strafeDir *= -1;
      enemy.strafeT = 0.7 + Math.random() * 1.2;
    }
  },

  _search(world, enemy, dt){
    enemy.stateT += dt;
    if (enemy.stateT > 4) {
      enemy.state = 'patrol';
      enemy.awareness = 0;
    }
    enemy.angle += dt * 1.5;
    enemy.body.velocity.x *= 0.9;
    enemy.body.velocity.z *= 0.9;
  },

  _checkLOS(world, a, b){
    const dx = b.body.position.x - a.body.position.x;
    const dz = b.body.position.z - a.body.position.z;
    const len = Math.hypot(dx, dz) || 1;
    if (len < 0.1) return true;
    const hit = world.physics.raycast(
      a.body.position.x, 1.2, a.body.position.z,
      dx / len, 0, dz / len,
      len,
      body => body.userData && body.userData.type === 'obstacle'
    );
    return !hit;
  },
};

/* ============================================================
   [3] 任务系统
   ============================================================ */
class TaskSystem {
  constructor(world){
    this.world = world;
    this.engine = world.engine;
    this.active = new Map();
  }

  initFromRegistry(){
    const tasks = this.engine.content.all('tasks');
    const modeId = this.world.modeId;
    for (const t of tasks) {
      if (t.mode && t.mode !== modeId) continue;
      if (t.source && !['default', 'daily', 'challenge'].includes(t.source)) continue;
      this.active.set(t.id, { def: t, progress: 0, done: false });
    }
    this.render();
  }

  progress(kind, amount = 1, payload = null){
    let changed = false;
    for (const inst of this.active.values()) {
      if (inst.done) continue;
      if (inst.def.trigger.kind !== kind) continue;
      if (inst.def.trigger.filter && payload) {
        let skip = false;
        for (const k in inst.def.trigger.filter) {
          if (payload[k] !== inst.def.trigger.filter[k]) { skip = true; break; }
        }
        if (skip) continue;
      }
      inst.progress = Math.min(inst.def.goal, inst.progress + amount);
      if (inst.progress >= inst.def.goal) {
        inst.done = true;
        this._runEffects(inst.def.onComplete || []);
        this._log('✓ ' + this.engine.i18n.t(inst.def.name) + ' 已完成', 'g');
      }
      changed = true;
    }
    if (changed) this.render();
  }

  tickSurvive(dt){
    let changed = false;
    for (const inst of this.active.values()) {
      if (inst.done || inst.def.trigger.kind !== 'survive') continue;
      inst.progress = Math.min(inst.def.goal, inst.progress + dt);
      if (inst.progress >= inst.def.goal) {
        inst.done = true;
        this._runEffects(inst.def.onComplete || []);
        this._log('✓ ' + this.engine.i18n.t(inst.def.name) + ' 已完成', 'g');
      }
      changed = true;
    }
    if (changed) this.render();
  }

  _runEffects(effects){
    for (const e of effects) {
      switch (e.kind) {
        case 'credits':
          this.engine.save.data.credits = (this.engine.save.data.credits || 0) + e.amount;
          this._log('+' + e.amount + ' cp', 'g');
          break;
        case 'flag':
          this.engine.save.data.flags = this.engine.save.data.flags || {};
          this.engine.save.data.flags[e.key] = e.value;
          break;
        case 'unlock':
          this._log('解锁 ' + e.id, 'p');
          break;
      }
    }
  }

  _log(text, cls){
    if (this.world && this.world._log) this.world._log(text, cls);
  }

  render(){
    const el = document.getElementById('task-list');
    if (!el) return;
    let html = '';
    for (const inst of this.active.values()) {
      const prog = Math.floor(inst.progress);
      const cls = 'task-item' + (inst.done ? ' done' : '');
      const srcTag = inst.def.source && inst.def.source !== 'default'
        ? `<span class="source-tag">[${inst.def.source}]</span>`
        : '';
      const name = this.engine.i18n.t(inst.def.name);
      html += `<div class="${cls}">${inst.done ? '✓' : '○'} ${name}${srcTag} <span class="prog">${prog}/${inst.def.goal}</span></div>`;
    }
    el.innerHTML = html;
  }
}

/* ============================================================
   [4] HUD 系统 · 随 profile 变化
   ============================================================ */
class HUDSystem {
  constructor(world){
    this.world = world;
    this.engine = world.engine;
    this._cache = {};
    this._els = null;
    this._protectBtns = null;
  }

  _initEls(){
  if (this._els) return;
  this._els = {
    hpRow: document.querySelector('#hp-bar')?.closest('.stat-row'),
    cpRow: document.getElementById('cp-row'),
    ammoEl: document.getElementById('bottom-right'),
    // ★ 修复：之前找的是 id="task-panel"，但 HTML 里是 class="task-panel"
    taskPanel: document.querySelector('.task-panel'), 
    crosshair: document.getElementById('crosshair'),
  };
}

  _bindProtectionButtons(){
    if (this._protectBtns) return;
    this._protectBtns = Array.from(document.querySelectorAll('.protect-btn'));
    for (const btn of this._protectBtns) {
      const level = btn.dataset.level;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        this.world._toggleProtection(level);
        btn.classList.add('active');
      });
      const release = () => {
        this.world._releaseProtection();
        btn.classList.remove('active');
      };
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
    }
  }

  update(){
    const p = this.world.player;
    if (!p) return;

    this._initEls();
    this._bindProtectionButtons();

    // ★ [Profile] 显隐控制
    this._applyVisibility();

    // 数值更新
    this._setText('player-name', p.charSpec ? this.engine.i18n.t(p.charSpec.name) : '—');
    this._setText('player-tag', p.charSpec ? this.engine.i18n.t(p.charSpec.tag) : '—');

    const hpPct = Math.max(0, Math.min(100, p.hp / p.maxHp * 100));
    this._setStyle('hp-bar', 'width', hpPct + '%');
    this._setText('hp-text', Math.round(hpPct) + '%');

    if (p.charSpec && p.charSpec.prazer) {
      const cpPct = Math.max(0, Math.min(100, p.coupling / p.maxCoupling * 100));
      this._setStyle('cp-bar', 'width', cpPct + '%');
      this._setText('cp-text', Math.round(cpPct) + '%');
    }

    if (p.weapon) {
      this._setText('weapon-name', this.engine.i18n.t(p.weapon.def.name));
      this._setText('ammo-mag', String(p.weapon.mag));
      this._setText('ammo-reserve', String(p.weapon.reserve));
    }

    if (p.stamina !== undefined) {
      const stPct = Math.max(0, Math.min(100, p.stamina / p.maxStamina * 100));
      this._setStyle('stamina-bar', 'width', stPct + '%');
      // 体力不足时变红
      this._setStyle('stamina-bar', 'background', stPct < 20 ? '#ff5b5b' : 'linear-gradient(90deg,#ffd93d,#fff08a)');
    }

    // 防护按钮可用性
    if (this._protectBtns) {
      const canProtect = p.charSpec && p.charSpec.prazer && p.coupling > 0;
      for (const btn of this._protectBtns) {
        btn.classList.toggle('dead', !canProtect);
      }
    }

    // 撤离进度
    this._renderExtractProgress();
  }

  _applyVisibility(){
    const profile = this.engine.profile;
    const els = this._els;
    const p = this.world.player;

    // 血条
    if (els.hpRow) {
      const show = profile.get('hud.hpBar', true);
      this._setDisplay('hpRow', show);
    }
    // 耦合条
    if (els.cpRow) {
      const show = (p && p.charSpec && p.charSpec.prazer) && profile.get('hud.cpBar', true);
      this._setDisplay('cpRow', show);
    }
    // 弹药
    if (els.ammoEl) {
      this._setDisplay('ammoEl', profile.get('hud.ammoCounter', true));
    }
    // 任务列表
    if (els.taskPanel) {
      this._setDisplay('taskPanel', profile.get('hud.taskList', true));
    }
  }

  _setDisplay(key, show){
    const cacheKey = 'display:' + key;
    if (this._cache[cacheKey] === show) return;
    this._cache[cacheKey] = show;
    const el = this._els[key];
    if (el) el.style.display = show ? '' : 'none';
  }

  _renderExtractProgress(){
    const el = document.getElementById('extract-progress');
    const fill = document.getElementById('extract-fill');
    if (!el || !fill) return;
    let maxT = 0;
    for (const ex of this.world.extracts) {
      if (ex.timer > maxT) maxT = ex.timer;
    }
    if (maxT > 0) {
      el.classList.add('on');
      fill.style.width = (maxT / COMBAT.EXTRACT_TIME * 100) + '%';
    } else {
      el.classList.remove('on');
      fill.style.width = '0%';
    }
  }

  _setText(id, text){
    if (this._cache[id] === text) return;
    const el = document.getElementById(id);
    if (el) el.textContent = text;
    this._cache[id] = text;
  }

  _setStyle(id, prop, value){
    const key = id + ':' + prop;
    if (this._cache[key] === value) return;
    const el = document.getElementById(id);
    if (el) el.style[prop] = value;
    this._cache[key] = value;
  }
}

/* ============================================================
   [5] GameWorld
   ============================================================ */
class GameWorld {
  constructor(engine, config){
    this.engine = engine;
    this.config = config;

    this.mapId   = config.mapId;
    this.charId  = config.charId;
    this.diffId  = config.diffId;
    this.modeId  = config.modeId;
    this.kind    = config.kind;

    this.mapSpec  = engine.content.get('maps', this.mapId);
    this.charSpec = engine.content.get('characters', this.charId);
    this.modeConfig = engine.modeRegistry.get(this.modeId);

    if (!this.mapSpec)   throw new Error('[World] 地图不存在: ' + this.mapId);
    if (!this.charSpec)  throw new Error('[World] 角色不存在: ' + this.charId);
    if (!this.modeConfig) throw new Error('[World] 模式不存在: ' + this.modeId);

    this.physics    = engine.physicsFactory();
    this.player     = null;
    this.enemies    = [];
    this.extracts   = [];
    this.containers = [];
    this.obstacles  = [];
    this.tracers    = [];

    this.time       = 0;
    this.running    = false;
    this.paused     = false;
    this.extractTimer = 0;
    this.activeExtract = null;
    this.timeLimit  = config.timeLimit || 0;

    this.stats = { shots: 0, hits: 0, headshots: 0, kills: 0 };

    this.onEnd = null;
    this._searchTarget = null;
    this._searchTimer = 0;
    this._searching = false;
    this._lastProtectionUse = 0;
    this._protectionStartTime = 0;

    this.tasks = new TaskSystem(this);
    this.hud = new HUDSystem(this);
  }

  start(){
    this._setupScene();
    this._spawnPlayer();
    this._spawnEnemies();
    this._spawnExtracts();
    this._spawnContainers();
    this._registerInputActions();
    this.tasks.initFromRegistry();

    if (this.modeConfig.setup) {
      try { this.modeConfig.setup(this); }
      catch (e) { console.error('[Mode] setup err:', e); }
    }

    this.engine.cameraCtl.follow(this.player.body.position.x, this.player.body.position.z);
    this.engine.cameraCtl.camera.position.x = this.player.body.position.x;
    this.engine.cameraCtl.camera.position.z = this.player.body.position.z;

    this.hud.update();
    this.running = true;
    this._processModeHook('onMatchStart');
    this._processModeHook('onPlayerSpawn', this.player);

    this._log(
      this.engine.i18n.t('log.match_start', {
        map: this.engine.i18n.t(this.mapSpec.name),
        char: this.engine.i18n.t(this.charSpec.name),
      }), 'p'
    );
    this._log(
      this.engine.i18n.t('log.match_difficulty', {
        diff: this.diffId,
        mode: this.modeId,
      }), 'y'
    );
    if (this.kind === 'training') {
      this._log(this.engine.i18n.t('log.training_mode'), 'y');
    }
  }

  _setupScene(){
    const r = this.engine.renderer;
    r.clearScene();

    const mapSize = this.mapSpec.size;
    const half = mapSize / 2;

    const groundGeo = new THREE.PlaneGeometry(mapSize, mapSize);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1a2536, roughness: 0.95, metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    r.scene.add(ground);

    const grid = new THREE.GridHelper(mapSize, Math.floor(mapSize / 6), 0x3a5470, 0x243448);
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    r.scene.add(grid);

    const obstacleCount = this.mapSpec.obstacleCount || 30;
    for (let i = 0; i < obstacleCount; i++) {
      const w = 3 + Math.random() * 6;
      const d = 3 + Math.random() * 6;
      const h = 2 + Math.random() * 2.5;
      const x = (Math.random() * 2 - 1) * (half - 6);
      const z = (Math.random() * 2 - 1) * (half - 6);
      if (Math.hypot(x, z) < 6) continue;

      const mesh = this.engine.meshes.build('obstacle', {
        w, h, d,
        color: Math.random() < 0.5 ? 0x22314a : 0x28394f,
      });
      mesh.position.x = x;
      mesh.position.z = z;
      r.scene.add(mesh);

      const body = this.physics.add(new Body({
        x, z,
        isStatic: true,
        shape: 'aabb',
        halfW: w / 2,
        halfD: d / 2,
        radius: 0,
        userData: { type: 'obstacle' },
      }));
      this.obstacles.push({ mesh, body });
    }
  }

    _spawnPlayer(){
    const spec = this.charSpec;
    const mesh = this.engine.meshes.build('player', spec);
    this.engine.renderer.scene.add(mesh);
    
    // ★ FPS模式隐藏玩家身体
    mesh.visible = false;

    // ★ 耦合发光特效体（外描边）
    let auraMesh = null;
    if (spec.prazer) {
      auraMesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.8, 1.6, 4, 12), // 稍微比人身体大一点
        new THREE.MeshBasicMaterial({ 
          color: 0xffffff, 
          transparent: true, 
          opacity: 0.5, 
          side: THREE.BackSide, // 渲染背面，形成外发光感觉
          depthWrite: false 
        })
      );
      auraMesh.visible = false;
      auraMesh.position.y = 1.2; // 对齐原模型高度
      mesh.add(auraMesh); // 挂载到玩家模型上
    }
       
    const body = this.physics.add(new Body({
      x: 0, z: 0,
      radius: spec.radius || 1.2,
      mass: 70,
      restitution: 0.1,
      friction: 6,
      userData: { type: 'player' },
    }));

    this.player = {
      mesh, body,auraMesh,
      charSpec: spec,
      charId: spec.id,
      hp: spec.hp,
      maxHp: spec.hp,
      coupling: 100,
      maxCoupling: 100,
      protection: null,
      protectionHold: false,
      angle: 0,
      weapon: this._buildWeapon(spec.weapon),
      sidearm: spec.sidearm ? this._buildWeapon(spec.sidearm) : null,
      usingSidearm: false,
      fireCd: 0,
      reloading: 0,
      reloadTime: 0,
      alive: true,
      kills: 0,
      dealt: 0,
      taken: 0,
      carriedValue: 0,
      limbDamage: 0,
      speedMul: 1,
      stamina: 100,      // ★ 加上这个
      maxStamina: 100,   // ★ 加上这个
      armor: {
        shell: { lv: 3, dur: 100, max: 100 },
        visor: { lv: 3, dur: 100, max: 100 },
        fiber: { lv: 4, dur: 100, max: 100 },
        plate: { lv: 4, dur: 100, max: 100 },
      },
      skills: this._buildSkills(spec.skills || []),
    };
    this.player.body.userData.ref = this.player;
  }

  _buildWeapon(id){
    const def = this.engine.content.get('weapons', id);
    if (!def) return null;
    const ammoDef = this.engine.content.get('ammo', def.ammoType);
    return {
      def, ammoDef,
      mag: def.mag,
      magCap: def.mag,
      reserve: def.mag * 3,
      fireCd: 0,
      reloading: 0,
    };
  }

  _buildSkills(skillIds){
    const result = [];
    for (let i = 0; i < skillIds.length; i++) {
      const def = this.engine.content.get('skills', skillIds[i]);
      if (!def) continue;
      result.push({ id: skillIds[i], def, ready: true, cd: 0, slot: i });
    }
    return result;
  }

  _spawnEnemies(){
    const specs = this.engine.content.all('enemies');
    if (!specs.length) return;
    const count = this.mapSpec.enemyCount || 6;
    const half = this.mapSpec.size / 2 - 6;
    const diffMul = { easy: 0.75, normal: 1, hard: 1.25, nightmare: 1.5 }[this.diffId] || 1;

    for (let i = 0; i < count; i++) {
      const spec = specs[i % specs.length];
      let ex, ez, tries = 0;
      do {
        ex = (Math.random() * 2 - 1) * half;
        ez = (Math.random() * 2 - 1) * half;
        tries++;
      } while (Math.hypot(ex, ez) < 25 && tries < 60);
      this._spawnEnemy(spec, ex, ez, diffMul);
    }
  }

 _spawnEnemy(spec, x, z, diffMul){
  const assessment = this.engine.profile.assess();
  const profileMul = 0.5 + assessment.score;

  const mesh = this.engine.meshes.build('enemy', spec);
  
  // ★ 核心修复：克隆材质，杜绝所有敌人共享一个材质导致一起变白
  mesh.traverse(obj => {
    if (obj.isMesh) {
      obj.material = obj.material.clone();
    }
  });
  
  this.engine.renderer.scene.add(mesh);

  const body = this.physics.add(new Body({
    x, z,
    radius: spec.radius || 1.2,
    mass: 60,
    restitution: 0.1,
    friction: 5,
    userData: { type: 'enemy' },
  }));

  const enemy = {
    mesh, body, spec,
    hp: spec.hp * diffMul * profileMul,
    maxHp: spec.hp * diffMul * profileMul,
    angle: Math.random() * Math.PI * 2,
    weapon: this._buildWeapon(spec.weapon),
    fireCd: 0.5 + Math.random() * 1.0,
    alive: true,
    awareness: 0,
    state: 'patrol',
    stateT: 0,
    wanderT: 1 + Math.random() * 2,
    wanderDir: Math.random() * Math.PI * 2,
    strafeDir: Math.random() < 0.5 ? 1 : -1,
    strafeT: 0.7 + Math.random() * 1.2,
    hitFlash: 0,
    trainingDummy: this.kind === 'training',
  };
  body.userData.ref = enemy;
  this.enemies.push(enemy);
}

  _spawnExtracts(){
    const half = this.mapSpec.size / 2 - 4;
    const positions = [
      { x: -half, z: -half }, { x: half, z: -half },
      { x: -half, z: half },  { x: half, z: half },
    ];
    for (const pos of positions) {
      const mesh = this.engine.meshes.build('extract', { radius: 3.5 });
      mesh.position.x = pos.x;
      mesh.position.z = pos.z;
      this.engine.renderer.scene.add(mesh);
      this.extracts.push({ x: pos.x, z: pos.z, mesh, timer: 0, active: false });
    }
  }

  _spawnContainers(){
    const half = this.mapSpec.size / 2 - 6;
    const count = 8;
    for (let i = 0; i < count; i++) {
      let cx, cz, tries = 0;
      do {
        cx = (Math.random() * 2 - 1) * half;
        cz = (Math.random() * 2 - 1) * half;
        tries++;
      } while (Math.hypot(cx, cz) < 8 && tries < 40);

      const mesh = this.engine.meshes.build('container', {});
      mesh.position.x = cx;
      mesh.position.z = cz;
      this.engine.renderer.scene.add(mesh);
      this.containers.push({ x: cx, z: cz, mesh, opened: false });
    }
  }

  _registerInputActions(){
    const input = this.engine.input;
    input.registerAction('reload', { keys: ['r'] });
    input.registerAction('switchWeapon', { keys: ['f'] });
    input.registerAction('search', { keys: ['g'] });
    input.registerAction('skill1', { keys: ['q'] });
    input.registerAction('skill2', { keys: ['e'] });
  }

 update(dt){
  if (!this.running || this.paused) return;
  this.time += dt;

  this.tasks.tickSurvive(dt);
  this._updatePlayer(dt);
  this._updateEnemies(dt);
  this._updateExtracts(dt);
  this._updateContainers(dt);
  this._updateTracers(dt);

  this.physics.step(dt);
  this._syncMeshes();

  if (this.player) {
    // ★ 眼睛高度设为物理体 Y 坐标 + 1.5
    this.engine.cameraCtl.follow(
      this.player.body.position.x, 
      this.player.body.position.y + 1.5, 
      this.player.body.position.z
    );
  }
  this.hud.update();

  if (this.timeLimit > 0 && this.time >= this.timeLimit) {
    this._log('时间耗尽', 'r');
    this._end(false);
  }
}

_updatePlayer(dt){
  const p = this.player;
  if (!p || !p.alive) return;

  const e = this.engine;

  // =========================================================
  // 1. 陀螺仪视角控制
  // =========================================================
  if (e.input.gyroEnabled && e.input.enableVirtualJoysticks) {
    const g = e.input.currentGyro;
    // 初始化基准角度（第一次开启时的角度作为原点）
    if (!this._gyroBase) {
      this._gyroBase = { beta: g.beta || 0, gamma: g.gamma || 0 };
    } else {
      const dx = g.gamma - this._gyroBase.gamma;
      const dy = g.beta - this._gyroBase.beta;
      
      // 只有在有微小变化时才执行，防止静态抖动
      if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
        const sens = 2.0 * e.input.gyroSensitivity;
        e.cameraCtl.rotate(dx * sens, dy * sens);
        
        // 平滑跟随，避免过度跳跃（阻尼）
        this._gyroBase.gamma += dx * 0.5; 
        this._gyroBase.beta += dy * 0.5;
      }
    }
  }

  // =========================================================
  // 2. 读取摇杆与体力值处理
  // =========================================================
  const mv = e.input.getMoveVector();
  const isMoving = (mv.x !== 0 || mv.z !== 0);
  
  // 自动疾跑：如果摇杆推到底（magnitude > 0.9）或者按住Shift
  const wantsToSprint = e.input.keys.has('shift') || e.input.isActive('sprint') || (e.input.joystickLeft?.vector.magnitude > 0.9);
  let isSprinting = false;
  
  if (isMoving && wantsToSprint && p.stamina > 5) {
    isSprinting = true;
    // 冲刺每秒消耗 12 点体力
    p.stamina = Math.max(0, p.stamina - dt * 12); 
  } else {
    // 走路每秒恢复 5，站定每秒恢复 20（硬核体力管理）
    const regen = isMoving ? 5 : 20;
    p.stamina = Math.min(p.maxStamina, p.stamina + dt * regen); 
  }

  // =========================================================
  // 3. 计算移动向量与速度
  // =========================================================
  const baseSpeed = p.charSpec.speed * (p.speedMul !== undefined ? p.speedMul : 1);
  // 冲刺速度加成：1.8倍
  const speed = isSprinting ? baseSpeed * 1.8 : baseSpeed; 

  // 根据相机朝向计算实际移动方向（确保 W 永远是向前）
  const forwardX = Math.sin(e.cameraCtl.yaw);
  const forwardZ = -Math.cos(e.cameraCtl.yaw);
  const rightX = Math.cos(e.cameraCtl.yaw);
  const rightZ = Math.sin(e.cameraCtl.yaw);

  let moveX = rightX * mv.x + forwardX * -mv.z;
  let moveZ = rightZ * mv.x + forwardZ * -mv.z;

  // 将速度赋予物理刚体
  p.body.velocity.x = moveX * speed;
  p.body.velocity.z = moveZ * speed;
  
  // 唤醒休眠的物理体
  if (isMoving) p.body.wake();

  // =========================================================
  // 4. 跳跃
  // =========================================================
  const jumpPressed = e.input.keys.has(' ') || e.input.isActive('jump');
  // 简单的地面检测：高度接近地面，且垂直速度向下
  if (jumpPressed && p.body.position.y <= p.body.radius + 0.2 && p.body.velocity.y <= 0.1) {
    p.body.velocity.y = 8.5; 
    p.body.wake();
  }

  // 角色永远面朝相机正前方
  p.angle = e.cameraCtl.yaw;

  // =========================================================
  // 5. 技能冷却、换弹、开火
  // =========================================================
  this._updateProtection(dt);

  for (const sk of p.skills) {
    if (!sk.ready) {
      sk.cd -= dt;
      if (sk.cd <= 0) { sk.ready = true; sk.cd = 0; }
    }
  }

  if (p.reloading > 0) {
    p.reloading -= dt;
    if (p.reloading <= 0) this._finishReload();
  } else {
    if (p.fireCd > 0) p.fireCd -= dt;
    if (e.input.isActive('fire') && p.fireCd <= 0 && p.weapon) {
      if (p.weapon.mag <= 0) this._startReload();
      else this._fireWeapon(p, p.weapon, true);
    }
  }

  if (e.input.isActive('reload')) this._startReload();
  if (e.input.isActive('switchWeapon') && p.sidearm) this._switchWeapon();
  if (e.input.isActive('skill1')) this._useSkill(0);
  if (e.input.isActive('skill2')) this._useSkill(1);
  if (e.input.isActive('search')) this._trySearchContainer();

  // =========================================================
  // 6. 边界限制
  // =========================================================
  const half = this.mapSpec.size / 2 - 1;
  p.body.position.x = Math.max(-half, Math.min(half, p.body.position.x));
  p.body.position.z = Math.max(-half, Math.min(half, p.body.position.z));
}
  

  _updateProtection(dt){
    const p = this.player;
    if (!p.charSpec.prazer) return;

    if (p.protectionHold && p.protection && p.coupling > 0) {
      const drain = COMBAT.PROTECT_DRAIN[p.protection] || 0;
      p.coupling = Math.max(0, p.coupling - drain * dt);
      this._protectionStartTime += dt;
      if (p.coupling <= 0) {
        p.protectionHold = false;
        this._log('耦合能耗尽', 'r');
      }
    } else {
      if (this._protectionStartTime > 0) {
        this._lastProtectionUse = this.time;
        this._protectionStartTime = 0;
      }
      const sinceLastUse = this.time - this._lastProtectionUse;
      if (sinceLastUse > COMBAT.COUPLING_REGEN_DELAY) {
        const rate = (this.time - this._lastProtectionUse > COMBAT.COUPLING_LONG_THRESHOLD)
          ? COMBAT.COUPLING_REGEN_LONG : COMBAT.COUPLING_REGEN_IDLE;
        p.coupling = Math.min(p.maxCoupling, p.coupling + rate * dt);
      }
    }
  }

  _toggleProtection(level){
    const p = this.player;
    if (!p || !p.charSpec.prazer || p.coupling <= 0) return;
    if (p.protectionHold && p.protection === level) {
      p.protectionHold = false;
      return;
    }
    p.protection = level;
    p.protectionHold = true;
  }

  _releaseProtection(){
    if (this.player) this.player.protectionHold = false;
  }

  _switchWeapon(){
    const p = this.player;
    if (!p || !p.sidearm) return;
    if (p.reloading > 0) return;
    p.usingSidearm = !p.usingSidearm;
    p.fireCd = Math.max(p.fireCd, 0.3);
    this._playSFX('switch');
  }

  get currentWeapon(){
    const p = this.player;
    if (!p) return null;
    return p.usingSidearm ? p.sidearm : p.weapon;
  }

  _startReload(){
    const p = this.player;
    const w = this.currentWeapon;
    if (!w || p.reloading > 0) return;
    if (w.mag >= w.magCap || w.reserve <= 0) return;

    // ★ [Profile] 真实换弹时间 ×1.5 / 街机 ×0.8
    const realistic = this.engine.profile.get('combat.realisticReload', false);
    const reloadMul = realistic ? 1.5 : 0.8;
    p.reloading = w.def.reload * reloadMul;
    p.reloadTime = p.reloading;
    this._playSFX('reload');
  }

  _finishReload(){
    const p = this.player;
    const w = this.currentWeapon;
    if (!w) return;
    const need = w.magCap - w.mag;
    const take = Math.min(need, w.reserve);
    w.mag += take;
    w.reserve -= take;
    p.reloading = 0;
  }

 _fireWeapon(owner, weapon, isPlayer){
  if (!weapon || !weapon.def) return;
  const def = weapon.def;
  const ammo = weapon.ammoDef;
  if (!ammo) return;

  if (isPlayer) owner.fireCd = 60 / def.rpm;
  else owner.fireCd = 60 / def.rpm * (0.9 + Math.random() * 0.4);

  if (isPlayer) { weapon.mag--; this.stats.shots++; }

  const baseSpread = def.spread || 0.02;
  const acc = isPlayer ? 1.0 : (owner.spec ? owner.spec.acc : 0.5);
  const spread = baseSpread * (isPlayer ? 1 : (1.5 - acc));

  const baseEnergy = CombatSystem.kinetic(ammo.massG, ammo.v0);
  const range = (def.range || 50) * 10;

  if (isPlayer && this.engine.profile.get('combat.realisticRecoil', false)) {
    const rec = def.recoil || 1;
    this.engine.cameraCtl.shake(0.25 * rec, 0.05);
  }

  const pellets = def.pellets || 1;
  
  if (isPlayer) {
    const cam = this.engine.renderer.camera;
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    
    for (let i = 0; i < pellets; i++) {
      const spreadX = (Math.random() * 2 - 1) * spread;
      const spreadY = (Math.random() * 2 - 1) * spread;
      const dX = dir.x + spreadX;
      const dY = dir.y + spreadY;
      const dZ = dir.z + spreadX;
      const len = Math.hypot(dX, dY, dZ) || 1;
      this._raycastBullet(owner, dX/len, dY/len, dZ/len, baseEnergy, range, def, ammo, true);
    }
  } else {
    for (let i = 0; i < pellets; i++) {
      const a = owner.angle + (Math.random() * 2 - 1) * spread;
      this._raycastBullet(owner, Math.cos(a), 0, Math.sin(a), baseEnergy, range, def, ammo, false);
    }
  }

  this._playSFX('shot_' + def.cls, { volume: 0.6 });
}

_raycastBullet(owner, dirX, dirY, dirZ, baseEnergy, range, weaponDef, ammoDef, isPlayer){
  const px = owner.body.position.x;
  const pz = owner.body.position.z;
  const py = 1.6; 
  
  const ox = px + dirX * 1.0;
  const oy = py + dirY * 1.0;
  const oz = pz + dirZ * 1.0;
  
  const hitFilter = isPlayer
    ? (body) => body !== owner.body && (body.userData?.type === 'enemy' || body.userData?.type === 'obstacle')
    : (body) => body !== owner.body && (body.userData?.type === 'player' || body.userData?.type === 'obstacle');

  const lenXZ = Math.hypot(dirX, dirZ) || 1;
  // 查二维射线
  const hit = this.physics.raycast(ox, oy, oz, dirX/lenXZ, dirY, dirZ/lenXZ, range, hitFilter);
  
  // 计算真实 3D 距离
  const dist2D = hit ? hit.t : range;
  const actualDist = dist2D / (lenXZ || 1);
  const endX = ox + dirX * actualDist;
  const endY = oy + dirY * actualDist;
  const endZ = oz + dirZ * actualDist;
  
  this._spawnTracer(ox, oy, oz, endX, endY, endZ, isPlayer ? 0xffe08a : 0xff8b7b);

  if (endY <= 0) {
    this._spawnSpark(endX, 0.1, endZ);
    return;
  }

  if (!hit) return;

  const realisticDrop = this.engine.profile.get('combat.bulletDrop', false);
  const decayK = realisticDrop ? COMBAT.RANGE_DECAY_REALISTIC : COMBAT.RANGE_DECAY;
  const energy = CombatSystem.energyAtRange(baseEnergy, actualDist, range, decayK);

  const pen = ammoDef.tier || 0;

  if (hit.body.userData.type === 'obstacle') {
    this._spawnSpark(endX, endY, endZ);
    return;
  }

  if (isPlayer && hit.body.userData.type === 'enemy') {
    this._damageEnemy(hit.body.userData.ref, energy, pen);
  } else if (!isPlayer && hit.body.userData.type === 'player') {
    this._damagePlayer(hit.body.userData.ref, energy, pen);
  }
}

  enemyFire(enemy, target){
    if (!enemy.alive || !enemy.weapon) return;
    if (enemy.trainingDummy) return;
    this._fireWeapon(enemy, enemy.weapon, false);
  }

  _damageEnemy(enemy, energy, pen){
  if (!enemy.alive) return;

  const profile = this.engine.profile;
  const isHead = Math.random() < 0.1;
  let finalEnergy = isHead ? energy * COMBAT.HEAD_MULT : energy;

  // ★ 修复：爆头即死时，伤害刚好等于敌人的剩余血量，不再用无限大
  if (isHead && profile.get('combat.headshotInstantKill', false)) {
    finalEnergy = enemy.maxHp * COMBAT.BODY_COEFF_HUMAN; 
  }

  const dmg = CombatSystem.energyToHP(finalEnergy, false);
  enemy.hp -= dmg;
  enemy.hitFlash = 0.15;
  this.player.dealt += dmg;
  this.stats.hits++;
  if (isHead) this.stats.headshots++;

  this._spawnDamageNumber(enemy.body.position.x, enemy.body.position.z, Math.round(dmg), 'enemy');
  this._hitMarker();
  this._playSFX('hit', { volume: 0.4 });

  if (enemy.hp <= 0 && enemy.alive) this._killEnemy(enemy);
}

 _damagePlayer(player, energy, pen){
  if (!player.alive) return;

  const profile = this.engine.profile;
  const coup = CombatSystem.applyCoupling(player, energy, 'ballistic');
  if (coup.cost > 0) player.coupling = Math.max(0, player.coupling - coup.cost);
  let remaining = coup.remaining;

  const plate = CombatSystem.applyArmor(player.armor.plate, remaining, pen);
  remaining = plate.remaining;
  const fiber = CombatSystem.applyArmor(player.armor.fiber, remaining, pen);
  remaining = fiber.remaining;

  const isHead = Math.random() < 0.05;
  if (isHead) remaining *= COMBAT.HEAD_MULT;

  // ★ 修复：爆头即死时，伤害刚好等于玩家当前血量，不再无限溢出
  if (isHead && profile.get('combat.headshotInstantKill', false)) {
    remaining = player.hp * COMBAT.BODY_COEFF_HUMAN;
  }

  const dmg = CombatSystem.energyToHP(remaining, player.charSpec.prazer);
  player.hp -= dmg;
  player.taken += dmg;

  // ★ [Profile] 四肢伤害
  if (profile.get('combat.limbDamage', false)) {
    player.limbDamage = (player.limbDamage || 0) + 1;
    if (player.limbDamage >= 4) {
      player.speedMul = Math.max(0.4, 1 - (player.limbDamage - 3) * 0.15);
    }
  }

  this._spawnDamageNumber(player.body.position.x, player.body.position.z, Math.round(dmg), 'player');
  this._hurtFX();
  this.engine.cameraCtl.shake(0.4, 0.15);
  this._playSFX('hurt', { volume: 0.5 });

  if (player.hp <= 0 && player.alive) this._playerDown();
}

  _killEnemy(enemy){
    enemy.alive = false;
    enemy.body.alive = false;
    this.physics.remove(enemy.body);
    if (enemy.mesh) enemy.mesh.visible = false;
    this.player.kills++;
    this.stats.kills++;

    this._spawnSpark(enemy.body.position.x, enemy.body.position.z);

    this.tasks.progress('kill', 1, { faction: enemy.spec.faction });
    this._processModeHook('onEnemyKilled', enemy);

    this._log(this.engine.i18n.t('log.enemy_killed', {
      name: this.engine.i18n.t(enemy.spec.name),
    }), 'g');
  }

  _playerDown(){
    const p = this.player;
    p.alive = false;
    this._processModeHook('onPlayerDowned');
    this._end(false);
  }

  _updateEnemies(dt){
    for (const e of this.enemies) {
      if (!e.alive) continue;
      AISystem.update(this, e, dt);
    }
  }

  _updateExtracts(dt){
    const p = this.player;
    if (!p || !p.alive) return;
    for (const ex of this.extracts) {
      const d = Math.hypot(p.body.position.x - ex.x, p.body.position.z - ex.z);
      if (d < COMBAT.EXTRACT_RADIUS) {
        ex.timer += dt;
        if (!ex.active) {
          ex.active = true;
          this._processModeHook('onExtractStart', ex);
          this._log(this.engine.i18n.t('log.extract_started'), 'p');
        }
        if (ex.timer >= COMBAT.EXTRACT_TIME) {
          this._log(this.engine.i18n.t('log.extract_complete'), 'g');
          this.tasks.progress('extract', 1);
          this._end(true);
          return;
        }
      } else {
        ex.timer = 0;
        ex.active = false;
      }
    }
  }

  _updateContainers(dt){
    if (!this._searching) {
      const p = this.player;
      if (!p || !p.alive) return;
      let best = null, bestDist = COMBAT.SEARCH_RADIUS;
      for (const c of this.containers) {
        if (c.opened) continue;
        const d = Math.hypot(p.body.position.x - c.x, p.body.position.z - c.z);
        if (d < bestDist) { best = c; bestDist = d; }
      }
      this._searchTarget = best;
    } else {
      this._searchTimer += dt;
      if (this._searchTimer >= COMBAT.SEARCH_TIME) this._finishSearch();
    }
  }

  _trySearchContainer(){
    if (this._searching) return;
    if (!this._searchTarget) { this._log('附近没有可搜索的容器', 'y'); return; }
    this._searching = true;
    this._searchTimer = 0;
    this._log('正在搜索…', 'p');
  }

  _finishSearch(){
    const c = this._searchTarget;
    this._searching = false;
    this._searchTimer = 0;
    this._searchTarget = null;
    if (!c) return;
    c.opened = true;
    if (c.mesh) {
      c.mesh.material.emissive = new THREE.Color(0x000000);
      c.mesh.material.color = new THREE.Color(0x3a3a3a);
    }
    const lootValue = 100 + Math.floor(Math.random() * 400);
    this.player.carriedValue += lootValue;
    this.tasks.progress('loot', 1);
    this._log('搜索完成 · 获得物资 ' + lootValue + ' cp', 'g');
  }

  _useSkill(slot){
    const p = this.player;
    if (!p || !p.alive) return;

    // ★ [Profile] 技能启用开关
    if (!this.engine.profile.get('skills.enabled', true)) {
      this._log('当前玩法禁用技能', 'y');
      return;
    }

    const sk = p.skills[slot];
    if (!sk || !sk.ready) return;
    if (sk.def.cost > 0 && p.coupling < sk.def.cost) {
      this._log('耦合能不足', 'y');
      return;
    }
    if (sk.def.cost > 0) p.coupling -= sk.def.cost;

    // ★ [Profile] CD 缩减
    const cdMul = this.engine.profile.get('skills.cooldownReduction', 1.0);
    sk.cd = sk.def.cd * cdMul;
    sk.ready = false;

    this._applySkillEffect(p, sk.def);
    this._log('【' + this.engine.i18n.t(sk.def.name) + '】已触发', 'p');
    this._playSFX('skill');
  }

  _applySkillEffect(p, def){
    switch (def.kind) {
      case 'dash': {
        const angle = p.angle;
        const dist = def.distance || 5;
        p.body.position.x += Math.cos(angle) * dist;
        p.body.position.z += Math.sin(angle) * dist;
        break;
      }
      case 'timedBuff': {
        p.buffs = p.buffs || {};
        p.buffs[def.effect] = this.time + def.duration;
        break;
      }
      case 'healPercent': {
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * def.percent);
        break;
      }
      case 'drone': {
        this._log('无人机已部署（占位）', 'y');
        break;
      }
      case 'taunt': {
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const d = Math.hypot(p.body.position.x - e.body.position.x, p.body.position.z - e.body.position.z);
          if (d < 15) e.state = 'combat';
        }
        break;
      }
    }
  }

  _spawnTracer(x1, y1, z1, x2, y2, z2, color){
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array([x1, y1, z1, x2, y2, z2]);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.8 });
    const line = new THREE.Line(geo, mat);
    this.engine.renderer.scene.add(line);
    this.tracers.push({ line, ttl: 0.08 });
  }

  _updateTracers(dt){
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.ttl -= dt;
      if (t.ttl <= 0) {
        this.engine.renderer.scene.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }

 _spawnSpark(x, y, z){
    const mesh = this.engine.meshes.build('spark', { color: 0xffaa44 });
    mesh.position.set(x, y, z);
    this.engine.renderer.scene.add(mesh);
    setTimeout(() => {
      this.engine.renderer.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    }, 120);
  }

  _spawnDamageNumber(x, z, val, kind){
    // ★ [Profile] 伤害数字显隐
    if (!this.engine.profile.get('visual.damageNumbers', true)) return;

    const cam = this.engine.renderer.camera;
    const v = new THREE.Vector3(x, 2.5, z).project(cam);
    const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const el = document.createElement('div');
    el.textContent = String(val);
    const color = kind === 'player' ? '#ff6a6a' : '#ffe08a';
    el.style.cssText = `
      position:fixed;left:${sx}px;top:${sy}px;
      color:${color};font-weight:800;font-size:14px;
      text-shadow:0 2px 4px #000;pointer-events:none;z-index:40;
      transform:translate(-50%,-50%);
      transition:all .7s ease-out;opacity:1;
      font-family:ui-monospace,Menlo,Consolas,monospace;
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = 'translate(-50%,-80px)';
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 750);
  }

  _hitMarker(){
    // ★ [Profile] 命中标记显隐
    if (!this.engine.profile.get('visual.hitMarkers', true)) return;
    const ch = document.getElementById('crosshair');
    if (!ch) return;
    ch.style.filter = 'brightness(2)';
    setTimeout(() => { ch.style.filter = ''; }, 80);
  }

  _hurtFX(){
    const hud = document.getElementById('hud');
    if (!hud) return;
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:absolute;inset:0;pointer-events:none;z-index:20;
      background:radial-gradient(circle,transparent 30%,rgba(150,20,20,.6) 100%);
      transition:opacity .15s;opacity:1;
    `;
    hud.appendChild(overlay);
    setTimeout(() => {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 200);
    }, 100);
  }

  _playSFX(name, opts){
    const audio = this.engine.audio;
    if (!audio || !audio.enabled || !audio.ctx) return;
    if (audio._clips.has(name)) {
      audio.play(name, opts);
    } else {
      this._synthSFX(name, opts);
    }
  }

  _synthSFX(name, opts){
    const ac = this.engine.audio.ctx;
    if (!ac) return;
    const now = ac.currentTime;
    const optsSafe = opts || {};
    try {
      if (name.startsWith('shot_')) {
        const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.08), ac.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / data.length * 5);
        const src = ac.createBufferSource();
        src.buffer = buffer;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(optsSafe.volume || 0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2000;
        src.connect(filter).connect(gain).connect(ac.destination);
        src.start(now); src.stop(now + 0.08);
      } else if (name === 'hit') {
        const osc = ac.createOscillator();
        osc.type = 'square'; osc.frequency.value = 800;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(optsSafe.volume || 0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.connect(gain).connect(ac.destination);
        osc.start(now); osc.stop(now + 0.05);
      } else if (name === 'reload') {
        for (let i = 0; i < 2; i++) {
          const osc = ac.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = i === 0 ? 300 : 500;
          const gain = ac.createGain();
          gain.gain.setValueAtTime(0.15, now + i * 0.1);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.06);
          osc.connect(gain).connect(ac.destination);
          osc.start(now + i * 0.1); osc.stop(now + i * 0.1 + 0.07);
        }
      } else if (name === 'switch') {
        const osc = ac.createOscillator();
        osc.type = 'square';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.08);
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        osc.connect(gain).connect(ac.destination);
        osc.start(now); osc.stop(now + 0.1);
      } else if (name === 'hurt') {
        const osc = ac.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.15);
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain).connect(ac.destination);
        osc.start(now); osc.stop(now + 0.2);
      } else if (name === 'skill') {
        [400, 600, 900].forEach((f, i) => {
          const osc = ac.createOscillator();
          osc.type = 'sine'; osc.frequency.value = f;
          const gain = ac.createGain();
          gain.gain.setValueAtTime(0.15, now + i * 0.05);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.05 + 0.15);
          osc.connect(gain).connect(ac.destination);
          osc.start(now + i * 0.05); osc.stop(now + i * 0.05 + 0.15);
        });
      }
    } catch (e) { /* 忽略音效错误 */ }
  }

  _log(text, cls){
    const el = document.getElementById('event-banner');
    if (!el) return;
    el.textContent = text;
    el.style.background = cls === 'p'
      ? 'linear-gradient(90deg,rgba(120,60,200,.9),rgba(60,90,200,.9))'
      : cls === 'y'
        ? 'linear-gradient(90deg,rgba(140,110,40,.9),rgba(80,60,20,.9))'
        : cls === 'r'
          ? 'linear-gradient(90deg,rgba(180,40,40,.9),rgba(120,20,20,.9))'
          : 'linear-gradient(90deg,rgba(60,120,80,.9),rgba(30,70,50,.9))';
    el.classList.add('on');
    if (this._logTimer) clearTimeout(this._logTimer);
    this._logTimer = setTimeout(() => el.classList.remove('on'), 1800);
  }

  _processModeHook(hookName, ...args){
    const hooks = this.modeConfig && this.modeConfig.hooks;
    if (!hooks) return;
    const fn = hooks[hookName];
    if (typeof fn !== 'function') return;
    try { fn(this, ...args); }
    catch (e) { console.error(`[Mode] ${hookName}:`, e); }
  }

_syncMeshes(){
  const p = this.player;
  if (p && p.mesh) {
    p.mesh.position.set(p.body.position.x, 0, p.body.position.z);
    p.mesh.rotation.y = -p.angle;
  }
  for (const e of this.enemies) {
    if (!e.mesh) continue;
    
    // 如果敌人死了，强制重置一次材质并隐藏
    if (!e.alive) {
      e.mesh.visible = false;
      e.mesh.traverse(obj => {
        if (obj.isMesh && obj.material && obj.material.emissive) {
          obj.material.emissive.setHex(0x000000);
          obj.material.emissiveIntensity = 0;
        }
      });
      continue;
    }

    e.mesh.position.set(e.body.position.x, 0, e.body.position.z);
    e.mesh.rotation.y = -e.angle;
    
    if (e.hitFlash > 0) {
      e.hitFlash -= 0.016; // 在渲染循环里兜底扣减
      e.mesh.traverse(obj => {
        if (obj.isMesh && obj.material && obj.material.emissive) {
          obj.material.emissive.setHex(0xffffff);
          obj.material.emissiveIntensity = 0.8;
        }
      });
    } else {
      e.mesh.traverse(obj => {
        if (obj.isMesh && obj.material && obj.material.emissive) {
          obj.material.emissive.setHex(0x000000); 
          obj.material.emissiveIntensity = 0;
        }
      });
    }
  }
}

  pause(){ this.paused = true; }
  resume(){ this.paused = false; }

  _end(success){
    if (!this.running) return;
    this.running = false;
    this._processModeHook('onMatchEnd', success);
    if (this.modeConfig && this.modeConfig.teardown) {
      try { this.modeConfig.teardown(this); }
      catch (e) { console.error('[Mode] teardown:', e); }
    }
    if (this.onEnd) this.onEnd(success, {
      kills: this.player.kills,
      accuracy: this.stats.shots > 0 ? Math.round(this.stats.hits / this.stats.shots * 100) : 0,
      dealt: Math.round(this.player.dealt),
      taken: Math.round(this.player.taken),
      time: Math.round(this.time),
      carriedValue: this.player.carriedValue,
    });
  }

  destroy(){
    this.running = false;
    for (const t of this.tracers) {
      this.engine.renderer.scene.remove(t.line);
      t.line.geometry.dispose();
      t.line.material.dispose();
    }
    this.tracers = [];
    this.physics.clear();
    this.enemies = [];
    this.obstacles = [];
    this.containers = [];
    this.extracts = [];
    this.engine.renderer.clearScene();
  }
}

/* ============================================================
   [6] GameApp
   ============================================================ */
export class GameApp {
  constructor(engine){
    this.engine = engine;
    this.world = null;
    this.menuState = {
      mode: 'straight',
      map: 'factory',
      diff: 'normal',
      char: 'captain',
      profile: 'tactical',
    };
    this._lastMatchKind = 'normal';
    this._menuReady = false;
    this.platform = 'auto'; 
  }

  boot(){
    this._setupMenu();
    this._bindGlobalHandlers();
    this._registerDevCommands();
  }

      _setupMenu(){
    const e = this.engine;
    const i18n = e.i18n;

    this._renderOptions('mode-options', e.modeRegistry.all(), (i) => i.id === this.menuState.mode, (i) => ({ title: i18n.t(i.name), sub: i18n.t(i.desc || ''), tag: '', value: i.id }), (i) => { this.menuState.mode = i.id; this._updateModeHint(); });
    this._renderOptions('map-options', e.content.all('maps'), (i) => i.id === this.menuState.map, (i) => ({ title: i18n.t(i.name), sub: `${i.size}m² · ${i.enemyCount} 敌人`, tag: '', value: i.id }), (i) => { this.menuState.map = i.id; });
    
    const diffs = [ { id: 'easy', name: 'difficulty.easy.name', desc: '敌人弱 · 数量少' }, { id: 'normal', name: 'difficulty.normal.name', desc: '标准' }, { id: 'hard', name: 'difficulty.hard.name', desc: '敌人强 · 数量多' }, { id: 'nightmare', name: 'difficulty.nightmare.name', desc: '极端难度' }];
    this._renderOptions('diff-options', diffs, (i) => i.id === this.menuState.diff, (i) => ({ title: i18n.t(i.name), sub: i.desc, tag: '', value: i.id }), (i) => { this.menuState.diff = i.id; });
    
    this._renderOptions('char-options', e.content.all('characters'), (i) => i.id === this.menuState.char, (i) => ({ title: i18n.t(i.name), sub: i18n.t(i.tag), tag: i.weapon, value: i.id }), (i) => { this.menuState.char = i.id; });
    this._renderOptions('profile-options', e.profile.list(), (i) => i.id === this.menuState.profile, (i) => ({ title: i18n.t(i.name), sub: i18n.t(i.desc || ''), tag: '', value: i.id }), (i) => { this.menuState.profile = i.id; e.profile.setProfile(i.id); this._updateDifficultyDisplay(); });

    // 平台选择绑定
    const platEl = document.getElementById('platform-options');
    if (platEl) {
      platEl.querySelectorAll('.option').forEach(el => {
        el.onclick = () => {
          platEl.querySelectorAll('.option').forEach(x => x.classList.remove('on'));
          el.classList.add('on');
          this.platform = el.dataset.value;
        };
      });
    }

    this._renderCustomSettings();
    e.profile.setProfile(this.menuState.profile);
    this._updateDifficultyDisplay();
    e.profile.onChange(() => { this._updateDifficultyDisplay(); this._syncCustomSettingsUI(); });
    this._updateModeHint();
    this._menuReady = true;
  }

    _updateDifficultyDisplay(){
    const el = document.getElementById('difficulty-display');
    if (!el) return;
    const a = this.engine.profile.assess();
    const i18n = this.engine.i18n;
    const color = a.score >= 0.7 ? 'var(--danger)' : a.score >= 0.4 ? 'var(--gold)' : 'var(--green)';
    
    const diffLabel = i18n.t('ui.menu.difficulty_label');
    const finalLabel = diffLabel === 'ui.menu.difficulty_label' ? '实时难度' : diffLabel;

    el.innerHTML = `
      <div>
        <span style="color:var(--dim)">${finalLabel}</span>
        <span style="color:${color};font-weight:800;font-size:20px;margin-left:8px">${Math.round(a.score * 100)}</span>
        <span style="color:var(--dim2);font-size:10px"> / 100</span>
      </div>
      <div style="text-align:right">
        <div style="color:var(--accent);font-weight:600">${i18n.t(a.label)}</div>
        <div style="color:var(--dim2);font-size:10px">奖励 ×${a.rewardMul}</div>
      </div>`;
  }

  _renderOptions(containerId, items, isSelected, buildItem, onSelect){
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    for (const item of items) {
      const data = buildItem(item);
      const div = document.createElement('div');
      div.className = 'option' + (isSelected(item) ? ' on' : '');
      div.dataset.value = data.value;
      div.innerHTML =
        `<div class="opt-title">${data.title}</div>` +
        (data.sub ? `<div class="opt-sub">${data.sub}</div>` : '') +
        (data.tag ? `<div class="opt-tag">${data.tag}</div>` : '');
      div.addEventListener('click', () => {
        el.querySelectorAll('.option').forEach(x => x.classList.remove('on'));
        div.classList.add('on');
        onSelect(item);
      });
      el.appendChild(div);
    }
  }

  _updateModeHint(){
    const el = document.getElementById('mode-hint');
    if (!el) return;
    const mode = this.engine.modeRegistry.get(this.menuState.mode);
    if (mode) el.textContent = this.engine.i18n.t(mode.name);
  }

  _bindGlobalHandlers(){
  const e = this.engine;

  // 这里不再绑定开始/训练按钮，因为 index.html 已经绑定了。
  // 只绑定剩下的。
  document.getElementById('pause-btn')?.addEventListener('click', () => this._togglePause());
  document.getElementById('btn-resume')?.addEventListener('click', () => this._togglePause(false));
  document.getElementById('btn-quit')?.addEventListener('click', () => this._quitToMenu());

  document.getElementById('btn-again')?.addEventListener('click', () => {
    document.getElementById('result-screen')?.classList.remove('on');
    this.startMatch(this._lastMatchKind);
  });
  document.getElementById('btn-menu')?.addEventListener('click', () => {
    document.getElementById('result-screen')?.classList.remove('on');
    this._quitToMenu();
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && this.world && this.world.running) {
      ev.preventDefault();
      this._togglePause();
    }
  });

  e.i18n.onLanguageChange(() => {
    if (this._menuReady) {
      this._setupMenu();
      if (this.world) this.world.hud.update();
    }
  });
}

  _registerDevCommands(){
    const dc = this.engine.devConsole;

    dc.register('kick', {
      desc: '踢掉所有敌人',
      fn: () => {
        if (!this.world) return '当前无对局';
        let count = 0;
        for (const e of this.world.enemies) {
          if (e.alive) {
            e.hp = 0;
            this.world._killEnemy(e);
            count++;
          }
        }
        return `已击杀 ${count} 个敌人`;
      }
    });

    dc.register('heal', {
      desc: '回满 HP',
      fn: () => {
        if (!this.world || !this.world.player) return '当前无对局';
        const p = this.world.player;
        p.hp = p.maxHp;
        p.coupling = p.maxCoupling;
        p.limbDamage = 0;
        p.speedMul = 1;
        return 'HP 与耦合能已回满';
      }
    });

    dc.register('extract', {
      desc: '强制撤离',
      fn: () => {
        if (!this.world) return '当前无对局';
        this.world._end(true);
        return '已强制撤离';
      }
    });

    dc.register('give', {
      desc: '给予物资价值，用法：give <数值>',
      usage: 'give <number>',
      fn: (args) => {
        if (!this.world || !this.world.player) return '当前无对局';
        const amount = parseInt(args[0], 10);
        if (!isFinite(amount)) return '用法：give <数值>';
        this.world.player.carriedValue += amount;
        return `+${amount} cp（当前携带 ${this.world.player.carriedValue} cp）`;
      }
    });

    dc.register('spawn', {
      desc: '在玩家附近生成敌人，用法：spawn <敌人id> [数量]',
      usage: 'spawn <enemyId> [count]',
      fn: (args) => {
        if (!this.world || !this.world.player) return '当前无对局';
        const spec = this.engine.content.get('enemies', args[0]);
        if (!spec) return '未找到敌人：' + args[0];
        const count = Math.min(parseInt(args[1], 10) || 1, 20);
        const p = this.world.player;
        for (let i = 0; i < count; i++) {
          const a = Math.random() * Math.PI * 2;
          const r = 5 + Math.random() * 5;
          this.world._spawnEnemy(spec,
            p.body.position.x + Math.cos(a) * r,
            p.body.position.z + Math.sin(a) * r, 1);
        }
        return `已在玩家附近生成 ${count} 个 ${args[0]}`;
      }
    });

    // ★ [Profile] 运行时切换预设
    dc.register('profile', {
      desc: '切换玩法预设或显示当前难度，用法：profile <id> | profile list | profile',
      usage: 'profile <id|list>',
      fn: (args) => {
        const prof = this.engine.profile;
        const cmd = args[0];
        if (!cmd) {
          const a = prof.assess();
          return `当前难度 ${(a.score * 100).toFixed(0)}/100 · ${this.engine.i18n.t(a.label)} · 奖励 ×${a.rewardMul}`;
        }
        if (cmd === 'list') {
          return '预设：' + prof.list().map(p => p.id).join(', ');
        }
        const ok = prof.setProfile(cmd);
        if (!ok) return '未找到预设：' + cmd;
        this._updateDifficultyDisplay();
        const a = prof.assess();
        return `已切换到 ${cmd} · 难度 ${(a.score * 100).toFixed(0)}/100 · 奖励 ×${a.rewardMul}`;
      }
    });
  }

    startMatch(kind){
  const e = this.engine;
  this._lastMatchKind = kind;

  // ★ 核心修复 1：真正切换屏幕（把菜单关掉，把游戏打开）
  this._showScreen('game');
  
  // 保险起见，直接把所有悬浮层清理掉
  document.getElementById('result-screen')?.classList.remove('on');
  document.getElementById('pause-screen')?.classList.remove('on');
  
  const crosshair = document.getElementById('crosshair');
  if (crosshair) crosshair.style.display = 'block';

  let isMobile = this.platform === 'mobile';
  if (this.platform === 'auto') isMobile = 'ontouchstart' in window;
  
  e.input.enableVirtualJoysticks = isMobile;
  this._setupMobileControls(isMobile);
  this._bindCameraControls();

  if (this.world) {
    try { this.world.destroy(); } catch (err) { console.warn(err); }
    this.world = null;
  }

  try {
    this.world = new GameWorld(e, {
      mapId: this.menuState.map,
      charId: this.menuState.char,
      diffId: this.menuState.diff,
      modeId: this.menuState.mode,
      kind,
    });

    this.world.onEnd = (success, stats) => this._onMatchEnd(success, stats);
    this.world.start();
    e.bus.emit('matchStarted', { kind });
  } catch (err) {
    console.error('[GameApp] startMatch failed:', err);
    alert('启动失败，请查看控制台：' + (err && err.message ? err.message : String(err)));
    this._showScreen('menu');
  }
}

    _onMatchEnd(success, stats){
  try {
    const e = this.engine;
    const save = e.save;
    const assessment = e.profile.assess();

    save.data.stats = save.data.stats || { runs: 0, extracts: 0, deaths: 0, kills: 0 };
    save.data.stats.runs++;
    if (success) save.data.stats.extracts++;
    else save.data.stats.deaths++;
    save.data.stats.kills = (save.data.stats.kills || 0) + (stats.kills || 0);

    let baseReward = 0;
    if (success) baseReward += 500;
    baseReward += (stats.kills || 0) * 30;
    baseReward += (stats.carriedValue || 0);
    const finalReward = Math.round(baseReward * assessment.rewardMul);

    save.data.credits = (save.data.credits || 0) + finalReward;
    save.save();

    const title = document.getElementById('result-title');
    const statsEl = document.getElementById('result-stats');
    if (title) {
      title.textContent = e.i18n.t(success ? 'ui.result.extract_success' : 'ui.result.operation_failed');
      title.className = success ? 'success' : 'fail';
    }

    if (statsEl) {
      const statLines = [
        `击杀：<b>${stats.kills || 0}</b>　命中率：<b>${stats.accuracy || 0}%</b>`,
        `造成伤害：<b>${stats.dealt || 0}</b>　承受伤害：<b>${stats.taken || 0}</b>`,
        `存活：<b>${stats.time || 0}s</b>　携带物资：<b>${stats.carriedValue || 0} cp</b>`,
        `<div style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(120,180,240,.2);color:var(--dim)">
          难度：<b>${e.i18n.t(assessment.label)}</b> (${Math.round(assessment.score * 100)}/100)　奖励倍率：<b>×${assessment.rewardMul}</b>
        </div>`,
        `<div style="padding-top:8px;border-top:1px solid rgba(120,180,240,.2)">
          本局奖励：<b style="color:var(--gold)">+${finalReward} cp</b>
        </div>`,
      ];
      statsEl.innerHTML = statLines.join('<br>');
    }

    document.getElementById('result-screen')?.classList.add('on');
    document.getElementById('pause-screen')?.classList.remove('on');
    
    // ★ 核心修复 2：空指针保护
    const mob = document.getElementById('mobile-controls');
    if (mob) mob.style.display = 'none';

    e.bus.emit('matchEnded', { success, stats, reward: finalReward, assessment });
  } catch (err) {
    console.error('[GameApp] 结算出错:', err);
    document.getElementById('result-screen')?.classList.add('on');
  }
}

  _togglePause(force){
    if (!this.world || !this.world.running) return;
    const pauseScreen = document.getElementById('pause-screen');
    const isPaused = this.world.paused;
    const target = force !== undefined ? force : !isPaused;

    if (target) {
      this.world.pause();
      pauseScreen.classList.add('on');
      const statsEl = document.getElementById('pause-stats');
      if (statsEl) {
        const p = this.world.player;
        statsEl.innerHTML =
          `击杀：<b>${p.kills}</b>　存活：<b>${Math.round(this.world.time)}s</b><br>` +
          `携带物资：<b>${p.carriedValue} cp</b>`;
      }
    } else {
      this.world.resume();
      pauseScreen.classList.remove('on');
    }
  }

    _quitToMenu(){
  if (this.world) {
    try { this.world.destroy(); } catch (e) { console.warn(e); }
    this.world = null;
  }
  // ★ 核心修复 2：空指针保护
  const mob = document.getElementById('mobile-controls');
  if (mob) mob.style.display = 'none';
  
  this._showScreen('menu');
  if (this.engine.save.refreshMenu) this.engine.save.refreshMenu();
}

  _showScreen(name){
    const map = { boot: 'boot-screen', menu: 'menu-screen', game: 'game-screen' };
    for (const key in map) {
      const el = document.getElementById(map[key]);
      if (!el) continue;
      el.classList.toggle('on', key === name);
    }
  }

  setLanguage(code){
    const ok = this.engine.setLanguage(code);
    if (ok) {
      if (this._menuReady) this._setupMenu();
      if (this.world) {
        this.world.hud.update();
        this.world.tasks.render();
      }
    }
    return ok;
  }
_bindCameraControls() {
  if (this._camBound) return;
  this._camBound = true;
  const canvas = this.engine.renderer.canvas;
  const e = this.engine;

  // PC端
  let mouseDrag = false;
  canvas.addEventListener('mousedown', () => mouseDrag = true);
  window.addEventListener('mouseup', () => mouseDrag = false);
  window.addEventListener('mousemove', (ev) => {
    if (mouseDrag) e.cameraCtl.rotate(ev.movementX, ev.movementY);
  });

  // 移动端原生多点触控
  canvas.addEventListener('touchstart', (ev) => {
    // 阻止默认事件（防止缩放/滚动/选中）
    ev.preventDefault(); 
    for (let i = 0; i < ev.changedTouches.length; i++) {
      const t = ev.changedTouches[i];
      // 判断是否点在了 UI 按钮上
      const el = document.elementFromPoint(t.clientX, t.clientY);
      if (el && (el.closest('.mobile-btn') || el.closest('button'))) {
        continue; // 点按钮就跳过，交给按钮自己的监听器处理
      }

      // 严格的左右屏划分：左半屏摇杆，右半屏视角
      if (t.clientX < window.innerWidth * 0.45) {
        e.input.startLeftStick(t.clientX, t.clientY, t.identifier);
      } else {
        e.input.startRightDrag(t.clientX, t.clientY, t.identifier);
      }
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (ev) => {
    ev.preventDefault();
    for (let i = 0; i < ev.changedTouches.length; i++) {
      const t = ev.changedTouches[i];
      
      if (e.input.touch.left && e.input.touch.left.id === t.identifier) {
        e.input.moveLeftStick(t.clientX, t.clientY);
      } else if (e.input.touch.right && e.input.touch.right.id === t.identifier) {
        const delta = e.input.moveRightDrag(t.clientX, t.clientY);
        if (delta) {
          e.cameraCtl.rotate(delta.dx * 1.5, delta.dy * 1.5);
        }
      }
    }
  }, { passive: false });

  const endTouch = (ev) => {
    ev.preventDefault();
    for (let i = 0; i < ev.changedTouches.length; i++) {
      const t = ev.changedTouches[i];
      if (e.input.touch.left && e.input.touch.left.id === t.identifier) {
        e.input.endLeftStick();
      } else if (e.input.touch.right && e.input.touch.right.id === t.identifier) {
        e.input.endRightDrag();
      }
    }
  };
  canvas.addEventListener('touchend', endTouch, { passive: false });
  canvas.addEventListener('touchcancel', endTouch, { passive: false });
}



 _renderCustomSettings(){
  const el = document.getElementById('custom-settings');
  if (!el) return;
  
  const options = [
    { key: 'hud.hpBar', name: '显示血条', type: 'checkbox' },
    { key: 'hud.ammoCounter', name: '显示弹药', type: 'checkbox' },
    { key: 'visual.damageNumbers', name: '伤害数字', type: 'checkbox' },
    { key: 'visual.hitMarkers', name: '命中标记', type: 'checkbox' },
    { key: 'visual.minimap', name: '小地图', type: 'checkbox' },
    { key: 'skills.enabled', name: '开启技能', type: 'checkbox' },
    { key: 'combat.bulletDrop', name: '子弹下坠', type: 'checkbox' },
    { key: 'combat.headshotInstantKill', name: '爆头即死', type: 'checkbox' },
    { key: 'combat.realisticReload', name: '真实换弹', type: 'checkbox' },
    { key: 'combat.limbDamage', name: '四肢伤害', type: 'checkbox' },
    // ★ 新增灵敏度滑块
    { key: 'input.sensitivity', name: '视角灵敏度', type: 'range', min: 0.5, max: 3.0, step: 0.1 }
  ];

  el.innerHTML = '';
  for (const opt of options) {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;color:#cfe4f8;font-size:12px;padding:6px;background:rgba(20,32,46,.5);border-radius:6px;';
    
    if (opt.type === 'checkbox') {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.key = opt.key;
      checkbox.style.cssText = 'width:16px;height:16px;cursor:pointer;';
      checkbox.addEventListener('change', (e) => {
        this.engine.profile.set(opt.key, e.target.checked);
        if (opt.key === 'input.sensitivity') {
          this.engine.cameraCtl.sensitivity = e.target.value;
        }
      });
      label.appendChild(checkbox);
    } else if (opt.type === 'range') {
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = opt.min;
      slider.max = opt.max;
      slider.step = opt.step;
      slider.dataset.key = opt.key;
      slider.style.cssText = 'flex:1;cursor:pointer;';
      slider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        this.engine.profile.set(opt.key, val);
        if (opt.key === 'input.sensitivity') {
          this.engine.cameraCtl.sensitivity = val;
        }
      });
      label.appendChild(slider);
    }
    
    label.appendChild(document.createTextNode(opt.name));
    el.appendChild(label);
  }
  this._syncCustomSettingsUI();
}

  _syncCustomSettingsUI(){
  const el = document.getElementById('custom-settings');
  if (!el) return;
  
  el.querySelectorAll('input').forEach(input => {
    const key = input.dataset.key;
    const val = this.engine.profile.get(key, false);
    if (input.type === 'checkbox') {
      input.checked = val === true;
    } else if (input.type === 'range') {
      input.value = val !== false ? val : 1.0;
      if (key === 'input.sensitivity') {
        this.engine.cameraCtl.sensitivity = parseFloat(input.value);
      }
    }
  });
}

  _setupMobileControls(isMobile) {
  let container = document.getElementById('mobile-controls');
  if (!container) {
    container = document.createElement('div');
    container.id = 'mobile-controls';
    container.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:35;display:none';
    document.getElementById('game-screen').appendChild(container);
  }

  if (!isMobile) {
    container.style.display = 'none';
    return;
  }
  container.style.display = 'block';
  if (container.children.length > 0) return;

  // ★ 预留的可自定义键位表（以后只需读取存档更改 left/bottom 即可实现拖拽换位）
  const layout = [
    // 右手区域
    { id: 'fire', label: '开火', right: '20px', bottom: '80px', size: 80, color: 'rgba(255,80,80,.4)', border: 'rgba(255,100,100,.8)' },
    { id: 'jump', label: '跳跃', right: '120px', bottom: '40px', size: 60, color: 'rgba(80,255,150,.4)', border: 'rgba(100,255,150,.8)' },
    { id: 'reload', label: '换弹', right: '20px', bottom: '180px', size: 60, color: 'rgba(200,200,200,.3)', border: 'rgba(255,255,255,.6)' },
    // 左手区域（左下角开火）
    { id: 'fire_left', label: '开火', left: '30px', bottom: '150px', size: 70, color: 'rgba(255,80,80,.3)', border: 'rgba(255,100,100,.6)' }
  ];

  for (const btn of layout) {
    const el = document.createElement('div');
    el.className = 'mobile-btn';
    // 根据配置决定是靠左还是靠右
    let posCss = '';
    if (btn.left) posCss += `left:${btn.left};`;
    if (btn.right) posCss += `right:${btn.right};`;
    posCss += `bottom:${btn.bottom};`;

    el.style.cssText = `
      position:absolute;${posCss}
      width:${btn.size}px;height:${btn.size}px;border-radius:50%;
      background:${btn.color};border:2px solid ${btn.border};
      color:#fff;display:flex;align-items:center;justify-content:center;
      pointer-events:auto;font-weight:800;font-size:14px;
      user-select:none;-webkit-user-select:none;touch-action:none;
      box-shadow:0 4px 12px rgba(0,0,0,.4);z-index:36;
    `;
    el.textContent = btn.label;
    
    // 映射到真正的输入状态
    const actionId = btn.id === 'fire_left' ? 'fire' : btn.id;
    el.style.pointerEvents = 'auto'; // 允许按钮被点击
    el.style.touchAction = 'none';   // 阻止浏览器的默认触摸行为

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      this.engine.input.setActionState(actionId, true);
      el.style.transform = 'scale(0.9)';
    });
    
    const release = (e) => {
      e.preventDefault(); e.stopPropagation();
      this.engine.input.setActionState(actionId, false);
      el.style.transform = 'scale(1)';
    };
    
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('pointerleave', release);
    
    container.appendChild(el);
  }
}
}
