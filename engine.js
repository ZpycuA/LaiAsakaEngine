/* ============================================================
   LaiAsaka Engine · Core
   v3.0.0 · © 2026 ZpycuA · CC BY-NC 4.0
   ------------------------------------------------------------
   完整引擎核心。不含任何游戏概念（无武器/无敌人/无地图）。
   所有游戏内容由 content.js 注册，所有模式由 modes.js 注册，
   所有应用逻辑由 game.js 承载。

   模块清单：
     [0]  工具函数
     [1]  EventBus
     [2]  ObjectPool
     [3]  SpatialHash
     [4]  FixedLoop（含 TimeScale）
     [5]  I18nSystem
     [6]  ContentRegistry
     [7]  SaveSystem
     [8]  VirtualJoystick
     [9]  InputSystem（键鼠 + 触屏 + 摇杆）
     [10] PerformanceMonitor
     [11] Renderer3D
     [12] MeshFactory（含默认 builders）
     [13] SceneManager
     [14] CameraController
     [15] Body
     [16] PhysicsWorld（重力/碰撞/射线/睡眠/事件）
     [17] AudioSystem（完整 Web Audio 实现）
     [18] Loader（完整 GLTF/Texture/Audio/JSON 实现）
     [19] DevConsole（完整命令/自动补全/历史）
     [20] ModeRegistry
     [20.5]ProfileSystem（玩法操作难度预设）
     [21] Engine（总装）
     [22] 导出
   ============================================================ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/* ============================================================
   [0] 工具函数
   ============================================================ */
const TAU = Math.PI * 2;

const clamp   = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp    = (a, b, t) => a + (b - a) * t;
const rand    = (a, b) => a + Math.random() * (b - a);
const randi   = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick    = arr => arr[(Math.random() * arr.length) | 0];
const dist    = (ax, az, bx, bz) => Math.hypot(bx - ax, bz - az);
const distSq  = (ax, az, bx, bz) => (bx - ax) ** 2 + (bz - az) ** 2;

const angDiff = (a, b) => {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

const $  = id  => (typeof document !== 'undefined' ? document.getElementById(id) : null);
const $$ = sel => (typeof document !== 'undefined' ? Array.from(document.querySelectorAll(sel)) : []);

const isNum = v => typeof v === 'number' && isFinite(v);
const safeNum = (v, d) => isNum(v) ? v : (isNum(d) ? d : 0);

const deepCopy = obj => {
  try { return JSON.parse(JSON.stringify(obj)); }
  catch (e) { return obj; }
};

const deepMerge = (target, source) => {
  if (!source || typeof source !== 'object') return target;
  for (const k in source) {
    if (Array.isArray(source[k])) {
      target[k] = source[k].slice();
    } else if (source[k] && typeof source[k] === 'object') {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      deepMerge(target[k], source[k]);
    } else {
      target[k] = source[k];
    }
  }
  return target;
};

const Utils = {
  TAU, clamp, lerp, rand, randi, pick, dist, distSq, angDiff,
  $, $$, isNum, safeNum, deepCopy, deepMerge,
};

/* ============================================================
   [1] EventBus
   ============================================================ */
class EventBus {
  constructor(){
    this._m = new Map();
    this._once = new Map();
  }
  on(name, fn){
    let s = this._m.get(name);
    if (!s) { s = new Set(); this._m.set(name, s); }
    s.add(fn);
    return () => s.delete(fn);
  }
  off(name, fn){
    const s = this._m.get(name);
    if (s) s.delete(fn);
  }
  once(name, fn){
    const off = this.on(name, (p) => { off(); fn(p); });
    return off;
  }
  emit(name, payload){
    const s = this._m.get(name);
    if (s) {
      for (const fn of [...s]) {
        try { fn(payload); } catch (e) { console.error('[bus]', name, e); }
      }
    }
    const s2 = this._once.get(name);
    if (s2) {
      this._once.delete(name);
      for (const fn of [...s2]) {
        try { fn(payload); } catch (e) { console.error('[bus:once]', name, e); }
      }
    }
  }
  clear(name){
    if (name) { this._m.delete(name); this._once.delete(name); }
    else { this._m.clear(); this._once.clear(); }
  }
  listenerCount(name){
    return (this._m.get(name)?.size || 0) + (this._once.get(name)?.size || 0);
  }
}

/* ============================================================
   [2] ObjectPool
   ============================================================ */
class ObjectPool {
  constructor(factory, reset, opts){
    opts = opts || {};
    this.factory = factory;
    this.reset   = reset || null;
    this.free    = [];
    this.active  = new Set();
    this.maxSize = opts.maxSize || Infinity;
    this._stats  = { acquired: 0, released: 0, created: 0 };
    // 预热
    if (opts.prewarm && opts.prewarm > 0) {
      for (let i = 0; i < opts.prewarm; i++) {
        const obj = this.factory();
        this.free.push(obj);
        this._stats.created++;
      }
    }
  }
  acquire(){
    let obj;
    if (this.free.length > 0) {
      obj = this.free.pop();
    } else {
      obj = this.factory();
      this._stats.created++;
    }
    this.active.add(obj);
    this._stats.acquired++;
    return obj;
  }
  release(obj){
    if (!this.active.has(obj)) return false;
    this.active.delete(obj);
    if (this.reset) {
      try { this.reset(obj); } catch (e) { console.warn('[Pool] reset err', e); }
    }
    if (this.free.length < this.maxSize) this.free.push(obj);
    this._stats.released++;
    return true;
  }
  releaseAll(){
    for (const obj of this.active) {
      if (this.reset) this.reset(obj);
      if (this.free.length < this.maxSize) this.free.push(obj);
    }
    this.active.clear();
    this._stats.released += this.active.size;
  }
  forEachActive(fn){ for (const o of this.active) fn(o); }
  get stats(){
    return {
      free: this.free.length,
      active: this.active.size,
      ...this._stats,
    };
  }
}

/* ============================================================
   [3] SpatialHash
   ============================================================ */
class SpatialHash {
  constructor(cellSize){
    this.cellSize = cellSize || 8;
    this.cells = new Map();
    this._objCells = new WeakMap(); // 记录对象所在格，便于快速移除
  }
  _key(cx, cz){ return cx + ',' + cz; }
  clear(){ this.cells.clear(); this._objCells = new WeakMap(); }
  insert(body){
    const cx = Math.floor(body.position.x / this.cellSize);
    const cz = Math.floor(body.position.z / this.cellSize);
    const k  = this._key(cx, cz);
    let arr = this.cells.get(k);
    if (!arr) { arr = []; this.cells.set(k, arr); }
    arr.push(body);
    this._objCells.set(body, { cx, cz });
  }
  remove(body){
    const info = this._objCells.get(body);
    if (!info) return;
    const arr = this.cells.get(this._key(info.cx, info.cz));
    if (arr) {
      const i = arr.indexOf(body);
      if (i >= 0) arr.splice(i, 1);
    }
    this._objCells.delete(body);
  }
  queryCircle(x, z, r){
    const result = [];
    const cs = this.cellSize;
    const minCX = Math.floor((x - r) / cs);
    const maxCX = Math.floor((x + r) / cs);
    const minCZ = Math.floor((z - r) / cs);
    const maxCZ = Math.floor((z + r) / cs);
    const r2 = r * r;
    for (let cx = minCX; cx <= maxCX; cx++) {
      for (let cz = minCZ; cz <= maxCZ; cz++) {
        const arr = this.cells.get(this._key(cx, cz));
        if (!arr) continue;
        for (const b of arr) {
          const dx = b.position.x - x;
          const dz = b.position.z - z;
          const rr = r + (b.radius || 0);
          if (dx * dx + dz * dz <= rr * rr) result.push(b);
        }
      }
    }
    return result;
  }
  queryAABB(minX, minZ, maxX, maxZ){
    const result = [];
    const cs = this.cellSize;
    const cx0 = Math.floor(minX / cs);
    const cx1 = Math.floor(maxX / cs);
    const cz0 = Math.floor(minZ / cs);
    const cz1 = Math.floor(maxZ / cs);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const arr = this.cells.get(this._key(cx, cz));
        if (!arr) continue;
        for (const b of arr) result.push(b);
      }
    }
    return result;
  }
  get count(){
    let n = 0;
    for (const arr of this.cells.values()) n += arr.length;
    return n;
  }
}

/* ============================================================
   [4] FixedLoop（含 TimeScale）
   ============================================================ */
class FixedLoop {
  constructor({ step = 1/60, maxSteps = 4, onStep, onRender, onFrame }){
    this.baseStep = step;
    this.step = step;
    this.maxSteps = maxSteps;
    this.onStep = onStep;
    this.onRender = onRender;
    this.onFrame = onFrame;
    this.accumulator = 0;
    this.lastTime = 0;
    this.running = false;
    this.paused = false;
    this.timeScale = 1;
    this._raf = null;
    this._tick = this._tick.bind(this);
    // 性能统计
    this._stats = { frames: 0, steps: 0, stepTime: 0, renderTime: 0, frameTime: 0 };
  }
  start(){
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this._raf = requestAnimationFrame(this._tick);
  }
  stop(){
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }
  pause(){ this.paused = true; }
  resume(){
    this.paused = false;
    this.lastTime = performance.now();
  }
  setTimeScale(s){
    this.timeScale = clamp(s, 0, 10);
  }
  _tick(now){
    if (!this.running) return;
    const frameStart = performance.now();
    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;
    if (frameTime > 0.25) frameTime = 0.25;
    if (this.paused) {
      this._stats.frameTime = frameTime;
      this._raf = requestAnimationFrame(this._tick);
      return;
    }
    const scaledFrame = frameTime * this.timeScale;
    this.accumulator += scaledFrame;
    let steps = 0;
    const stepStart = performance.now();
    while (this.accumulator >= this.step && steps < this.maxSteps) {
      try { this.onStep(this.step); }
      catch (e) { console.error('[FixedLoop] step err:', e); }
      this.accumulator -= this.step;
      steps++;
    }
    if (steps >= this.maxSteps) this.accumulator = 0;
    const stepEnd = performance.now();
    try { if (this.onRender) this.onRender(this.accumulator / this.step); }
    catch (e) { console.error('[FixedLoop] render err:', e); }
    if (this.onFrame) {
      try { this.onFrame(frameTime); }
      catch (e) { console.error('[FixedLoop] frame err:', e); }
    }
    this._stats.frames++;
    this._stats.steps += steps;
    this._stats.stepTime = this._stats.stepTime * 0.9 + (stepEnd - stepStart) * 0.1;
    this._stats.renderTime = this._stats.renderTime * 0.9 + (performance.now() - stepEnd) * 0.1;
    this._stats.frameTime = this._stats.frameTime * 0.9 + frameTime * 1000 * 0.1;
    this._raf = requestAnimationFrame(this._tick);
  }
  get stats(){ return { ...this._stats }; }
}

/* ============================================================
   [5] I18nSystem
   ============================================================ */
class I18nSystem {
  constructor(){
    this.tables = new Map();
    this.current = {};
    this.currentCode = null;
    this.fallback = {};
    this.listeners = new Set();
  }
  register(code, table){
    this.tables.set(code, table || {});
    return this;
  }
  setLanguage(code){
    if (!this.tables.has(code)) {
      console.warn('[I18n] 未注册的语言:', code);
      return false;
    }
    this.currentCode = code;
    this.current = this.tables.get(code);
    for (const fn of this.listeners) {
      try { fn(code); } catch (e) { console.warn('[I18n] listener err', e); }
    }
    return true;
  }
  setFallback(table){ this.fallback = table || {}; return this; }
  hasLanguage(code){ return this.tables.has(code); }
  getLanguages(){ return [...this.tables.keys()]; }
  onLanguageChange(fn){
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  t(key, params){
    let str = this.current[key];
    if (str === undefined) str = this.fallback[key];
    if (str === undefined) str = key;
    if (params) {
      for (const k in params) {
        str = str.split('{' + k + '}').join(String(params[k]));
      }
    }
    return str;
  }
  applyToDOM(root){
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = this.t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-i18n-html]').forEach(el => {
      el.innerHTML = this.t(el.dataset.i18nHtml);
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      el.placeholder = this.t(el.dataset.i18nPlaceholder);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(el => {
      el.title = this.t(el.dataset.i18nTitle);
    });
  }
  applyToElement(el, key){
    if (!el) return;
    el.textContent = this.t(key);
  }
}

/* ============================================================
   [6] ContentRegistry
   ============================================================ */
class ContentRegistry {
  constructor(){
    this.tables = new Map();
    this._schemas = new Map();
  }
  table(name){
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name);
  }
  register(table, id, spec){
    if (!id) throw new Error('[Content] id required for ' + table);
    this.table(table).set(id, Object.freeze({ id, ...spec }));
  }
  registerAll(table, items){
    for (const [id, spec] of Object.entries(items || {})) this.register(table, id, spec);
  }
  load(json){
    for (const [table, items] of Object.entries(json || {})) {
      if (!items || typeof items !== 'object') continue;
      for (const [id, spec] of Object.entries(items)) this.register(table, id, spec);
    }
  }
  get(table, id){ return this.table(table).get(id); }
  has(table, id){ return this.table(table).has(id); }
  all(table){ return Array.from(this.table(table).values()); }
  ids(table){ return Array.from(this.table(table).keys()); }
  count(table){ return this.table(table).size; }
  remove(table, id){ return this.table(table).delete(id); }
  clear(table){
    if (table) this.table(table).clear();
    else this.tables.clear();
  }
  defineSchema(table, fields){
    this._schemas.set(table, fields);
  }
  validate(){
    const errs = [];
    const check = (table, id, field, target) => {
      const spec = this.get(table, id);
      if (!spec) return;
      const ref = spec[field];
      if (ref && !this.has(target, ref)) {
        errs.push(`${table}/${id}.${field} → ${target}/${ref} 不存在`);
      }
    };
    for (const w of this.all('weapons'))    check('weapons', w.id, 'ammoType', 'ammo');
    for (const e of this.all('enemies'))    check('enemies', e.id, 'weapon', 'weapons');
    for (const c of this.all('characters')) {
      check('characters', c.id, 'weapon', 'weapons');
      check('characters', c.id, 'sidearm', 'weapons');
      if (Array.isArray(c.skills)) {
        for (const sid of c.skills) {
          if (!this.has('skills', sid)) errs.push(`characters/${c.id}.skills → skills/${sid} 不存在`);
        }
      }
    }
    return errs;
  }
}

/* ============================================================
   [7] SaveSystem
   ============================================================ */
class SaveSystem {
  constructor(key, opts){
    opts = opts || {};
    this.key = key || 'LaiAsaka_Save';
    this.data = null;
    this.autoSave = opts.autoSave !== false;
    this._timer = null;
  }
  load(defaults){
    const def = deepCopy(defaults || {});
    try {
      const raw = localStorage.getItem(this.key);
      this.data = raw ? JSON.parse(raw) : def;
      for (const k in def) {
        if (this.data[k] === undefined) this.data[k] = deepCopy(def[k]);
      }
    } catch (e) {
      console.warn('[Save] load fail', e);
      this.data = def;
    }
    return this.data;
  }
  save(){
    if (!this.data) return false;
    try {
      localStorage.setItem(this.key, JSON.stringify(this.data));
      return true;
    } catch (e) {
      console.warn('[Save] write fail', e);
      return false;
    }
  }
  saveAsync(delay){
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this.save(), delay || 100);
  }
  reset(defaults){
    this.data = deepCopy(defaults || {});
    this.save();
    return this.data;
  }
  export(){
    return JSON.stringify(this.data, null, 2);
  }
  import(json){
    try {
      const parsed = typeof json === 'string' ? JSON.parse(json) : json;
      if (parsed && typeof parsed === 'object') {
        this.data = parsed;
        this.save();
        return true;
      }
    } catch (e) {
      console.warn('[Save] import fail', e);
    }
    return false;
  }
}

/* ============================================================
   [8] VirtualJoystick
   ============================================================ */
class VirtualJoystick {
  constructor(opts){
    opts = opts || {};
    this.side = opts.side || 'left';
    this.size = opts.size || 110;
    this.returnToCenter = opts.returnToCenter !== false;
    this._id = null;
    this._ox = 0; this._oy = 0;
    this._cx = 0; this._cy = 0;
    this._dx = 0; this._dy = 0;
    this.visible = false;
    this._baseEl = null;
    this._knobEl = null;
    this._parentEl = opts.parent || document.body;
    this._enabled = opts.enabled !== false;
  }

  _ensureElements(){
    if (this._baseEl) return;
    const base = document.createElement('div');
    base.style.cssText = `
      position:fixed;width:${this.size}px;height:${this.size}px;border-radius:50%;
      border:2px solid rgba(140,190,240,.35);background:rgba(60,100,150,.12);
      transform:translate(-50%,-50%);display:none;pointer-events:none;z-index:25;
      box-sizing:border-box;
    `;
    const knob = document.createElement('div');
    knob.style.cssText = `
      position:absolute;left:50%;top:50%;width:${this.size * 0.45}px;height:${this.size * 0.45}px;
      border-radius:50%;background:rgba(150,200,250,.4);border:2px solid rgba(180,220,255,.6);
      transform:translate(-50%,-50%);box-sizing:border-box;
    `;
    base.appendChild(knob);
    this._parentEl.appendChild(base);
    this._baseEl = base;
    this._knobEl = knob;
  }

  show(x, y){
    this._ensureElements();
    this._ox = x; this._oy = y;
    this._cx = x; this._cy = y;
    this._dx = 0; this._dy = 0;
    this.visible = true;
    this._baseEl.style.left = x + 'px';
    this._baseEl.style.top = y + 'px';
    this._baseEl.style.display = 'block';
    this._knobEl.style.left = '50%';
    this._knobEl.style.top = '50%';
  }

  update(x, y){
    if (!this.visible) return;
    const maxR = this.size / 2;
    let dx = x - this._ox;
    let dy = y - this._oy;
    const d = Math.hypot(dx, dy);
    if (d > maxR) {
      dx = dx / d * maxR;
      dy = dy / d * maxR;
    }
    this._dx = dx; this._dy = dy;
    this._cx = this._ox + dx;
    this._cy = this._oy + dy;
    if (this._knobEl) {
      this._knobEl.style.left = (50 + dx / maxR * 50) + '%';
      this._knobEl.style.top  = (50 + dy / maxR * 50) + '%';
    }
  }

  hide(){
    if (!this.visible) return;
    this.visible = false;
    if (this.returnToCenter) {
      this._dx = 0; this._dy = 0;
    }
    if (this._baseEl) this._baseEl.style.display = 'none';
  }

  get vector(){
    const maxR = this.size / 2;
    return {
      x: clamp(this._dx / maxR, -1, 1),
      y: clamp(this._dy / maxR, -1, 1),
      magnitude: clamp(Math.hypot(this._dx, this._dy) / maxR, 0, 1),
    };
  }

  destroy(){
    if (this._baseEl && this._baseEl.parentNode) this._baseEl.parentNode.removeChild(this._baseEl);
    this._baseEl = null;
    this._knobEl = null;
  }
}

/* ============================================================
   [9] InputSystem
   ============================================================ */
class InputSystem {
  constructor(){
    this.keys = new Set();
    this.mouse = { x: 0, y: 0, left: false, right: false, middle: false, wheel: 0 };
    this.touch = { left: null, right: null };
    this.actions = new Map();
    this.axes = new Map();
    this._bound = false;
    this._canvas = null;
    this.joystickLeft = null;
    this.joystickRight = null;
    this.enableVirtualJoysticks = false;
    this._touchStartPositions = new Map();
  }

  registerAction(name, cfg){ this.actions.set(name, cfg || {}); return this; }
  registerAxis(name, fn){ this.axes.set(name, fn); return this; }
  getAxis(name){ const f = this.axes.get(name); return f ? f() : 0; }

  isActive(name){
    const cfg = this.actions.get(name);
    if (!cfg) return false;
    if (cfg.keys) {
      for (const k of cfg.keys) if (this.keys.has(k)) return true;
    }
    if (cfg.mouse === 'left'  && this.mouse.left)  return true;
    if (cfg.mouse === 'right' && this.mouse.right) return true;
    if (cfg.mouse === 'middle' && this.mouse.middle) return true;
    return false;
  }

  isKeyDown(k){ return this.keys.has(k.toLowerCase()); }

  getMoveVector(){
    let mx = 0, mz = 0;
    if (this.keys.has('w') || this.keys.has('arrowup'))    mz -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown'))  mz += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft'))  mx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) mx += 1;
    if (this.joystickLeft && this.joystickLeft.visible) {
      const v = this.joystickLeft.vector;
      mx = v.x;
      mz = v.y;
    } else if (this.touch.left) {
      const dx = this.touch.left.x - this.touch.left.ox;
      const dz = this.touch.left.y - this.touch.left.oy;
      const l = Math.hypot(dx, dz);
      if (l > 8) {
        const k = Math.min(l, 60) / 60;
        mx = dx / l * k;
        mz = dz / l * k;
      }
    }
    const l = Math.hypot(mx, mz);
    if (l > 1) { mx /= l; mz /= l; }
    return { x: mx, z: mz };
  }

  getAimVector(ox, oz, camera){
    if (this.joystickRight && this.joystickRight.visible) {
      const v = this.joystickRight.vector;
      if (v.magnitude > 0.15) return { x: v.x, z: v.y };
    }
    if (this.touch.right) {
      const dx = this.touch.right.x - this.touch.right.ox;
      const dz = this.touch.right.y - this.touch.right.oy;
      if (Math.hypot(dx, dz) > 10) return { x: dx, z: dz };
    }
    if (camera) {
      const ray = new THREE.Raycaster();
      const ndc = new THREE.Vector2(
        (this.mouse.x / window.innerWidth) * 2 - 1,
        -(this.mouse.y / window.innerHeight) * 2 + 1
      );
      ray.setFromCamera(ndc, camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const pt = new THREE.Vector3();
      ray.ray.intersectPlane(plane, pt);
      if (pt) return { x: pt.x - ox, z: pt.z - oz };
    }
    return { x: 0, z: 0 };
  }

  attach(canvas){
    if (this._bound) return;
    this._bound = true;
    this._canvas = canvas;

    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      this.keys.add(k);
      if ([' ', 'tab', 'escape', 'shift'].includes(k)) e.preventDefault();
    });
    window.addEventListener('keyup', e => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());

    canvas.addEventListener('mousemove', e => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
    });
    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) this.mouse.left = true;
      if (e.button === 1) this.mouse.middle = true;
      if (e.button === 2) this.mouse.right = true;
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('mouseup', e => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 1) this.mouse.middle = false;
      if (e.button === 2) this.mouse.right = false;
    });
    window.addEventListener('wheel', e => { this.mouse.wheel = e.deltaY; }, { passive: true });

    canvas.addEventListener('touchstart', e => this._onTouchStart(e), { passive: false });
    canvas.addEventListener('touchmove',  e => this._onTouchMove(e),  { passive: false });
    canvas.addEventListener('touchend',   e => this._onTouchEnd(e),   { passive: false });
    canvas.addEventListener('touchcancel',e => this._onTouchEnd(e),   { passive: false });
  }

  _onTouchStart(e){
    for (const t of e.changedTouches) {
      const x = t.clientX, y = t.clientY;
      const isLeftSide = x < window.innerWidth * 0.45;
      if (isLeftSide && !this.touch.left) {
        this.touch.left = { id: t.identifier, ox: x, oy: y, x, y };
        if (this.enableVirtualJoysticks) {
          if (!this.joystickLeft) this.joystickLeft = new VirtualJoystick({ side: 'left' });
          this.joystickLeft.show(x, y);
        }
      } else if (!isLeftSide && !this.touch.right) {
        this.touch.right = { id: t.identifier, ox: x, oy: y, x, y };
        if (this.enableVirtualJoysticks) {
          if (!this.joystickRight) this.joystickRight = new VirtualJoystick({ side: 'right' });
          this.joystickRight.show(x, y);
        }
      }
      this._touchStartPositions.set(t.identifier, { x, y });
    }
    e.preventDefault();
  }

  _onTouchMove(e){
    for (const t of e.changedTouches) {
      if (this.touch.left && this.touch.left.id === t.identifier) {
        this.touch.left.x = t.clientX;
        this.touch.left.y = t.clientY;
        if (this.joystickLeft && this.joystickLeft.visible) {
          this.joystickLeft.update(t.clientX, t.clientY);
        }
      }
      if (this.touch.right && this.touch.right.id === t.identifier) {
        this.touch.right.x = t.clientX;
        this.touch.right.y = t.clientY;
        if (this.joystickRight && this.joystickRight.visible) {
          this.joystickRight.update(t.clientX, t.clientY);
        }
      }
    }
    e.preventDefault();
  }

  _onTouchEnd(e){
    for (const t of e.changedTouches) {
      if (this.touch.left && this.touch.left.id === t.identifier) {
        this.touch.left = null;
        if (this.joystickLeft) this.joystickLeft.hide();
      }
      if (this.touch.right && this.touch.right.id === t.identifier) {
        this.touch.right = null;
        if (this.joystickRight) this.joystickRight.hide();
      }
      this._touchStartPositions.delete(t.identifier);
    }
    e.preventDefault();
  }
}

/* ============================================================
   [10] PerformanceMonitor
   ============================================================ */
class PerformanceMonitor {
  constructor(){
    this.samples = {
      fps: [],
      frameTime: [],
      stepTime: [],
      renderTime: [],
      drawCalls: [],
    };
    this.maxSamples = 120;
    this.visible = false;
    this._el = null;
    this._updateTimer = 0;
    this._lastUpdate = 0;
  }

  record(name, value){
    const arr = this.samples[name];
    if (!arr) return;
    arr.push(value);
    if (arr.length > this.maxSamples) arr.shift();
  }

  avg(name){
    const arr = this.samples[name];
    if (!arr || !arr.length) return 0;
    let sum = 0;
    for (const v of arr) sum += v;
    return sum / arr.length;
  }

  recordFrame(frameTime){
    this.record('frameTime', frameTime * 1000);
    this.record('fps', frameTime > 0 ? 1 / frameTime : 0);
  }
  recordStep(ms){ this.record('stepTime', ms); }
  recordRender(ms, drawCalls){
    this.record('renderTime', ms);
    if (drawCalls !== undefined) this.record('drawCalls', drawCalls);
  }

  show(){
    if (this._el) { this._el.style.display = 'block'; this.visible = true; return; }
    const el = document.createElement('div');
    el.style.cssText = `
      position:fixed;left:10px;bottom:10px;z-index:300;
      background:rgba(0,0,0,.75);color:#7fe0ff;
      font-family:ui-monospace,Menlo,Consolas,monospace;
      font-size:11px;line-height:1.6;padding:8px 12px;
      border-radius:6px;border:1px solid rgba(120,200,255,.35);
      pointer-events:none;white-space:pre;
    `;
    document.body.appendChild(el);
    this._el = el;
    this.visible = true;
  }
  hide(){
    if (this._el) this._el.style.display = 'none';
    this.visible = false;
  }
  toggle(){
    if (this.visible) this.hide();
    else this.show();
  }
  update(){
    if (!this._el || !this.visible) return;
    const now = performance.now();
    if (now - this._lastUpdate < 250) return;
    this._lastUpdate = now;
    const fps = this.avg('fps');
    const frameT = this.avg('frameTime');
    const stepT = this.avg('stepTime');
    const renderT = this.avg('renderTime');
    const draws = this.avg('drawCalls');
    this._el.textContent =
      `FPS    ${fps.toFixed(1).padStart(6)}\n` +
      `Frame  ${frameT.toFixed(2).padStart(6)} ms\n` +
      `Step   ${stepT.toFixed(2).padStart(6)} ms\n` +
      `Render ${renderT.toFixed(2).padStart(6)} ms\n` +
      `Draws  ${Math.round(draws).toString().padStart(6)}`;
  }
}

/* ============================================================
   [11] Renderer3D
   ============================================================ */
class Renderer3D {
  constructor(canvas){
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x080b10);
    this.renderer.shadowMap.enabled = true;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x080b10, 30, 80);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 20, 20);
    this.camera.lookAt(0, 0, 0);

    this._lightGroup = null;
    this._setupLights();

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  _setupLights(){
    if (!this._lightGroup) {
      this._lightGroup = new THREE.Group();
      this._lightGroup.name = '__engine_lights__';
    }
    if (!this._lightGroup.parent) this.scene.add(this._lightGroup);
    while (this._lightGroup.children.length) {
      this._lightGroup.remove(this._lightGroup.children[0]);
    }
    const ambient = new THREE.AmbientLight(0x8fb4d8, 0.55);
    this._lightGroup.add(ambient);
    const sun = new THREE.DirectionalLight(0xcfe6ff, 0.85);
    sun.position.set(30, 60, 30);
    sun.castShadow = true;
    this._lightGroup.add(sun);
    const rim = new THREE.DirectionalLight(0xff9ec4, 0.35);
    rim.position.set(-40, 30, -20);
    this._lightGroup.add(rim);
  }

    resize(){
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 强制覆盖 Canvas 的 CSS，解决 UI 缩放问题
    this.canvas.style.width = '100vw';
    this.canvas.style.height = '100vh';
    }

  clearScene(){
    while (this.scene.children.length) {
      const c = this.scene.children[0];
      this.scene.remove(c);
      this._disposeObject(c);
    }
    this._lightGroup = null;
    this._setupLights();
  }

  _disposeObject(obj){
    if (!obj) return;
    obj.traverse(o => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) {
          for (const m of o.material) if (m.dispose) m.dispose();
        } else if (o.material.dispose) {
          o.material.dispose();
        }
      }
    });
  }

  render(){
    this.renderer.render(this.scene, this.camera);
  }

  get drawCalls(){ return this.renderer.info.render.calls; }
  get triangles(){ return this.renderer.info.render.triangles; }

  dispose(){
    this.renderer.dispose();
    this.clearScene();
  }
}

/* ============================================================
   [12] MeshFactory
   ============================================================ */
class MeshFactory {
  constructor(){
    this.builders = new Map();
    this._installDefaults();
  }
  register(type, builder){ this.builders.set(type, builder); return this; }
  has(type){ return this.builders.has(type); }
  build(type, spec){
    const b = this.builders.get(type);
    if (!b) {
      console.warn('[MeshFactory] Unknown type:', type);
      return new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0xff00ff })
      );
    }
    try {
      return b(spec || {});
    } catch (e) {
      console.error('[MeshFactory] build err', type, e);
      return new THREE.Mesh(
        new THREE.BoxGeometry(1, 1, 1),
        new THREE.MeshBasicMaterial({ color: 0xff00ff })
      );
    }
  }
  _installDefaults(){
    /* -------- player -------- */
    this.register('player', (spec) => {
      const g = new THREE.Group();
      const color = spec.color !== undefined ? spec.color : 0x5a6b7c;
      const radius = spec.radius || 1.2;
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(radius * 0.65, radius * 0.8, 6, 12),
        new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 })
      );
      body.position.y = radius * 1.1;
      g.add(body);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 0.5, 14, 14),
        new THREE.MeshStandardMaterial({ color: 0xf0d0a0, roughness: 0.7 })
      );
      head.position.y = radius * 2.2;
      g.add(head);
      const muzzle = new THREE.Mesh(
        new THREE.BoxGeometry(radius * 1.1, radius * 0.18, radius * 0.18),
        new THREE.MeshStandardMaterial({ color: 0x2b3542, roughness: 0.5, metalness: 0.4 })
      );
      muzzle.position.set(radius * 0.9, radius * 1.1, 0);
      g.add(muzzle);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius * 1.0, radius * 1.3, 32),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      g.add(ring);
      // Prazer 光环
      if (spec.prazer) {
        const aura = new THREE.Mesh(
          new THREE.RingGeometry(radius * 1.4, radius * 1.55, 32),
          new THREE.MeshBasicMaterial({ color: 0xb98cff, transparent: true, opacity: 0.35, side: THREE.DoubleSide })
        );
        aura.rotation.x = -Math.PI / 2;
        aura.position.y = 0.03;
        aura.name = '__prazer_aura__';
        g.add(aura);
      }
      return g;
    });

    /* -------- enemy -------- */
    this.register('enemy', (spec) => {
      const g = new THREE.Group();
      const color = spec.color !== undefined ? spec.color : 0x9a6a4a;
      const radius = spec.radius || 1.2;
      const body = new THREE.Mesh(
        new THREE.CapsuleGeometry(radius * 0.55, radius * 0.7, 6, 12),
        new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15 })
      );
      body.position.y = radius * 1.0;
      g.add(body);
      const head = new THREE.Mesh(
        new THREE.SphereGeometry(radius * 0.45, 14, 14),
        new THREE.MeshStandardMaterial({ color: 0xe0a070, roughness: 0.7 })
      );
      head.position.y = radius * 2.0;
      g.add(head);
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.9, radius * 1.1, 24),
        new THREE.MeshBasicMaterial({ color: 0xff5a5a, transparent: true, opacity: 0.45, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.02;
      g.add(ring);
      return g;
    });

    /* -------- obstacle -------- */
    this.register('obstacle', (spec) => {
      const w = spec.w || 4;
      const h = spec.h || 3;
      const d = spec.d || 4;
      const color = spec.color !== undefined ? spec.color : 0x22314a;
      const geo = new THREE.BoxGeometry(w, h, d);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.9, metalness: 0.15 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = h / 2;
      return mesh;
    });

    /* -------- bullet -------- */
    this.register('bullet', (spec) => {
      const color = spec.color !== undefined ? spec.color : 0xffe08a;
      return new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 8, 8),
        new THREE.MeshBasicMaterial({ color })
      );
    });

    /* -------- extractPoint -------- */
    this.register('extract', (spec) => {
      const g = new THREE.Group();
      const r = spec.radius || 3.5;
      const color = spec.color !== undefined ? spec.color : 0x5fd4ff;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r * 0.7, r, 40),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.05;
      g.add(ring);
      const pillar = new THREE.Mesh(
        new THREE.CylinderGeometry(r * 0.95, r * 0.95, 5, 32, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide })
      );
      pillar.position.y = 2.5;
      g.add(pillar);
      return g;
    });

    /* -------- container -------- */
    this.register('container', (spec) => {
      const color = spec.color !== undefined ? spec.color : 0xffcc33;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.3, 1.6),
        new THREE.MeshStandardMaterial({ color, emissive: 0x553300, emissiveIntensity: 0.4, roughness: 0.6 })
      );
      mesh.position.y = 0.65;
      return mesh;
    });

    /* -------- spark -------- */
    this.register('spark', (spec) => {
      const color = spec.color !== undefined ? spec.color : 0xffaa44;
      return new THREE.Mesh(
        new THREE.SphereGeometry(0.2, 4, 4),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
      );
    });
  }
}

/* ============================================================
   [13] SceneManager
   ============================================================ */
class SceneManager {
  constructor(renderer){
    this.renderer = renderer;
    this.scenes = new Map();
    this.current = null;
    this.currentName = null;
  }
  register(name, factory){ this.scenes.set(name, factory); return this; }
  has(name){ return this.scenes.has(name); }
  switchTo(name, ...args){
    if (this.current && this.current.exit) {
      try { this.current.exit(); } catch (e) { console.warn('[Scene] exit err:', e); }
    }
    const factory = this.scenes.get(name);
    if (!factory) throw new Error('[Scene] not found: ' + name);
    this.current = factory(this.renderer, ...args);
    this.currentName = name;
    if (this.current.enter) {
      try { this.current.enter(); } catch (e) { console.warn('[Scene] enter err:', e); }
    }
    return this.current;
  }
  update(dt){ if (this.current && this.current.update) this.current.update(dt); }
  render(alpha){
    if (this.current && this.current.render) this.current.render(alpha);
    else this.renderer.render();
  }
  destroy(){
    if (this.current && this.current.exit) {
      try { this.current.exit(); } catch (e) { /* ignore */ }
    }
    this.current = null;
    this.currentName = null;
    this.scenes.clear();
  }
}

/* ============================================================
   [14] CameraController
   ============================================================ */
class CameraController {
  constructor(camera, opts){
    this.camera = camera;
    this.yaw = 0;
    this.pitch = 0.2; 
    this.distance = 6; 
    this.followSpeed = opts.followSpeed || 0.2;
    this.target = { x: 0, y: 0, z: 0 };
    this.shakeIntensity = 0;
    this.shakeTimer = 0;
    this.shakeOffset = { x: 0, z: 0 };
  }
  
  follow(x, z){ this.target.x = x; this.target.z = z; }
  
  rotate(dx, dy) {
    this.yaw -= dx * 0.005;
    this.pitch = clamp(this.pitch - dy * 0.005, -0.5, 1.2);
  }

  shake(amount, duration){
    this.shakeIntensity = Math.max(this.shakeIntensity, amount || 0.5);
    this.shakeTimer = Math.max(this.shakeTimer, duration || 0.2);
  }

  update(dt){
    if (this.shakeTimer > 0) {
      const i = this.shakeIntensity * (this.shakeTimer / 0.2);
      this.shakeOffset.x = (Math.random() * 2 - 1) * i;
      this.shakeOffset.z = (Math.random() * 2 - 1) * i;
      this.shakeTimer -= dt;
      if (this.shakeTimer <= 0) { this.shakeOffset.x = 0; this.shakeOffset.z = 0; }
    }

    const ox = this.target.x + this.shakeOffset.x - Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance;
    const oz = this.target.z + this.shakeOffset.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance;
    const oy = this.target.y + 2.0 + Math.sin(this.pitch) * this.distance;

    this.camera.position.x = lerp(this.camera.position.x, ox, this.followSpeed);
    this.camera.position.y = lerp(this.camera.position.y, oy, this.followSpeed);
    this.camera.position.z = lerp(this.camera.position.z, oz, this.followSpeed);
    
    const lookX = this.target.x + Math.sin(this.yaw) * 2;
    const lookY = this.target.y + 1.5;
    const lookZ = this.target.z - Math.cos(this.yaw) * 2;
    this.camera.lookAt(lookX, lookY, lookZ);
  }
}

/* ============================================================
   [15] Body
   ============================================================ */
class Body {
  constructor(opts){
    opts = opts || {};
    this.position = { x: opts.x || 0, y: opts.y || 0, z: opts.z || 0 };
    this.velocity = { x: 0, y: 0, z: 0 };
    this.force    = { x: 0, y: 0, z: 0 };
    this.radius   = opts.radius || 1;
    this.mass     = opts.mass !== undefined ? opts.mass : 1;
    this.invMass  = this.mass > 0 ? 1 / this.mass : 0;
    this.restitution = opts.restitution !== undefined ? opts.restitution : 0.2;
    this.friction = opts.friction !== undefined ? opts.friction : 0.1;
    this.isStatic = !!opts.isStatic;
    this.shape    = opts.shape || 'circle';
    this.halfW    = opts.halfW || 0;
    this.halfD    = opts.halfD || 0;
    this.userData = opts.userData || null;
    this.layer    = opts.layer !== undefined ? opts.layer : 1;
    this.mask     = opts.mask !== undefined ? opts.mask : -1;
    this.ignoreGravity = !!opts.ignoreGravity;
    this.alive = true;
    // 睡眠
    this.allowSleep = opts.allowSleep !== false;
    this.sleeping = false;
    this.sleepTimer = 0;
    this.sleepThreshold = opts.sleepThreshold !== undefined ? opts.sleepThreshold : 0.1;
    this.sleepTime = opts.sleepTime !== undefined ? opts.sleepTime : 0.5;
  }
  applyImpulse(ix, iy, iz){
    if (this.isStatic) return;
    this.velocity.x += ix * this.invMass;
    this.velocity.y += iy * this.invMass;
    this.velocity.z += iz * this.invMass;
    this.wake();
  }
  applyForce(fx, fy, fz){
    if (this.isStatic) return;
    this.force.x += fx;
    this.force.y += fy;
    this.force.z += fz;
    this.wake();
  }
  wake(){
    this.sleeping = false;
    this.sleepTimer = 0;
  }
}

/* ============================================================
   [16] PhysicsWorld
   ============================================================ */
class PhysicsWorld {
  constructor(opts){
    opts = opts || {};
    this.gravity  = opts.gravity || { x: 0, y: -20, z: 0 };
    this.cellSize = opts.cellSize || 8;
    this.substeps = opts.substeps || 1;
    this.bodies        = [];
    this.dynamicBodies = [];
    this.staticBodies  = [];
    this.hash = new SpatialHash(this.cellSize);
    this.onCollision = null;
    this._contactEvents = [];
    this.enableSleep = opts.enableSleep !== false;
  }
  add(body){
    this.bodies.push(body);
    if (body.isStatic) this.staticBodies.push(body);
    else this.dynamicBodies.push(body);
    return body;
  }
  remove(body){
    let i = this.bodies.indexOf(body);
    if (i >= 0) this.bodies.splice(i, 1);
    i = this.dynamicBodies.indexOf(body);
    if (i >= 0) this.dynamicBodies.splice(i, 1);
    i = this.staticBodies.indexOf(body);
    if (i >= 0) this.staticBodies.splice(i, 1);
    this.hash.remove(body);
  }
  clear(){
    this.bodies.length = 0;
    this.dynamicBodies.length = 0;
    this.staticBodies.length = 0;
    this.hash.clear();
    this._contactEvents.length = 0;
  }
  step(dt){
    const sub = Math.max(1, this.substeps);
    const sdt = dt / sub;
    this._contactEvents.length = 0;
    for (let s = 0; s < sub; s++) {
      this._integrate(sdt);
      this._solveCollisions();
      this._postStep();
    }
    if (this.onCollision) {
      for (const ev of this._contactEvents) {
        try { this.onCollision(ev); } catch (e) { console.warn('[Physics] onCollision err', e); }
      }
    }
  }
  _integrate(dt){
    const g = this.gravity;
    for (const b of this.dynamicBodies) {
      if (b.isStatic || !b.alive) continue;
      if (this.enableSleep && b.allowSleep) {
        const speed2 = b.velocity.x ** 2 + b.velocity.z ** 2;
        if (speed2 < b.sleepThreshold ** 2 && !b.sleeping) {
          b.sleepTimer += dt;
          if (b.sleepTimer > b.sleepTime) {
            b.sleeping = true;
            b.velocity.x = 0;
            b.velocity.z = 0;
          }
        } else {
          b.sleepTimer = 0;
        }
      }
      if (b.sleeping) continue;
      if (!b.ignoreGravity) {
        b.velocity.x += (g.x + b.force.x * b.invMass) * dt;
        b.velocity.y += (g.y + b.force.y * b.invMass) * dt;
        b.velocity.z += (g.z + b.force.z * b.invMass) * dt;
      } else {
        b.velocity.x += b.force.x * b.invMass * dt;
        b.velocity.z += b.force.z * b.invMass * dt;
      }
      if (b.friction > 0) {
        const f = Math.max(0, 1 - b.friction * dt);
        b.velocity.x *= f;
        b.velocity.z *= f;
      }
      b.position.x += b.velocity.x * dt;
      b.position.y += b.velocity.y * dt;
      b.position.z += b.velocity.z * dt;
      b.force.x = 0; b.force.y = 0; b.force.z = 0;
    }
  }
  _canCollide(a, b){
    if ((a.mask & b.layer) === 0) return false;
    if ((b.mask & a.layer) === 0) return false;
    return true;
  }
  _solveCollisions(){
    this.hash.clear();
    for (const b of this.dynamicBodies) if (b.alive && !b.sleeping) this.hash.insert(b);
    // 动态-动态
    for (const a of this.dynamicBodies) {
      if (!a.alive || a.isStatic || a.sleeping) continue;
      const neighbors = this.hash.queryCircle(a.position.x, a.position.z, a.radius * 2);
      for (const b of neighbors) {
        if (a === b || b.isStatic || !b.alive) continue;
        if (!this._canCollide(a, b)) continue;
        this._resolveCircleCircle(a, b);
      }
    }
    // 动态-静态
    for (const a of this.dynamicBodies) {
      if (!a.alive || a.isStatic || a.sleeping) continue;
      for (const s of this.staticBodies) {
        if (!s.alive) continue;
        if (!this._canCollide(a, s)) continue;
        if (s.shape === 'aabb') this._resolveCircleAABB(a, s);
        else this._resolveCircleCircle(a, s);
      }
    }
    // 地面
    for (const a of this.dynamicBodies) {
      if (!a.alive || a.isStatic) continue;
      const floor = a.radius;
      if (a.position.y < floor) {
        a.position.y = floor;
        if (a.velocity.y < 0) {
          a.velocity.y = -a.velocity.y * a.restitution;
          if (Math.abs(a.velocity.y) < 0.5) a.velocity.y = 0;
        }
      }
    }
  }
  _resolveCircleCircle(a, b){
    const dx = b.position.x - a.position.x;
    const dz = b.position.z - a.position.z;
    const r  = a.radius + b.radius;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r || d2 < 1e-9) return false;
    const d = Math.sqrt(d2);
    const nx = dx / d, nz = dz / d;
    const overlap = r - d;
    const invA = a.invMass, invB = b.invMass;
    const totalInv = invA + invB;
    if (totalInv <= 0) return true;
    const corr = overlap / totalInv;
    a.position.x -= nx * corr * invA;
    a.position.z -= nz * corr * invA;
    b.position.x += nx * corr * invB;
    b.position.z += nz * corr * invB;
    const vx = b.velocity.x - a.velocity.x;
    const vz = b.velocity.z - a.velocity.z;
    const vn = vx * nx + vz * nz;
    if (vn > 0) return true;
    const e = Math.min(a.restitution, b.restitution);
    const j = -(1 + e) * vn / totalInv;
    a.velocity.x -= j * nx * invA;
    a.velocity.z -= j * nz * invA;
    b.velocity.x += j * nx * invB;
    b.velocity.z += j * nz * invB;
    this._contactEvents.push({
      a, b, normal: { x: nx, z: nz }, depth: overlap, impulse: j,
    });
    return true;
  }
  _resolveCircleAABB(c, box){
    const bx = box.position.x, bz = box.position.z;
    const minX = bx - box.halfW, maxX = bx + box.halfW;
    const minZ = bz - box.halfD, maxZ = bz + box.halfD;
    const cx = clamp(c.position.x, minX, maxX);
    const cz = clamp(c.position.z, minZ, maxZ);
    const dx = c.position.x - cx;
    const dz = c.position.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= c.radius * c.radius) return false;
    if (d2 < 1e-9) {
      const dl = c.position.x - minX;
      const dr = maxX - c.position.x;
      const dt = c.position.z - minZ;
      const db = maxZ - c.position.z;
      const m = Math.min(dl, dr, dt, db);
      if      (m === dl) { c.position.x = minX - c.radius; c.velocity.x = Math.min(0, c.velocity.x); }
      else if (m === dr) { c.position.x = maxX + c.radius; c.velocity.x = Math.max(0, c.velocity.x); }
      else if (m === dt) { c.position.z = minZ - c.radius; c.velocity.z = Math.min(0, c.velocity.z); }
      else               { c.position.z = maxZ + c.radius; c.velocity.z = Math.max(0, c.velocity.z); }
      return true;
    }
    const d = Math.sqrt(d2);
    const nx = dx / d, nz = dz / d;
    const overlap = c.radius - d;
    c.position.x += nx * overlap;
    c.position.z += nz * overlap;
    const vn = c.velocity.x * nx + c.velocity.z * nz;
    if (vn < 0) {
      const e = c.restitution;
      c.velocity.x -= (1 + e) * vn * nx;
      c.velocity.z -= (1 + e) * vn * nz;
    }
    this._contactEvents.push({
      a: c, b: box, normal: { x: nx, z: nz }, depth: overlap, impulse: 0,
    });
    return true;
  }
  _postStep(){
    for (let i = this.dynamicBodies.length - 1; i >= 0; i--) {
      if (!this.dynamicBodies[i].alive) {
        const b = this.dynamicBodies[i];
        this.dynamicBodies.splice(i, 1);
        const bi = this.bodies.indexOf(b);
        if (bi >= 0) this.bodies.splice(bi, 1);
      }
    }
  }
  /* ---- 射线检测 ---- */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, filter){
    const len = Math.hypot(dx, dz) || 1;
    const nx = dx / len, nz = dz / len;
    let closestT = maxDist;
    let closest  = null;
    for (const b of this.bodies) {
      if (!b.alive) continue;
      if (filter && !filter(b)) continue;
      let t;
      if (b.shape === 'aabb') t = this._rayAABB(ox, oz, nx, nz, b, closestT);
      else                    t = this._rayCircle(ox, oz, nx, nz, b, closestT);
      if (t >= 0 && t < closestT) {
        closestT = t;
        closest = { body: b, t, point: { x: ox + nx * t, z: oz + nz * t } };
      }
    }
    return closest;
  }
  _rayCircle(ox, oz, dx, dz, c, maxT){
    const cx = c.position.x - ox;
    const cz = c.position.z - oz;
    const t = cx * dx + cz * dz;
    if (t < 0 || t > maxT) return -1;
    const px = cx - t * dx;
    const pz = cz - t * dz;
    const d2 = px * px + pz * pz;
    const r2 = c.radius * c.radius;
    if (d2 > r2) return -1;
    const thc = Math.sqrt(r2 - d2);
    const t0 = t - thc;
    if (t0 >= 0 && t0 <= maxT) return t0;
    const t1 = t + thc;
    if (t1 >= 0 && t1 <= maxT) return t1;
    return -1;
  }
  _rayAABB(ox, oz, dx, dz, box, maxT){
    const minX = box.position.x - box.halfW, maxX = box.position.x + box.halfW;
    const minZ = box.position.z - box.halfD, maxZ = box.position.z + box.halfD;
    let tmin = 0, tmax = maxT;
    if (Math.abs(dx) < 1e-6) {
      if (ox < minX || ox > maxX) return -1;
    } else {
      let t1 = (minX - ox) / dx;
      let t2 = (maxX - ox) / dx;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
    if (Math.abs(dz) < 1e-6) {
      if (oz < minZ || oz > maxZ) return -1;
    } else {
      let t1 = (minZ - oz) / dz;
      let t2 = (maxZ - oz) / dz;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return -1;
    }
    return tmin;
  }
  get bodyCount(){ return this.bodies.length; }
  get activeCount(){ return this.dynamicBodies.length; }
}

/* ============================================================
   [17] AudioSystem
   ============================================================ */
class AudioSystem {
  constructor(engine){
    this.engine = engine;
    this.ctx = null;
    this.master = null;
    this.bgmGain = null;
    this.sfxGain = null;
    this.voiceGain = null;
    this.enabled = true;
    this._clips = new Map();
    this._currentBGM = null;
    this._volumes = { master: 0.4, bgm: 0.5, sfx: 0.7, voice: 0.8 };
    this._initialized = false;
  }

  async init(){
    if (this._initialized || this.ctx) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this._volumes.master;
      this.master.connect(this.ctx.destination);

      this.bgmGain = this.ctx.createGain();
      this.bgmGain.gain.value = this._volumes.bgm;
      this.bgmGain.connect(this.master);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = this._volumes.sfx;
      this.sfxGain.connect(this.master);

      this.voiceGain = this.ctx.createGain();
      this.voiceGain.gain.value = this._volumes.voice;
      this.voiceGain.connect(this.master);

      this._initialized = true;
    } catch (e) {
      console.warn('[Audio] init fail', e);
      this.enabled = false;
    }
  }

  async resume(){
    if (this.ctx && this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch (e) { /* ignore */ }
    }
  }

  decode(arrayBuffer){
    if (!this.ctx) return Promise.reject(new Error('[Audio] 未初始化'));
    return new Promise((resolve, reject) => {
      this.ctx.decodeAudioData(arrayBuffer, resolve, reject);
    });
  }

  register(name, buffer){
    this._clips.set(name, buffer);
    return this;
  }

  play(name, opts){
    if (!this.enabled || !this.ctx) return null;
    const buffer = this._clips.get(name);
    if (!buffer) {
      console.warn('[Audio] clip not found:', name);
      return null;
    }
    opts = opts || {};
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = !!opts.loop;
      src.playbackRate.value = opts.pitch !== undefined ? clamp(opts.pitch, 0.1, 10) : 1;
      if (opts.detune) src.detune.value = opts.detune;

      const gain = this.ctx.createGain();
      const vol = opts.volume !== undefined ? opts.volume : 1;
      gain.gain.value = vol;

      let destNode = gain;
      if (opts.pan !== undefined && this.ctx.createStereoPanner) {
        const panNode = this.ctx.createStereoPanner();
        panNode.pan.value = clamp(opts.pan, -1, 1);
        gain.connect(panNode);
        destNode = panNode;
      }

      destNode.connect(this.sfxGain);

      const startTime = this.ctx.currentTime + (opts.delay || 0);
      src.start(startTime);
      src.onended = () => {
        try { src.disconnect(); gain.disconnect(); if (destNode !== gain) destNode.disconnect(); }
        catch (e) { /* ignore */ }
      };
      return { src, gain };
    } catch (e) {
      console.warn('[Audio] play err', e);
      return null;
    }
  }

  playBGM(name, opts){
    if (!this.enabled || !this.ctx) return;
    const buffer = this._clips.get(name);
    if (!buffer) {
      console.warn('[Audio] BGM not found:', name);
      return;
    }
    opts = opts || {};
    if (this._currentBGM) {
      this.stopBGM(opts.crossfade !== undefined ? opts.crossfade : 0.5);
    }
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = opts.loop !== false;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.bgmGain);
      src.start(0);
      const fadeIn = opts.fadeIn !== undefined ? opts.fadeIn : 1.0;
      if (fadeIn > 0) {
        const now = this.ctx.currentTime;
        gain.gain.linearRampToValueAtTime(1, now + fadeIn);
      } else {
        gain.gain.value = 1;
      }
      this._currentBGM = { src, gain, name };
    } catch (e) {
      console.warn('[Audio] BGM err', e);
    }
  }

  stopBGM(fadeOut){
    if (!this._currentBGM) return;
    const { src, gain } = this._currentBGM;
    const fade = fadeOut !== undefined ? fadeOut : 0.5;
    try {
      if (fade > 0 && this.ctx) {
        const now = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fade);
        setTimeout(() => {
          try { src.stop(); src.disconnect(); gain.disconnect(); }
          catch (e) { /* ignore */ }
        }, fade * 1000 + 50);
      } else {
        src.stop();
        src.disconnect();
        gain.disconnect();
      }
    } catch (e) { /* ignore */ }
    this._currentBGM = null;
  }

  setVolume(channel, v){
    this._volumes[channel] = clamp(v, 0, 1);
    if (!this.ctx) return;
    const node = { master: this.master, bgm: this.bgmGain, sfx: this.sfxGain, voice: this.voiceGain }[channel];
    if (node) node.gain.value = this._volumes[channel];
  }

  getVolume(channel){ return this._volumes[channel]; }

  mute(){ this.setVolume('master', 0); }
  unmute(){ this.setVolume('master', 0.4); }

  stopAll(){
    this.stopBGM(0);
    if (this.ctx && this.ctx.state === 'running') {
      // 不 suspend，让用户后续操作仍能播放
    }
  }
}

/* ============================================================
   [18] Loader
   ============================================================ */
class Loader {
  constructor(engine){
    this.engine = engine;
    this.cache = new Map();
    this.pending = new Map();
    this._gltfLoader = new GLTFLoader();
    this._textureLoader = new THREE.TextureLoader();
  }

  async loadGLTF(url, onProgress){
    const key = 'gltf:' + url;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      this._gltfLoader.load(
        url,
        gltf => {
          this.cache.set(key, gltf);
          this.pending.delete(key);
          resolve(gltf);
        },
        ev => {
          if (onProgress && ev.total > 0) {
            try { onProgress(ev.loaded / ev.total); } catch (e) { /* ignore */ }
          }
        },
        err => {
          this.pending.delete(key);
          console.error('[Loader] GLTF 加载失败:', url, err);
          reject(err);
        }
      );
    });
    this.pending.set(key, promise);
    return promise;
  }

  async loadTexture(url){
    const key = 'tex:' + url;
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = new Promise((resolve, reject) => {
      this._textureLoader.load(
        url,
        tex => {
          this.cache.set(key, tex);
          this.pending.delete(key);
          resolve(tex);
        },
        undefined,
        err => {
          this.pending.delete(key);
          console.error('[Loader] 贴图加载失败:', url, err);
          reject(err);
        }
      );
    });
    this.pending.set(key, promise);
    return promise;
  }

  async loadJSON(url){
    const key = 'json:' + url;
    if (this.cache.has(key)) return this.cache.get(key);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this.cache.set(key, data);
      return data;
    } catch (e) {
      console.error('[Loader] JSON 加载失败:', url, e);
      throw e;
    }
  }

  async loadAudio(url){
    const key = 'audio:' + url;
    if (this.cache.has(key)) return this.cache.get(key);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const arrayBuffer = await res.arrayBuffer();
      if (this.engine.audio && this.engine.audio.ctx) {
        const audioBuffer = await this.engine.audio.decode(arrayBuffer);
        this.cache.set(key, audioBuffer);
        return audioBuffer;
      }
      // 没有 AudioContext 时返回原始 ArrayBuffer
      this.cache.set(key, arrayBuffer);
      return arrayBuffer;
    } catch (e) {
      console.error('[Loader] 音频加载失败:', url, e);
      throw e;
    }
  }

  async load(url, type){
    switch (type) {
      case 'gltf': case 'glb': return this.loadGLTF(url);
      case 'texture': case 'png': case 'jpg': return this.loadTexture(url);
      case 'audio': case 'mp3': case 'wav': case 'ogg': return this.loadAudio(url);
      case 'json': return this.loadJSON(url);
      default:
        throw new Error('[Loader] 未知类型: ' + type);
    }
  }

  async loadAll(specs, onProgress){
    const results = {};
    const total = specs.length;
    let completed = 0;
    for (const spec of specs) {
      try {
        results[spec.key || spec.url] = await this.load(spec.url, spec.type);
      } catch (e) {
        console.warn('[Loader] loadAll 单项失败:', spec.url, e);
        results[spec.key || spec.url] = null;
      }
      completed++;
      if (onProgress) {
        try { onProgress(completed / total); } catch (e) { /* ignore */ }
      }
    }
    return results;
  }

  get(url, type){
    const prefix = { gltf: 'gltf:', texture: 'tex:', json: 'json:', audio: 'audio:' }[type] || '';
    return this.cache.get(prefix + url);
  }
  has(url, type){
    const prefix = { gltf: 'gltf:', texture: 'tex:', json: 'json:', audio: 'audio:' }[type] || '';
    return this.cache.has(prefix + url);
  }
  clear(){
    for (const [key, value] of this.cache) {
      // 释放贴图
      if (key.startsWith('tex:') && value && value.dispose) {
        try { value.dispose(); } catch (e) { /* ignore */ }
      }
    }
    this.cache.clear();
    this.pending.clear();
  }
}

/* ============================================================
   [19] DevConsole
   ============================================================ */
class DevConsole {
  constructor(engine){
    this.engine = engine;
    this.commands = new Map();
    this.isOpen = false;
    this.history = [];
    this.historyIdx = -1;
    this._bound = false;
    this._registerDefaults();
  }

  _registerDefaults(){
    this.register('help', {
      desc: '显示所有命令',
      usage: 'help [命令名]',
      fn: (args) => {
        if (args[0]) {
          const cmd = this.commands.get(args[0]);
          if (!cmd) return '未知命令：' + args[0];
          return cmd.name + ' — ' + (cmd.desc || '') + '\n用法：' + (cmd.usage || cmd.name);
        }
        const lines = ['可用命令：'];
        const names = [...this.commands.keys()].sort();
        for (const name of names) {
          const cmd = this.commands.get(name);
          lines.push('  ' + name.padEnd(14) + (cmd.desc || ''));
        }
        return lines.join('\n');
      }
    });
    this.register('clear', {
      desc: '清空控制台',
      fn: () => { this._clear(); return ''; }
    });
    this.register('version', {
      desc: '显示引擎版本',
      fn: () => `LaiAsaka Engine v${this.engine.version} · ${this.engine.license}`
    });
    this.register('lang', {
      desc: '切换语言',
      usage: 'lang [code]',
      fn: (args) => {
        if (!args[0]) {
          const langs = this.engine.i18n.getLanguages();
          return '可用语言：' + langs.join(', ') + '\n当前：' + this.engine.currentLanguage;
        }
        const ok = this.engine.setLanguage(args[0]);
        return ok ? `已切换到 ${args[0]}` : `未找到语言 ${args[0]}`;
      }
    });
    this.register('content', {
      desc: '列出已注册内容',
      usage: 'content [表名]',
      fn: (args) => {
        const c = this.engine.content;
        const table = args[0];
        if (!table) {
          const tables = [...c.tables.keys()];
          if (!tables.length) return '内容表为空';
          return '内容表：\n' + tables.map(t => '  ' + t + ' (' + c.count(t) + ')').join('\n');
        }
        const list = c.all(table);
        if (!list.length) return `${table}: 空`;
        return list.map(x => '  ' + x.id + (x.name ? ' — ' + this.engine.i18n.t(x.name) : '')).join('\n');
      }
    });
    this.register('bodies', {
      desc: '显示物理体数量',
      fn: () => {
        const world = this.engine.app && this.engine.app.world;
        if (!world || !world.physics) return '当前无运行中的物理世界';
        const p = world.physics;
        return `bodies=${p.bodyCount}, dynamic=${p.activeCount}, static=${p.bodies.filter(b => b.isStatic).length}`;
      }
    });
    this.register('perf', {
      desc: '切换性能面板',
      fn: () => {
        const pm = this.engine.performance;
        if (!pm) return '性能监控未启用';
        pm.toggle();
        return '性能面板：' + (pm.visible ? '开' : '关');
      }
    });
    this.register('timescale', {
      desc: '设置时间缩放',
      usage: 'timescale <数值>',
      fn: (args) => {
        const s = parseFloat(args[0]);
        if (!isFinite(s)) return '当前时间缩放：' + this.engine.loop.timeScale;
        this.engine.loop.setTimeScale(s);
        return '时间缩放已设为 ' + this.engine.loop.timeScale;
      }
    });
    this.register('pause', {
      desc: '暂停/恢复',
      fn: () => {
        if (this.engine.loop.paused) {
          this.engine.loop.resume();
          return '已恢复';
        } else {
          this.engine.loop.pause();
          return '已暂停';
        }
      }
    });
  }

  register(name, def){
    this.commands.set(name, { name, ...def });
    return this;
  }

  _bind(){
    if (this._bound) return;
    this._bound = true;
    const input = $('dc-input');
    const closeBtn = $('dc-close');
    if (closeBtn) closeBtn.addEventListener('click', () => this.close());
    if (input) {
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          const val = input.value;
          input.value = '';
          if (val.trim()) {
            this.history.push(val);
            if (this.history.length > 100) this.history.shift();
            this.historyIdx = this.history.length;
            this.exec(val);
          }
        } else if (e.key === 'Tab') {
          e.preventDefault();
          this._autocomplete(input);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (this.historyIdx > 0) {
            this.historyIdx--;
            input.value = this.history[this.historyIdx] || '';
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (this.historyIdx < this.history.length - 1) {
            this.historyIdx++;
            input.value = this.history[this.historyIdx] || '';
          } else {
            this.historyIdx = this.history.length;
            input.value = '';
          }
        }
      });
    }
    window.addEventListener('keydown', (e) => {
      if (e.key === '`' || e.key === '~') {
        const tag = e.target && e.target.tagName ? e.target.tagName.toUpperCase() : '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        e.preventDefault();
        this.toggle();
      } else if (e.key === 'Escape' && this.isOpen) {
        e.preventDefault();
        this.close();
      }
    });
  }

  _autocomplete(input){
    const val = input.value;
    const parts = val.split(/\s+/);
    const cmd = parts[0];
    if (!cmd) return;
    // 唯一候选
    const matches = [...this.commands.keys()].filter(k => k.startsWith(cmd));
    if (matches.length === 1) {
      input.value = matches[0] + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
    } else if (matches.length > 1) {
      this.log(matches.join('  '));
    }
  }

  toggle(){ if (this.isOpen) this.close(); else this.open(); }
  open(){
    const el = $('dev-console');
    if (!el) return;
    el.classList.add('on');
    this.isOpen = true;
    const input = $('dc-input');
    if (input) setTimeout(() => input.focus(), 30);
  }
  close(){
    const el = $('dev-console');
    if (!el) return;
    el.classList.remove('on');
    this.isOpen = false;
  }

  log(text, cls){
    const out = $('dc-out');
    if (!out) return;
    const line = document.createElement('div');
    line.className = 'line ' + (cls || '');
    line.textContent = text;
    out.appendChild(line);
    out.scrollTop = out.scrollHeight;
    while (out.children.length > 400) out.removeChild(out.firstChild);
  }

  _clear(){
    const out = $('dc-out');
    if (out) out.innerHTML = '';
  }

  exec(raw){
    const str = (raw || '').trim();
    if (!str) return;
    this.log('› ' + str, 'cmd');
    const parts = str.split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);
    const cmd = this.commands.get(name);
    if (!cmd) {
      this.log('未知命令：' + name + '（输入 help 查看）', 'err');
      return;
    }
    try {
      const result = cmd.fn(args);
      if (typeof result === 'string' && result.length) this.log(result);
    } catch (e) {
      this.log('错误：' + (e && e.message ? e.message : String(e)), 'err');
    }
  }
}

/* ============================================================
   [20] ModeRegistry
   ============================================================ */
class ModeRegistry {
  constructor(){ this.modes = new Map(); }
  register(id, spec){
    if (this.modes.has(id)) console.warn('[Mode] 重复注册:', id);
    this.modes.set(id, Object.freeze({ id, ...spec }));
    return this;
  }
  get(id){ return this.modes.get(id); }
  has(id){ return this.modes.has(id); }
  all(){ return Array.from(this.modes.values()); }
  ids(){ return Array.from(this.modes.keys()); }
}

/* ============================================================
   [20.5] ProfileSystem · 玩法预设与难度评估
   ------------------------------------------------------------
   玩家通过 profile 控制"仿真 ↔ 游戏性"平衡。
   每个 profile 是一组扁平配置键值对，例如：
     hud.hpBar: true
     combat.limbDamage: false
     skills.enabled: true

   引擎提供：
     registerProfiles(data)  注册预设表（content.js 调用）
     setProfile(id)          应用预设
     set(key, value)         自定义单键
     get(key, defaultValue)  读取
     assess()                返回实时难度评分
     onChange(fn)            配置变化回调
   ============================================================ */
class ProfileSystem {
  constructor(engine){
    this.engine = engine;
    this.profiles = new Map();
    this.current = {};
    this.currentProfileId = null;
    this.custom = false;
    this._listeners = new Set();

    // 辅助项权重（开启 = 游戏变简单）
    this.auxWeights = {
      'hud.hpBar': 1.5,
      'hud.cpBar': 1.0,
      'hud.ammoCounter': 1.0,
      'hud.taskList': 0.5,
      'visual.damageNumbers': 1.5,
      'visual.hitMarkers': 1.0,
      'visual.minimap': 2.0,
      'visual.enemyOutline': 2.5,
      'visual.extractGuide': 1.5,
      'skills.enabled': 3.0,
      'skills.cooldownReduction': 2.0,
    };
    // 仿真项权重（开启 = 游戏变难）
    this.realismWeights = {
      'combat.limbDamage': 2.0,
      'combat.armorLayerBreak': 2.0,
      'combat.bulletDrop': 2.5,
      'combat.headshotInstantKill': 1.5,
      'combat.realisticRecoil': 2.0,
      'combat.realisticReload': 1.0,
      'combat.friendlyFire': 1.5,
    };
  }

  registerProfiles(profilesData){
    if (!profilesData) return;
    for (const [id, p] of Object.entries(profilesData)) {
      this.profiles.set(id, p);
    }
  }

  list(){ return Array.from(this.profiles.values()); }
  has(id){ return this.profiles.has(id); }

  setProfile(id){
    const p = this.profiles.get(id);
    if (!p) { console.warn('[Profile] 未找到预设:', id); return false; }
    this.currentProfileId = id;
    this.custom = false;
    this.current = {};
    this._flatten(p.config || {}, '', this.current);
    this._notify();
    return true;
  }

  set(key, value){
    this.current[key] = value;
    this.custom = true;
    this._notify();
  }

  get(key, defaultValue){
    if (key in this.current) return this.current[key];
    return defaultValue;
  }

  _flatten(obj, prefix, out){
    for (const k in obj) {
      const fullKey = prefix ? prefix + '.' + k : k;
      const v = obj[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        this._flatten(v, fullKey, out);
      } else {
        out[fullKey] = v;
      }
    }
  }

  /* 实时难度评估 */
  assess(){
    let auxSum = 0, auxMax = 0;
    for (const [key, w] of Object.entries(this.auxWeights)) {
      auxMax += w;
      if (this.get(key, false) === true) auxSum += w;
    }
    let realismSum = 0, realismMax = 0;
    for (const [key, w] of Object.entries(this.realismWeights)) {
      realismMax += w;
      if (this.get(key, false) === true) realismSum += w;
    }
    const auxRatio = auxMax > 0 ? auxSum / auxMax : 0;
    const realismRatio = realismMax > 0 ? realismSum / realismMax : 0;
    const raw = realismRatio - auxRatio;
    const score = clamp(0.5 + raw * 0.4, 0.05, 0.95);

    let tier, label, rewardMul;
    if      (score < 0.20) { tier = 'casual';     label = 'profile.tier.casual';     rewardMul = 0.5; }
    else if (score < 0.40) { tier = 'normal';     label = 'profile.tier.normal';     rewardMul = 0.75; }
    else if (score < 0.60) { tier = 'tactical';   label = 'profile.tier.tactical';   rewardMul = 1.0; }
    else if (score < 0.80) { tier = 'hardcore';   label = 'profile.tier.hardcore';   rewardMul = 1.5; }
    else                   { tier = 'simulation'; label = 'profile.tier.simulation'; rewardMul = 2.0; }

    return {
      score: Math.round(score * 100) / 100,
      tier, label, rewardMul,
      profileId: this.custom ? 'custom' : this.currentProfileId,
      auxRatio, realismRatio,
    };
  }

  onChange(fn){
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _notify(){
    const assessment = this.assess();
    for (const fn of this._listeners) {
      try { fn(assessment); } catch (e) { console.warn('[Profile] listener err', e); }
    }
  }
}

/* ============================================================
   [21] Engine · 总装
   ============================================================ */

const BUILTIN_LOCALE_ZH = {
  'engine.title': 'LaiAsaka',
  'engine.subtitle': 'ENGINE',
  'engine.copyright': '© 2026 <b>ZpycuA</b> · Licensed under <b>CC BY-NC 4.0</b>',
  'ui.boot.loading': '正在初始化引擎…',
  'ui.menu.title': 'Asaka Straight Project',
  'ui.menu.subtitle': 'LaiAsaka Engine',
  'ui.menu.start': '进 入 战 区',
  'ui.menu.train': '训 练 场',
  'ui.game.task_title': '📋 任务',
  'ui.game.hp': '生命',
  'ui.game.cp': '耦合',
  'ui.game.protect_l1': '冷兵器',
  'ui.game.protect_l2': '+热兵器',
  'ui.game.protect_l3': '全防护',
  'ui.game.extract_progress': '撤 离 中',
  'ui.pause.title': '暂 停',
  'ui.pause.resume': '继续',
  'ui.pause.quit': '放弃并返回',
  'ui.result.extract_success': '撤 离 成 功',
  'ui.result.operation_failed': '作 战 失 败',
  'ui.result.again': '再来一次',
  'ui.result.menu': '返回菜单',
  'ui.console.title': 'DEV CONSOLE · 输入 help 查看命令',
  'ui.console.placeholder': 'help',
};

class Engine {
  constructor(){
    this.name    = 'LaiAsaka';
    this.version = '3.0.0';
    this.author  = 'ZpycuA';
    this.license = 'CC BY-NC 4.0';

    // 子系统（无依赖，构造函数里直接创建）
    this.bus          = new EventBus();
    this.input        = new InputSystem();
    this.i18n         = new I18nSystem();
    this.content      = new ContentRegistry();
    this.save         = new SaveSystem('LaiAsaka_Save_v3');
    this.meshes       = new MeshFactory();
    this.modeRegistry = new ModeRegistry();
    this.profile      = new ProfileSystem(this);
    this.devConsole   = new DevConsole(this);
    this.loader       = new Loader(this);
    this.audio        = new AudioSystem(this);
    this.performance  = new PerformanceMonitor();

    // 延迟创建（需要 canvas / 依赖注入）
    this.renderer   = null;
    this.scenes     = null;
    this.loop       = null;
    this.cameraCtl  = null;
    this.app        = null;

    this.currentLanguage = 'zh-CN';
    this._initialized = false;
    this._destroyed = false;
  }

  async init({ canvas, locale, defaultLocale }){
    if (this._initialized) {
      console.warn('[Engine] 重复 init 调用被忽略');
      return this;
    }
    if (!canvas) {
      throw new Error('[Engine] init 需要 canvas 参数');
    }

    // ---- 1. 语言 ----
    const loadedLocales = locale || {};
    for (const [code, table] of Object.entries(loadedLocales)) {
      this.i18n.register(code, table);
    }
    if (!this.i18n.getLanguages().length) {
      this.i18n.register('zh-CN', BUILTIN_LOCALE_ZH);
    }
    const defCode = defaultLocale ||
      (this.i18n.hasLanguage('zh-CN') ? 'zh-CN' : this.i18n.getLanguages()[0]);
    this.i18n.setFallback(this.i18n.tables.get(defCode) || BUILTIN_LOCALE_ZH);
    this.i18n.setLanguage(defCode);
    this.currentLanguage = defCode;
    this.i18n.applyToDOM(document);

    // ---- 2. 输入 ----
    this.input.attach(canvas);

    // ---- 3. 渲染 ----
    this.renderer = new Renderer3D(canvas);
    this.scenes   = new SceneManager(this.renderer);
    this.cameraCtl = new CameraController(this.renderer.camera, { followSpeed: 0.15 });

    // ---- 4. 主循环 ----
    this.loop = new FixedLoop({
      step: 1/60,
      maxSteps: 4,
      onStep: (dt) => {
        const stepStart = performance.now();
        if (this.scenes) this.scenes.update(dt);
        if (this.app && this.app.world && this.app.world.running &&
            typeof this.app.world.update === 'function') {
          try { this.app.world.update(dt); }
          catch (e) { console.error('[Engine] world.update err:', e); }
        }
        if (this.cameraCtl) this.cameraCtl.update(dt);
        this.bus.emit('step', dt);
        this.performance.recordStep(performance.now() - stepStart);
      },
      onRender: (alpha) => {
        const renderStart = performance.now();
        if (this.scenes) this.scenes.render(alpha);
        else if (this.renderer) this.renderer.render();
        this.performance.recordRender(performance.now() - renderStart, this.renderer?.drawCalls || 0);
        this.bus.emit('render', alpha);
      },
      onFrame: (frameTime) => {
        this.performance.recordFrame(frameTime);
        this.performance.update();
      }
    });

    // ---- 5. 控制台 ----
    this.devConsole._bind();

    // ---- 6. 输入动作 ----
    this.input.registerAction('fire',   { mouse: 'left' });
    this.input.registerAction('reload', { keys: ['r'] });
    this.input.registerAction('pause',  { keys: ['escape'] });
    this.input.registerAction('switchWeapon', { keys: ['f'] });

    // ---- 7. 音频（延迟到首次交互） ----
    const initAudioOnce = () => {
      this.audio.init();
      window.removeEventListener('pointerdown', initAudioOnce);
      window.removeEventListener('keydown', initAudioOnce);
    };
    window.addEventListener('pointerdown', initAudioOnce, { once: true });
    window.addEventListener('keydown', initAudioOnce, { once: true });

    // ---- 8. 语言切换回调 ----
    this.i18n.onLanguageChange((code) => {
      this.currentLanguage = code;
      this.bus.emit('languageChanged', code);
    });

    this._initialized = true;
    return this;
  }

  /* --- 物理工厂 --- */
  physicsFactory(opts){
    return new PhysicsWorld(Object.assign({
      gravity: { x: 0, y: -20, z: 0 },
      cellSize: 8,
      substeps: 1,
      enableSleep: true,
    }, opts || {}));
  }

  /* --- 主循环控制 --- */
  start(){
    if (!this.loop) { console.warn('[Engine] 未初始化，不能 start()'); return; }
    this.loop.start();
    this.bus.emit('engineStarted');
  }
  stop(){
    if (this.loop) this.loop.stop();
    this.bus.emit('engineStopped');
  }
  pause(){ if (this.loop) this.loop.pause(); }
  resume(){ if (this.loop) this.loop.resume(); }
  setTimeScale(s){ if (this.loop) this.loop.setTimeScale(s); }

  /* --- 语言 --- */
  setLanguage(code){
    if (!this.i18n.hasLanguage(code)) {
      console.warn('[Engine] 未加载语言:', code);
      return false;
    }
    const ok = this.i18n.setLanguage(code);
    if (ok) {
      this.i18n.applyToDOM(document);
    }
    return ok;
  }

  /* --- 事件转发 --- */
  on(name, fn){ return this.bus.on(name, fn); }
  once(name, fn){ return this.bus.once(name, fn); }
  off(name, fn){ this.bus.off(name, fn); }
  emit(name, payload){ this.bus.emit(name, payload); }

  /* --- 存档 --- */
  saveGame(data){
    if (data) this.save.data = data;
    return this.save.save();
  }
  loadGame(defaults){
    return this.save.load(defaults);
  }

  /* --- 内容快捷方法 --- */
  getContent(table, id){ return this.content.get(table, id); }
  allContent(table){ return this.content.all(table); }

  /* --- 销毁 --- */
  destroy(){
    if (this._destroyed) return;
    this._destroyed = true;
    this.stop();
    if (this.app && this.app.world && this.app.world.destroy) {
      try { this.app.world.destroy(); } catch (e) { /* ignore */ }
    }
    if (this.scenes) this.scenes.destroy();
    if (this.renderer) this.renderer.dispose();
    if (this.audio) this.audio.stopAll();
    this.bus.clear();
    this.content.clear();
    this.loader.clear();
    this._initialized = false;
  }
}

/* ============================================================
   [22] 导出
   ============================================================ */
export {
  Engine,
  EventBus,
  ObjectPool,
  SpatialHash,
  FixedLoop,
  I18nSystem,
  ContentRegistry,
  SaveSystem,
  InputSystem,
  VirtualJoystick,
  PerformanceMonitor,
  Renderer3D,
  MeshFactory,
  SceneManager,
  CameraController,
  Body,
  PhysicsWorld,
  AudioSystem,
  Loader,
  DevConsole,
  ModeRegistry,
  ProfileSystem,
  Utils,
};
