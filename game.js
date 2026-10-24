/* ============================================================
   LaiAsaka Engine · Game Layer
   v3.0.0 · © 2026 ZpycuA · CC BY-NC 4.0
   ------------------------------------------------------------
   应用层：把引擎 + 内容 + 模式拼成一局可玩的游戏。
   不含任何硬编码内容/文案，全部走 engine.content / engine.i18n。
   ------------------------------------------------------------
   模块结构：
     [0] 战斗公式常数（COMBAT）
     [1] 战斗系统（CombatSystem · 纯函数）
     [2] AI 系统（AISystem）
     [3] 任务系统（TaskSystem · DSL 解释器）
     [4] HUD 系统（HUDSystem）
     [5] 世界（GameWorld · 一局）
     [6] 应用（GameApp · 菜单 → 对局 → 结算）
   ============================================================ */

/* ============================================================
   [0] 战斗公式常数
   ------------------------------------------------------------
   这些不是"内容"，是物理/数学常数。可以从这里改。
   内容相关的数值（武器伤害、护甲等级等）全部在 content.js 里。
   ============================================================ */
const COMBAT = Object.freeze({
  // 耦合吝啬常数 ψ（来自设定集）
  PSI: 0.00335791,
  // 有效受击时间 t_eff（秒）
  T_EFF: 0.5,
  // 人体能量→HP 系数（人类）
  BODY_COEFF_HUMAN: 34,
  // 人体能量→HP 系数（Prazer）
  BODY_COEFF_PRAZER: 48,
  // 头部伤害倍率
  HEAD_MULT: 2.0,
  // 距离衰减系数
  RANGE_DECAY: 1.15,
  // 近战伤害（固定值，与武器无关）
  MELEE_RANGE: 3,
  MELEE_DAMAGE: 60,
  // 耦合能恢复速率（每秒）
  COUPLING_REGEN_IDLE: 3.0,
  COUPLING_REGEN_LONG: 1.5,
  COUPLING_REGEN_DELAY: 1.0,
  COUPLING_LONG_THRESHOLD: 10.0,
  // 防护待机消耗（每秒）
  PROTECT_DRAIN: { L1: 0.8, L2: 2.5, L3: 5.0 },
  // 防护抵消系数
  PROTECT_ABSORB: { L1_MELEE: 1.0, L2_BALLISTIC: 0.7, L3_BALLISTIC: 0.5 },
  // 撤离倒计时（秒）
  EXTRACT_TIME: 8,
  // 搜索容器时长（秒）
  SEARCH_TIME: 2.5,
  // 搜索交互半径（米）
  SEARCH_RADIUS: 2.5,
  // 撤离交互半径（米）
  EXTRACT_RADIUS: 4.5,
});

/* ============================================================
   [1] 战斗系统 · 纯函数
   ============================================================ */
const CombatSystem = {
  /* 动能 = ½ m v² （克 → 千克） */
  kinetic(massG, v0){
    const m = massG / 1000;
    return 0.5 * m * v0 * v0;
  },

  /* 距离衰减：exp(-k * (traveled/range)²) */
  energyAtRange(baseEnergy, traveled, range){
    if (!range || range <= 0) return baseEnergy;
    const t = Math.min(traveled / range, 1.5);
    return baseEnergy * Math.exp(-COMBAT.RANGE_DECAY * t * t);
  },

  /* 护甲吸收。armorItem: { lv, dur, max }，energy: 焦耳，pen: 穿透层数 */
  applyArmor(armorItem, energy, pen){
    if (!armorItem || armorItem.dur <= 0 || !armorItem.lv) {
      return { absorbed: 0, remaining: energy, wear: 0, pierced: pen >= 3 };
    }
    const spec = { 1: 0.22, 2: 0.38, 3: 0.52, 4: 0.64, 5: 0.74 };
    const lv = armorItem.lv;
    const penDiff = pen - lv;

    // 穿甲修正
    let effRed = spec[lv] || 0;
    if (penDiff >= 3) effRed *= 0.22;
    else if (penDiff >= 1) effRed *= (1 - penDiff * 0.2);
    else if (penDiff <= -2) effRed = Math.min(0.95, effRed * 1.35);

    // 耐久修正
    const durRatio = Math.max(0, Math.min(1, armorItem.dur / armorItem.max));
    effRed *= (0.35 + 0.65 * durRatio);

    const absorbed = energy * effRed;
    const remaining = energy - absorbed;
    const wear = Math.min(armorItem.dur, absorbed / 20);
    armorItem.dur = Math.max(0, armorItem.dur - wear);

    return { absorbed, remaining, wear, pierced: penDiff >= 3 };
  },

  /* 耦合防护吸收 */
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

  /* 能量 → HP 伤害 */
  energyToHP(energy, isPrazer){
    const coeff = isPrazer ? COMBAT.BODY_COEFF_PRAZER : COMBAT.BODY_COEFF_HUMAN;
    return energy / coeff;
  },
};

/* ============================================================
   [2] AI 系统
   ------------------------------------------------------------
   状态机：idle → patrol → alert → combat → search → dead
   通过 mode 的 hooks 解耦（asaka 模式可以接对话等）
   ============================================================ */
const AISystem = {
  update(world, enemy, dt){
    if (!enemy.alive || enemy.trainingDummy) return;

    const p = world.player;
    const dx = p.body.position.x - enemy.body.position.x;
    const dz = p.body.position.z - enemy.body.position.z;
    const distToPlayer = Math.hypot(dx, dz);

    // 视线检测
    const hasLOS = distToPlayer < 40 && this._checkLOS(world, enemy, p);

    // 感知累积
    if (hasLOS) enemy.awareness = Math.min(1, enemy.awareness + dt * 2.5);
    else enemy.awareness = Math.max(0, enemy.awareness - dt * 0.5);

    // 状态迁移
    if (enemy.awareness > 0.7 && enemy.state !== 'combat') {
      enemy.state = 'combat';
    } else if (enemy.awareness < 0.2 && enemy.state === 'combat') {
      enemy.state = 'search';
      enemy.stateT = 0;
    }

    // 行为
    switch (enemy.state) {
      case 'patrol': this._patrol(world, enemy, dt); break;
      case 'combat': this._combat(world, enemy, dt, distToPlayer); break;
      case 'search': this._search(world, enemy, dt); break;
    }

    // 边界
    const half = world.mapSpec.size / 2 - 2;
    enemy.body.position.x = Math.max(-half, Math.min(half, enemy.body.position.x));
    enemy.body.position.z = Math.max(-half, Math.min(half, enemy.body.position.z));

    // 命中闪光
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

    // 保持距离
    let moveAng;
    if (dist > 15) moveAng = ang;
    else if (dist < 8) moveAng = ang + Math.PI;
    else moveAng = ang + Math.PI / 2 * enemy.strafeDir;

    enemy.body.velocity.x = Math.cos(moveAng) * enemy.spec.speed;
    enemy.body.velocity.z = Math.sin(moveAng) * enemy.spec.speed;

    // 开火
    if (enemy.fireCd > 0) enemy.fireCd -= dt;
    if (enemy.fireCd <= 0 && enemy.weapon && this._checkLOS(world, enemy, p)) {
      world.enemyFire(enemy, p);
    }

    // 偶尔切换 strafe 方向
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
   [3] 任务系统 · DSL 解释器
   ------------------------------------------------------------
   任务结构在 content.js 里注册为 'tasks' 表。
   每个任务：
     { id, name, desc, source, trigger: {kind, filter}, goal, onComplete[] }
   trigger.kind: 'kill' | 'loot' | 'survive' | 'extract' | 'boss'
   onComplete 效果：{ kind: 'credits'|'flag'|'unlock', ... }
   ============================================================ */
class TaskSystem {
  constructor(world){
    this.world = world;
    this.engine = world.engine;
    this.active = new Map();
    this._dirty = false;
  }

  initFromRegistry(){
    const tasks = this.engine.content.all('tasks');
    const modeId = this.world.modeId;
    for (const t of tasks) {
      // 只加载当前模式适用的任务
      if (t.mode && t.mode !== modeId) continue;
      // 只加载 default / daily / challenge
      if (t.source && !['default', 'daily', 'challenge'].includes(t.source)) continue;
      this.active.set(t.id, { def: t, progress: 0, done: false });
    }
    this.render();
    this._log('加载 ' + this.active.size + ' 条任务', 'p');
  }

  progress(kind, amount = 1, payload = null){
    let changed = false;
    for (const inst of this.active.values()) {
      if (inst.done) continue;
      if (inst.def.trigger.kind !== kind) continue;
      // filter 过滤（如 faction）
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
        default:
          console.warn('[Task] 未知效果:', e.kind);
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

  get allDone(){
    for (const inst of this.active.values()) {
      if (!inst.done) return false;
    }
    return true;
  }
}

/* ============================================================
   [4] HUD 系统
   ============================================================ */
class HUDSystem {
  constructor(world){
    this.world = world;
    this.engine = world.engine;
    this._cache = {};
    this._protectBtns = null;
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

    // 首次绑定防护按钮
    this._bindProtectionButtons();

    // 玩家信息
    this._setText('player-name', p.charSpec ? this.engine.i18n.t(p.charSpec.name) : '—');
    this._setText('player-tag', p.charSpec ? this.engine.i18n.t(p.charSpec.tag) : '—');

    // HP
    const hpPct = Math.max(0, Math.min(100, p.hp / p.maxHp * 100));
    this._setStyle('hp-bar', 'width', hpPct + '%');
    this._setText('hp-text', Math.round(hpPct) + '%');

    // 耦合
    const cpRow = document.getElementById('cp-row');
    if (p.charSpec && p.charSpec.prazer) {
      if (cpRow) cpRow.style.display = 'flex';
      const cpPct = Math.max(0, Math.min(100, p.coupling / p.maxCoupling * 100));
      this._setStyle('cp-bar', 'width', cpPct + '%');
      this._setText('cp-text', Math.round(cpPct) + '%');
    } else {
      if (cpRow) cpRow.style.display = 'none';
    }

    // 武器
    if (p.weapon) {
      this._setText('weapon-name', this.engine.i18n.t(p.weapon.def.name));
      this._setText('ammo-mag', String(p.weapon.mag));
      this._setText('ammo-reserve', String(p.weapon.reserve));
    }

    // 防护按钮可用性
    if (this._protectBtns) {
      const canProtect = p.charSpec && p.charSpec.prazer && p.coupling > 0;
      for (const btn of this._protectBtns) {
        if (canProtect) btn.classList.remove('dead');
        else btn.classList.add('dead');
      }
    }

    // 撤离进度
    this._renderExtractProgress();
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
   [5] GameWorld · 一局
   ============================================================ */
class GameWorld {
  constructor(engine, config){
    this.engine = engine;
    this.config = config;

    this.mapId     = config.mapId;
    this.charId    = config.charId;
    this.diffId    = config.diffId;
    this.modeId    = config.modeId;
    this.kind      = config.kind;    // 'normal' | 'training'

    this.mapSpec   = engine.content.get('maps', this.mapId);
    this.charSpec  = engine.content.get('characters', this.charId);
    this.modeConfig = engine.modeRegistry.get(this.modeId);

    if (!this.mapSpec)   throw new Error('[World] 地图不存在: ' + this.mapId);
    if (!this.charSpec)  throw new Error('[World] 角色不存在: ' + this.charId);
    if (!this.modeConfig) throw new Error('[World] 模式不存在: ' + this.modeId);

    // 状态
    this.physics    = engine.physicsFactory();
    this.player     = null;
    this.enemies    = [];
    this.extracts   = [];
    this.containers = [];
    this.obstacles  = [];
    this.tracers    = [];
    this.bulletPool = engine.objectPool || null;

    this.time       = 0;
    this.running    = false;
    this.paused     = false;
    this.extractTimer = 0;
    this.activeExtract = null;
    this.timeLimit  = config.timeLimit || 0;

    this.stats = {
      shots: 0,
      hits: 0,
      headshots: 0,
      kills: 0,
    };

    this.onEnd = null;
    this._searchTarget = null;
    this._searchTimer = 0;
    this._searching = false;
    this._lastLogTime = {};
    this._lastProtectionUse = 0;
    this._protectionStartTime = 0;

    // 系统
    this.tasks = new TaskSystem(this);
    this.hud = new HUDSystem(this);
  }

  /* ===== 启动 ===== */
  start(){
    this._setupScene();
    this._spawnPlayer();
    this._spawnEnemies();
    this._spawnExtracts();
    this._spawnContainers();
    this._registerInputActions();
    this.tasks.initFromRegistry();

    // 模式初始化
    if (this.modeConfig.setup) {
      try { this.modeConfig.setup(this); }
      catch (e) { console.error('[Mode] setup err:', e); }
    }

    // 初始 camera
    this.engine.cameraCtl.follow(this.player.body.position.x, this.player.body.position.z);
    this.engine.cameraCtl.camera.position.x = this.player.body.position.x;
    this.engine.cameraCtl.camera.position.z = this.player.body.position.z;

    // HUD 初始化
    this.hud.update();

    this.running = true;
    this._processModeHook('onMatchStart');
    this._processModeHook('onPlayerSpawn', this.player);

    this._log(
      this.engine.i18n.t('log.match_start', {
        map: this.engine.i18n.t(this.mapSpec.name),
        char: this.engine.i18n.t(this.charSpec.name),
      }),
      'p'
    );
    this._log(
      this.engine.i18n.t('log.match_difficulty', {
        diff: this.diffId,
        mode: this.modeId,
      }),
      'y'
    );

    if (this.kind === 'training') {
      this._log(this.engine.i18n.t('log.training_mode'), 'y');
    }
  }

  /* ===== 场景搭建 ===== */
  _setupScene(){
    const r = this.engine.renderer;
    r.clearScene();

    const mapSize = this.mapSpec.size;
    const half = mapSize / 2;

    // 地面
    const groundGeo = new THREE.PlaneGeometry(mapSize, mapSize);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0x1a2536, roughness: 0.95, metalness: 0.05,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    r.scene.add(ground);

    // 网格
    const grid = new THREE.GridHelper(mapSize, Math.floor(mapSize / 6), 0x3a5470, 0x243448);
    grid.material.opacity = 0.35;
    grid.material.transparent = true;
    r.scene.add(grid);

    // 障碍物
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

  /* ===== 玩家 ===== */
  _spawnPlayer(){
    const spec = this.charSpec;
    const mesh = this.engine.meshes.build('player', spec);
    this.engine.renderer.scene.add(mesh);

    const body = this.physics.add(new Body({
      x: 0, z: 0,
      radius: spec.radius || 1.2,
      mass: 70,
      restitution: 0.1,
      friction: 6,
      userData: { type: 'player' },
    }));

    this.player = {
      mesh,
      body,
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
      def,
      ammoDef,
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
      const id = skillIds[i];
      const def = this.engine.content.get('skills', id);
      if (!def) continue;
      result.push({
        id,
        def,
        ready: true,
        cd: 0,
        slot: i,
      });
    }
    return result;
  }

  /* ===== 敌人 ===== */
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
      } while (Math.hypot(ex, ez) < 10 && tries < 60);
      this._spawnEnemy(spec, ex, ez, diffMul);
    }
  }

  _spawnEnemy(spec, x, z, diffMul){
    const mesh = this.engine.meshes.build('enemy', spec);
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
      mesh,
      body,
      spec,
      hp: spec.hp * diffMul,
      maxHp: spec.hp * diffMul,
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

  /* ===== 撤离点 ===== */
  _spawnExtracts(){
    const half = this.mapSpec.size / 2 - 4;
    const positions = [
      { x: -half, z: -half },
      { x:  half, z: -half },
      { x: -half, z:  half },
      { x:  half, z:  half },
    ];
    for (const pos of positions) {
      const mesh = this.engine.meshes.build('extract', { radius: 3.5 });
      mesh.position.x = pos.x;
      mesh.position.z = pos.z;
      this.engine.renderer.scene.add(mesh);
      this.extracts.push({
        x: pos.x, z: pos.z, mesh,
        timer: 0, active: false,
      });
    }
  }

  /* ===== 容器 ===== */
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
      this.containers.push({
        x: cx, z: cz, mesh,
        opened: false,
        lootValue: 0,   // 搜索完成后填充
      });
    }
  }

  /* ===== 输入动作注册 ===== */
  _registerInputActions(){
    const input = this.engine.input;
    input.registerAction('reload', { keys: ['r'] });
    input.registerAction('switchWeapon', { keys: ['f'] });
    input.registerAction('search', { keys: ['g'] });
    input.registerAction('skill1', { keys: ['q'] });
    input.registerAction('skill2', { keys: ['e'] });
    input.registerAction('protectL1', { keys: ['1'] });
    input.registerAction('protectL2', { keys: ['2'] });
    input.registerAction('protectL3', { keys: ['3'] });
  }

  /* ===== 主更新 ===== */
  update(dt){
    if (!this.running || this.paused) return;
    this.time += dt;

    this.tasks.tickSurvive(dt);
    this._updatePlayer(dt);
    this._updateEnemies(dt);
    this._updateBullets(dt);
    this._updateExtracts(dt);
    this._updateContainers(dt);
    this._updateTracers(dt);

    // 物理
    this.physics.step(dt);

    // 同步网格
    this._syncMeshes();

    // 相机
    if (this.player) {
      this.engine.cameraCtl.follow(this.player.body.position.x, this.player.body.position.z);
    }

    // HUD
    this.hud.update();

    // 超时
    if (this.timeLimit > 0 && this.time >= this.timeLimit) {
      this._log('时间耗尽', 'r');
      this._end(false);
    }
  }

  /* ===== 玩家更新 ===== */
  _updatePlayer(dt){
    const p = this.player;
    if (!p || !p.alive) return;

    // 瞄准
    const aim = this.engine.input.getAimVector(
      p.body.position.x, p.body.position.z, this.engine.renderer.camera
    );
    if (Math.abs(aim.x) > 0.01 || Math.abs(aim.z) > 0.01) {
      p.angle = Math.atan2(aim.z, aim.x);
    }

    // 移动（由物理处理碰撞）
    const mv = this.engine.input.getMoveVector();
    p.body.velocity.x = mv.x * p.charSpec.speed;
    p.body.velocity.z = mv.z * p.charSpec.speed;

    // 防护
    this._updateProtection(dt);

    // 技能冷却
    for (const sk of p.skills) {
      if (!sk.ready) {
        sk.cd -= dt;
        if (sk.cd <= 0) {
          sk.ready = true;
          sk.cd = 0;
        }
      }
    }

    // 开火 / 换弹
    if (p.reloading > 0) {
      p.reloading -= dt;
      if (p.reloading <= 0) this._finishReload();
    } else {
      if (p.fireCd > 0) p.fireCd -= dt;

      const firing = this.engine.input.isActive('fire');
      if (firing && p.fireCd <= 0 && p.weapon) {
        if (p.weapon.mag <= 0) this._startReload();
        else this._fireWeapon(p, p.weapon, true);
      }
    }

    // 换弹按键
    if (this.engine.input.isActive('reload')) this._startReload();
    // 切枪
    if (this.engine.input.isActive('switchWeapon') && p.sidearm) this._switchWeapon();
    // 技能
    if (this.engine.input.isActive('skill1')) this._useSkill(0);
    if (this.engine.input.isActive('skill2')) this._useSkill(1);
    // 搜索容器
    if (this.engine.input.isActive('search')) this._trySearchContainer();
    // 防护按键
    if (this.engine.input.isActive('protectL1')) this._toggleProtection('L1');
    if (this.engine.input.isActive('protectL2')) this._toggleProtection('L2');
    if (this.engine.input.isActive('protectL3')) this._toggleProtection('L3');

    // 边界钳制
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
      // 恢复（延迟）
      if (this._protectionStartTime > 0) {
        this._lastProtectionUse = this.time;
        this._protectionStartTime = 0;
      }
      const sinceLastUse = this.time - this._lastProtectionUse;
      if (sinceLastUse > COMBAT.COUPLING_REGEN_DELAY) {
        const rate = (this.time - this._lastProtectionUse > COMBAT.COUPLING_LONG_THRESHOLD)
          ? COMBAT.COUPLING_REGEN_LONG
          : COMBAT.COUPLING_REGEN_IDLE;
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
    p.reloading = w.def.reload;
    p.reloadTime = w.def.reload;
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

  /* ===== 开火 ===== */
  _fireWeapon(owner, weapon, isPlayer){
    if (!weapon || !weapon.def) return;
    const def = weapon.def;
    const ammo = weapon.ammoDef;
    if (!ammo) return;

    // 冷却
    if (isPlayer) {
      owner.fireCd = 60 / def.rpm;
    } else {
      owner.fireCd = 60 / def.rpm * (0.9 + Math.random() * 0.4);
    }

    // 消耗弹药
    if (isPlayer) {
      weapon.mag--;
      this.stats.shots++;
    }

    // 扩散
    const baseSpread = def.spread || 0.02;
    const acc = isPlayer ? 1.0 : (owner.spec ? owner.spec.acc : 0.5);
    const spread = baseSpread * (isPlayer ? 1 : (1.5 - acc));

    // 基础动能
    const baseEnergy = CombatSystem.kinetic(ammo.massG, ammo.v0);
    const range = (def.range || 50) * 10;

    // 发射弹丸
    const pellets = def.pellets || 1;
    for (let i = 0; i < pellets; i++) {
      const a = owner.angle + (Math.random() * 2 - 1) * spread;
      this._raycastBullet(owner, a, baseEnergy, range, def, ammo, isPlayer);
    }

    // 音效
    this._playSFX('shot_' + def.cls, { volume: 0.6 });
  }

  /* 射线判定：玩家和敌人共用 */
  _raycastBullet(owner, angle, baseEnergy, range, weaponDef, ammoDef, isPlayer){
    const px = owner.body.position.x;
    const pz = owner.body.position.z;
    const ox = px + Math.cos(angle) * 1.0;
    const oz = pz + Math.sin(angle) * 1.0;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);

    const hitFilter = isPlayer
      ? (body) => body !== owner.body && (body.userData?.type === 'enemy' || body.userData?.type === 'obstacle')
      : (body) => body !== owner.body && (body.userData?.type === 'player' || body.userData?.type === 'obstacle');

    const hit = this.physics.raycast(ox, 1.2, oz, dx, 0, dz, range, hitFilter);

    const endX = hit ? hit.point.x : ox + dx * range;
    const endZ = hit ? hit.point.z : oz + dz * range;

    // 视觉弹道
    this._spawnTracer(ox, oz, endX, endZ, isPlayer ? 0xffe08a : 0xff8b7b);

    if (!hit) return;

    const distance = hit.t;
    const energy = CombatSystem.energyAtRange(baseEnergy, distance, range);
    const pen = ammoDef.tier || 0;

    if (hit.body.userData.type === 'obstacle') {
      this._spawnSpark(hit.point.x, hit.point.z);
      return;
    }

    if (isPlayer && hit.body.userData.type === 'enemy') {
      this._damageEnemy(hit.body.userData.ref, energy, pen);
    } else if (!isPlayer && hit.body.userData.type === 'player') {
      this._damagePlayer(hit.body.userData.ref, energy, pen);
    }
  }

  /* ===== 玩家开火入口（供敌人开火复用） ===== */
  enemyFire(enemy, target){
    if (!enemy.alive || !enemy.weapon) return;
    if (enemy.trainingDummy) return;
    this._fireWeapon(enemy, enemy.weapon, false);
  }

  /* ===== 伤害结算 ===== */
  _damageEnemy(enemy, energy, pen){
    if (!enemy.alive) return;

    // 头部概率（这里简化为随机 10% 爆头）
    const isHead = Math.random() < 0.1;
    const finalEnergy = isHead ? energy * COMBAT.HEAD_MULT : energy;

    const dmg = CombatSystem.energyToHP(finalEnergy, false);
    enemy.hp -= dmg;
    enemy.hitFlash = 0.15;
    this.player.dealt += dmg;
    this.stats.hits++;
    if (isHead) this.stats.headshots++;

    // 伤害数字
    this._spawnDamageNumber(enemy.body.position.x, enemy.body.position.z, Math.round(dmg), 'enemy');

    // 命中反馈
    this._hitMarker();

    // 音效
    this._playSFX('hit', { volume: 0.4 });

    if (enemy.hp <= 0 && enemy.alive) {
      this._killEnemy(enemy);
    }
  }

  _damagePlayer(player, energy, pen){
    if (!player.alive) return;

    // 耦合防护
    const coup = CombatSystem.applyCoupling(player, energy, 'ballistic');
    if (coup.cost > 0) {
      player.coupling = Math.max(0, player.coupling - coup.cost);
    }
    let remaining = coup.remaining;

    // 护甲
    const plate = CombatSystem.applyArmor(player.armor.plate, remaining, pen);
    remaining = plate.remaining;
    const fiber = CombatSystem.applyArmor(player.armor.fiber, remaining, pen);
    remaining = fiber.remaining;

    // 头部概率（简化）
    const isHead = Math.random() < 0.05;
    if (isHead) remaining *= COMBAT.HEAD_MULT;

    const dmg = CombatSystem.energyToHP(remaining, player.charSpec.prazer);
    player.hp -= dmg;
    player.taken += dmg;

    this._spawnDamageNumber(player.body.position.x, player.body.position.z, Math.round(dmg), 'player');
    this._hurtFX();
    this.engine.cameraCtl.shake(0.4, 0.15);
    this._playSFX('hurt', { volume: 0.5 });

    if (player.hp <= 0 && player.alive) {
      this._playerDown();
    }
  }

  _killEnemy(enemy){
    enemy.alive = false;
    enemy.body.alive = false;
    this.physics.remove(enemy.body);
    if (enemy.mesh) enemy.mesh.visible = false;
    this.player.kills++;
    this.stats.kills++;

    this._spawnSpark(enemy.body.position.x, enemy.body.position.z);

    // 任务 + 模式 hook
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

  /* ===== 撤离 ===== */
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

  /* ===== 容器搜索 ===== */
  _updateContainers(dt){
    if (!this._searching) {
      // 检查玩家附近可搜索容器
      const p = this.player;
      if (!p || !p.alive) return;
      let best = null, bestDist = COMBAT.SEARCH_RADIUS;
      for (const c of this.containers) {
        if (c.opened) continue;
        const d = Math.hypot(p.body.position.x - c.x, p.body.position.z - c.z);
        if (d < bestDist) {
          best = c;
          bestDist = d;
        }
      }
      this._searchTarget = best;
    } else {
      // 正在搜索
      this._searchTimer += dt;
      if (this._searchTimer >= COMBAT.SEARCH_TIME) {
        this._finishSearch();
      }
    }
  }

  _trySearchContainer(){
    if (this._searching) return;
    if (!this._searchTarget) {
      this._log('附近没有可搜索的容器', 'y');
      return;
    }
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
    // 给基础价值：随机 100-500
    const lootValue = 100 + Math.floor(Math.random() * 400);
    this.player.carriedValue += lootValue;
    this.tasks.progress('loot', 1);
    this._log('搜索完成 · 获得物资 ' + lootValue + ' cp', 'g');
  }

  /* ===== 技能 ===== */
  _useSkill(slot){
    const p = this.player;
    if (!p || !p.alive) return;
    const sk = p.skills[slot];
    if (!sk || !sk.ready) return;
    if (sk.def.cost > 0 && p.coupling < sk.def.cost) {
      this._log('耦合能不足', 'y');
      return;
    }
    if (sk.def.cost > 0) p.coupling -= sk.def.cost;
    sk.cd = sk.def.cd;
    sk.ready = false;

    // 应用技能效果
    this._applySkillEffect(p, sk.def);

    this._log('【' + this.engine.i18n.t(sk.def.name) + '】已触发', 'p');
    this._playSFX('skill');
  }

  _applySkillEffect(p, def){
    switch (def.kind) {
      case 'dash': {
        // 向当前瞄准方向冲刺
        const angle = p.angle;
        const dist = def.distance || 5;
        p.body.position.x += Math.cos(angle) * dist;
        p.body.position.z += Math.sin(angle) * dist;
        break;
      }
      case 'timedBuff': {
        // 临时 buff（下次接入时间系统）
        p.buffs = p.buffs || {};
        p.buffs[def.effect] = this.time + def.duration;
        break;
      }
      case 'healPercent': {
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * def.percent);
        break;
      }
      case 'drone': {
        // 简化：标记周围敌人
        this._log('无人机已部署（占位）', 'y');
        break;
      }
      case 'taunt': {
        // 强制周围敌人攻击自己
        for (const e of this.enemies) {
          if (!e.alive) continue;
          const d = Math.hypot(p.body.position.x - e.body.position.x, p.body.position.z - e.body.position.z);
          if (d < 15) e.state = 'combat';
        }
        break;
      }
    }
  }

  /* ===== 敌人更新 ===== */
  _updateEnemies(dt){
    for (const e of this.enemies) {
      if (!e.alive) continue;
      AISystem.update(this, e, dt);
    }
  }

  /* ===== 子弹更新（射线结算后已无 Body，此方法无实际操作，保留占位） ===== */
  _updateBullets(dt){ /* 子弹在射线中已经结算 */ }

  /* ===== 视觉辅助 ===== */
  _spawnTracer(x1, z1, x2, z2, color){
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array([x1, 1.2, z1, x2, 1.2, z2]);
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

  _spawnSpark(x, z){
    const mesh = this.engine.meshes.build('spark', { color: 0xffaa44 });
    mesh.position.set(x, 1.2, z);
    this.engine.renderer.scene.add(mesh);
    setTimeout(() => {
      this.engine.renderer.scene.remove(mesh);
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) mesh.material.dispose();
    }, 120);
  }

  _spawnDamageNumber(x, z, val, kind){
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
      font-family:var(--mono);
    `;
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = 'translate(-50%,-80px)';
      el.style.opacity = '0';
    });
    setTimeout(() => el.remove(), 750);
  }

  _hitMarker(){
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

  /* ===== 音效 ===== */
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
        // 白噪音爆破
        const buffer = ac.createBuffer(1, Math.floor(ac.sampleRate * 0.08), ac.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / data.length * 5);
        const src = ac.createBufferSource();
        src.buffer = buffer;
        const gain = ac.createGain();
        const vol = optsSafe.volume || 0.4;
        gain.gain.setValueAtTime(vol, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
        const filter = ac.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 2000;
        src.connect(filter).connect(gain).connect(ac.destination);
        src.start(now);
        src.stop(now + 0.08);
      } else if (name === 'hit') {
        const osc = ac.createOscillator();
        osc.type = 'square';
        osc.frequency.value = 800;
        const gain = ac.createGain();
        gain.gain.setValueAtTime(optsSafe.volume || 0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.04);
        osc.connect(gain).connect(ac.destination);
        osc.start(now);
        osc.stop(now + 0.05);
      } else if (name === 'reload') {
        for (let i = 0; i < 2; i++) {
          const osc = ac.createOscillator();
          osc.type = 'triangle';
          osc.frequency.value = i === 0 ? 300 : 500;
          const gain = ac.createGain();
          gain.gain.setValueAtTime(0.15, now + i * 0.1);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.1 + 0.06);
          osc.connect(gain).connect(ac.destination);
          osc.start(now + i * 0.1);
          osc.stop(now + i * 0.1 + 0.07);
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
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (name === 'hurt') {
        const osc = ac.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.15);
        const gain = ac.createGain();
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.connect(gain).connect(ac.destination);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (name === 'skill') {
        [400, 600, 900].forEach((f, i) => {
          const osc = ac.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = f;
          const gain = ac.createGain();
          gain.gain.setValueAtTime(0.15, now + i * 0.05);
          gain.gain.exponentialRampToValueAtTime(0.001, now + i * 0.05 + 0.15);
          osc.connect(gain).connect(ac.destination);
          osc.start(now + i * 0.05);
          osc.stop(now + i * 0.05 + 0.15);
        });
      }
    } catch (e) {
      // 忽略音效错误，游戏继续
    }
  }

  /* ===== 日志 ===== */
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

  /* ===== 模式 hook ===== */
  _processModeHook(hookName, ...args){
    const hooks = this.modeConfig && this.modeConfig.hooks;
    if (!hooks) return;
    const fn = hooks[hookName];
    if (typeof fn !== 'function') return;
    try { fn(this, ...args); }
    catch (e) { console.error(`[Mode] ${hookName}:`, e); }
  }

  /* ===== 同步网格 ===== */
  _syncMeshes(){
    const p = this.player;
    if (p && p.mesh) {
      p.mesh.position.set(p.body.position.x, 0, p.body.position.z);
      p.mesh.rotation.y = -p.angle;
    }
    for (const e of this.enemies) {
      if (!e.alive || !e.mesh) continue;
      e.mesh.position.set(e.body.position.x, 0, e.body.position.z);
      e.mesh.rotation.y = -e.angle;
      // 命中闪光
      if (e.hitFlash > 0) {
        e.mesh.traverse(obj => {
          if (obj.isMesh && obj.material && obj.material.emissive) {
            obj.material.emissive.setHex(0xffffff);
            obj.material.emissiveIntensity = 0.6;
          }
        });
      } else {
        e.mesh.traverse(obj => {
          if (obj.isMesh && obj.material && obj.material.emissive) {
            obj.material.emissiveIntensity = 0;
          }
        });
      }
    }
  }

  /* ===== 暂停 ===== */
  pause(){
    this.paused = true;
  }
  resume(){
    this.paused = false;
  }

  /* ===== 结束 ===== */
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

  /* ===== 销毁 ===== */
  destroy(){
    this.running = false;
    if (this.tracers) {
      for (const t of this.tracers) {
        this.engine.renderer.scene.remove(t.line);
        t.line.geometry.dispose();
        t.line.material.dispose();
      }
      this.tracers = [];
    }
    this.physics.clear();
    this.enemies = [];
    this.obstacles = [];
    this.containers = [];
    this.extracts = [];
    this.engine.renderer.clearScene();
  }
}

/* ============================================================
   [6] GameApp · 应用层
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
    };
    this._lastMatchKind = 'normal';
    this._menuReady = false;
    this._boundHandlers = {};
  }

  boot(){
    this._setupMenu();
    this._bindGlobalHandlers();
    this._registerDevCommands();
  }

  /* ===== 菜单 ===== */
  _setupMenu(){
    const e = this.engine;
    const i18n = e.i18n;

    // 模式选项
    this._renderOptions(
      'mode-options',
      e.modeRegistry.all(),
      (item) => item.id === this.menuState.mode,
      (item) => ({
        title: i18n.t(item.name),
        sub: i18n.t(item.desc || ''),
        tag: '',
        value: item.id,
      }),
      (item) => { this.menuState.mode = item.id; this._updateModeHint(); }
    );

    // 地图选项
    this._renderOptions(
      'map-options',
      e.content.all('maps'),
      (item) => item.id === this.menuState.map,
      (item) => ({
        title: i18n.t(item.name),
        sub: `${item.size}m² · ${item.enemyCount} 敌人`,
        tag: '',
        value: item.id,
      }),
      (item) => { this.menuState.map = item.id; }
    );

    // 难度选项
    const diffs = [
      { id: 'easy', name: 'difficulty.easy.name', desc: '敌人弱 · 数量少' },
      { id: 'normal', name: 'difficulty.normal.name', desc: '标准' },
      { id: 'hard', name: 'difficulty.hard.name', desc: '敌人强 · 数量多' },
      { id: 'nightmare', name: 'difficulty.nightmare.name', desc: '极端难度' },
    ];
    this._renderOptions(
      'diff-options',
      diffs,
      (item) => item.id === this.menuState.diff,
      (item) => ({
        title: i18n.t(item.name),
        sub: item.desc,
        tag: '',
        value: item.id,
      }),
      (item) => { this.menuState.diff = item.id; }
    );

    // 角色选项
    this._renderOptions(
      'char-options',
      e.content.all('characters'),
      (item) => item.id === this.menuState.char,
      (item) => ({
        title: i18n.t(item.name),
        sub: i18n.t(item.tag),
        tag: item.weapon,
        value: item.id,
      }),
      (item) => { this.menuState.char = item.id; }
    );

    this._updateModeHint();
    this._menuReady = true;
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

  /* ===== 全局绑定 ===== */
  _bindGlobalHandlers(){
    const e = this.engine;

    // 开始
    document.getElementById('btn-start').addEventListener('click', () => this.startMatch('normal'));
    // 训练
    document.getElementById('btn-train').addEventListener('click', () => this.startMatch('training'));

    // 暂停
    document.getElementById('pause-btn').addEventListener('click', () => this._togglePause());

    // 暂停浮层
    document.getElementById('btn-resume').addEventListener('click', () => this._togglePause(false));
    document.getElementById('btn-quit').addEventListener('click', () => this._quitToMenu());

    // 结算浮层
    document.getElementById('btn-again').addEventListener('click', () => {
      document.getElementById('result-screen').classList.remove('on');
      this.startMatch(this._lastMatchKind);
    });
    document.getElementById('btn-menu').addEventListener('click', () => {
      document.getElementById('result-screen').classList.remove('on');
      this._quitToMenu();
    });

    // 键盘 ESC 暂停
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.world && this.world.running) {
        ev.preventDefault();
        this._togglePause();
      }
    });

    // 语言切换回调
    e.i18n.onLanguageChange(() => {
      if (this._menuReady) {
        this._setupMenu();
        // 保留当前 world 的 HUD 刷新
        if (this.world) this.world.hud.update();
      }
    });
  }

  /* ===== DEV 命令 ===== */
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
          this.world._spawnEnemy(spec, p.body.position.x + Math.cos(a) * r, p.body.position.z + Math.sin(a) * r, 1);
        }
        return `已在玩家附近生成 ${count} 个 ${args[0]}`;
      }
    });
  }

  /* ===== 开始对局 ===== */
  startMatch(kind){
    const e = this.engine;
    this._lastMatchKind = kind;

    // 清理旧 world
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

      // 切换界面
      this._showScreen('game');
      e.bus.emit('matchStarted', { kind, success: null });
    } catch (err) {
      console.error('[GameApp] startMatch failed:', err);
      alert('启动失败：' + (err && err.message ? err.message : String(err)));
      this._showScreen('menu');
    }
  }

  /* ===== 对局结束 ===== */
  _onMatchEnd(success, stats){
    const e = this.engine;
    const save = e.save;
    save.data.stats = save.data.stats || { runs: 0, extracts: 0, deaths: 0, kills: 0 };
    save.data.stats.runs++;
    if (success) save.data.stats.extracts++;
    else save.data.stats.deaths++;
    save.data.stats.kills = (save.data.stats.kills || 0) + (stats.kills || 0);

    // 奖励
    let reward = 0;
    if (success) reward += 500;
    reward += (stats.kills || 0) * 30;
    reward += (stats.carriedValue || 0);
    save.data.credits = (save.data.credits || 0) + reward;
    save.save();

    // 结算界面
    const title = document.getElementById('result-title');
    const statsEl = document.getElementById('result-stats');
    title.textContent = e.i18n.t(success ? 'ui.result.extract_success' : 'ui.result.operation_failed');
    title.className = success ? 'success' : 'fail';

    const statLines = [
      `击杀：<b>${stats.kills}</b>　命中率：<b>${stats.accuracy}%</b>`,
      `造成伤害：<b>${stats.dealt}</b>　承受伤害：<b>${stats.taken}</b>`,
      `存活：<b>${stats.time}s</b>　携带物资：<b>${stats.carriedValue} cp</b>`,
      `<div style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(120,180,240,.3)">
        本局奖励：<b style="color:var(--gold)">+${reward} cp</b>
      </div>`,
    ];
    statsEl.innerHTML = statLines.join('<br>');

    // 显示结算
    document.getElementById('result-screen').classList.add('on');
    document.getElementById('pause-screen').classList.remove('on');

    // 引擎层也可以监听
    e.bus.emit('matchEnded', { success, stats, reward });
  }

  /* ===== 暂停 ===== */
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

  /* ===== 返回菜单 ===== */
  _quitToMenu(){
    if (this.world) {
      try { this.world.destroy(); } catch (e) { console.warn(e); }
      this.world = null;
    }
    this._showScreen('menu');
    this.engine.save.refreshMenu && this.engine.save.refreshMenu();
  }

  /* ===== 界面切换 ===== */
  _showScreen(name){
    const map = {
      boot: 'boot-screen',
      menu: 'menu-screen',
      game: 'game-screen',
    };
    for (const key in map) {
      const el = document.getElementById(map[key]);
      if (!el) continue;
      el.classList.toggle('on', key === name);
    }
  }

  /* ===== 语言切换（外部调用） ===== */
  setLanguage(code){
    const ok = this.engine.setLanguage(code);
    if (ok) {
      // 重渲染菜单
      if (this._menuReady) this._setupMenu();
      // 重渲染当前对局 HUD
      if (this.world) {
        this.world.hud.update();
        this.world.tasks.render();
      }
    }
    return ok;
  }
}