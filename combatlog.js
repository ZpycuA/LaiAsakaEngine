/* ============================================================
   LaiAsaka Engine · CombatLog
   v1.0.0 · © 2026 ZpycuA · CC BY-NC 4.0
   ------------------------------------------------------------
   可扩展战斗日志。任何系统只需：
     world.combatLog.push({ type: 'xxx', t, ...data })
   并注册一个渲染函数即可自动出现在死亡记录中。

   已有内置类型：
     shot_fired, damage_dealt, damage_taken, kill, downed, revived,
     search, loot, skill_use, nade_throw, coupling_hit, armor_hit, extract
   未注册的类型会以【未注册类型】兜底渲染，不丢数据。
   ============================================================ */

const PART_NAMES = {
  face: '面部', head: '头部', thorax: '胸部', abdomen: '腹部',
  larm: '左臂', rarm: '右臂', lleg: '左腿', rleg: '右腿',
};

export const FILTER_GROUPS = {
  all: () => true,
  dealt: e => e.type === 'damage_dealt' || e.type === 'kill' || e.type === 'shot_fired',
  taken: e => e.type === 'damage_taken' || e.type === 'downed' || e.type === 'revived' || e.type === 'coupling_hit',
  items: e => e.type === 'loot' || e.type === 'search' || e.type === 'extract',
  skills: e => e.type === 'skill_use' || e.type === 'nade_throw',
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtNum(n, d) {
  if (n == null || !isFinite(n)) return '0';
  const r = Math.round(n * Math.pow(10, d || 0)) / Math.pow(10, d || 0);
  return String(r);
}
function fmtTime(t) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

let _stylesInjected = false;
function _injectStyles() {
  if (_stylesInjected || typeof document === 'undefined') return;
  _stylesInjected = true;
  const css = `
  #combat-report-overlay {
    position: fixed; inset: 0; z-index: 400;
    background: rgba(4,8,14,0.96);
    display: none; flex-direction: column;
    padding: 14px; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  #combat-report-overlay.on { display: flex; }
  #combat-report-overlay .cr-head {
    display: flex; justify-content: space-between; align-items: center;
    padding-bottom: 10px; border-bottom: 1px solid rgba(120,180,240,0.25);
  }
  #combat-report-overlay .cr-title {
    font-size: 18px; letter-spacing: 6px; font-weight: 800;
    color: #a8d8ff;
  }
  #combat-report-overlay .cr-title.fail { color: #ff6b6b; }
  #combat-report-overlay .cr-title.success { color: #7fe8b0; }
  #combat-report-overlay .cr-sub {
    font-size: 11px; color: #7fa0bc; margin-top: 4px; letter-spacing: 1px;
  }
  #combat-report-overlay .cr-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(90px, 1fr));
    gap: 6px; margin: 10px 0 8px;
  }
  #combat-report-overlay .cr-stat {
    background: linear-gradient(180deg, rgba(30,50,75,0.7), rgba(15,28,45,0.85));
    border: 1px solid rgba(100,170,240,0.3);
    border-radius: 6px; padding: 6px 8px;
  }
  #combat-report-overlay .cr-stat .k {
    font-size: 9px; color: #5c82a8; letter-spacing: 1px; margin-bottom: 2px;
  }
  #combat-report-overlay .cr-stat .v {
    font-size: 15px; color: #ffe08a; font-weight: 700;
    font-family: ui-monospace, Consolas, monospace;
  }
  #combat-report-overlay .cr-stat .v.green { color: #7fe8b0; }
  #combat-report-overlay .cr-stat .v.red { color: #ff8b7b; }
  #combat-report-overlay .cr-filter {
    display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 8px;
  }
  #combat-report-overlay .cr-filter button {
    padding: 5px 12px; font-size: 11px; cursor: pointer;
    background: rgba(20,32,46,0.8); color: #8fb0c8;
    border: 1px solid rgba(80,125,175,0.25); border-radius: 4px;
    font-family: inherit; touch-action: manipulation;
  }
  #combat-report-overlay .cr-filter button.on {
    background: rgba(60,120,185,0.55); color: #e8f4ff;
    border-color: rgba(120,190,255,0.55);
  }
  #combat-report-overlay .cr-scroll {
    flex: 1; min-height: 0; overflow-y: auto;
    background: rgba(8,14,24,0.6);
    border: 1px solid rgba(80,125,175,0.2);
    border-radius: 6px; padding: 6px;
    -webkit-overflow-scrolling: touch;
  }
  #combat-report-overlay .cr-scroll::-webkit-scrollbar { width: 8px; }
  #combat-report-overlay .cr-scroll::-webkit-scrollbar-track { background: rgba(0,0,0,0.25); }
  #combat-report-overlay .cr-scroll::-webkit-scrollbar-thumb {
    background: rgba(100,170,240,0.5); border-radius: 4px;
  }
  #combat-report-overlay .cr-entry {
    padding: 6px 9px; margin-bottom: 4px;
    border-radius: 4px; font-size: 11.5px; line-height: 1.5;
    border-left: 3px solid transparent;
  }
  #combat-report-overlay .cr-entry .cr-head-line {
    display: flex; justify-content: space-between; align-items: baseline;
    color: #cfe4f8; font-weight: 600;
  }
  #combat-report-overlay .cr-entry .cr-time {
    font-size: 10px; color: #5c82a8; font-family: ui-monospace, monospace;
    font-weight: 400;
  }
  #combat-report-overlay .cr-entry .cr-body {
    font-size: 10.5px; color: #8fb0cc; margin-top: 2px;
  }
  #combat-report-overlay .cr-entry .cr-body b { color: #e0f0ff; }

  #combat-report-overlay .cr-entry.cl-out     { background: rgba(30,70,45,0.35);  border-left-color: #5fd47a; }
  #combat-report-overlay .cr-entry.cl-in      { background: rgba(80,25,25,0.35);  border-left-color: #ff5a5a; }
  #combat-report-overlay .cr-entry.cl-kill    { background: rgba(120,40,20,0.45); border-left-color: #ff9040; }
  #combat-report-overlay .cr-entry.cl-down    { background: rgba(120,10,10,0.5);  border-left-color: #ff3030; }
  #combat-report-overlay .cr-entry.cl-revive  { background: rgba(20,80,60,0.4);   border-left-color: #5ff0b0; }
  #combat-report-overlay .cr-entry.cl-armor   { background: rgba(30,55,80,0.4);   border-left-color: #6fb8e0; }
  #combat-report-overlay .cr-entry.cl-coupling{ background: rgba(70,40,110,0.4);  border-left-color: #c878ff; }
  #combat-report-overlay .cr-entry.cl-loot    { background: rgba(80,65,15,0.4);   border-left-color: #ffd93d; }
  #combat-report-overlay .cr-entry.cl-skill   { background: rgba(60,40,110,0.4);  border-left-color: #a888ff; }
  #combat-report-overlay .cr-entry.cl-nade    { background: rgba(90,45,10,0.4);   border-left-color: #ff9a3c; }
  #combat-report-overlay .cr-entry.cl-shot    { background: rgba(20,25,35,0.5);   border-left-color: #6a8ca8; }
  #combat-report-overlay .cr-entry.cl-extract { background: rgba(20,60,90,0.4);   border-left-color: #5fd4ff; }
  #combat-report-overlay .cr-entry.cl-unknown { background: rgba(50,50,50,0.4);   border-left-color: #888; }

  #combat-report-overlay .cr-actions {
    display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px;
    flex-wrap: wrap;
  }
  #combat-report-overlay .cr-actions button {
    padding: 10px 22px; font-size: 13px; cursor: pointer;
    background: rgba(40,80,130,0.7);
    border: 1px solid rgba(110,180,255,0.5);
    color: #cfe8ff; border-radius: 8px;
    font-family: inherit; letter-spacing: 2px;
    touch-action: manipulation;
  }
  #combat-report-overlay .cr-actions button.primary {
    background: linear-gradient(180deg, rgba(60,140,90,0.75), rgba(30,80,55,0.85));
    border-color: rgba(120,220,160,0.6); color: #e0ffe8;
  }
  #combat-report-overlay .cr-actions button:active { transform: scale(0.97); }
  #combat-report-overlay .cr-empty {
    text-align: center; color: #5c82a8; padding: 40px 20px; font-size: 12px;
  }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
}

export class CombatLog {
  constructor(opts = {}) {
    this.entries = [];
    this.maxEntries = opts.maxEntries || 5000;
    this.startedAt = 0;
    this.endedAt = 0;
    this.renderers = new Map();
    this._seq = 0;
    this._registerDefaults();
  }

  start(t = 0) {
    this.entries.length = 0;
    this.startedAt = t;
    this.endedAt = 0;
    this._seq = 0;
  }

  end(t) {
    this.endedAt = t;
  }

  push(entry) {
    if (!entry || !entry.type) return null;
    entry._seq = this._seq++;
    if (entry.t === undefined) entry.t = 0;
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) this.entries.shift();
    return entry;
  }

  register(type, renderer) {
    if (typeof renderer !== 'function') return this;
    this.renderers.set(type, renderer);
    return this;
  }

  has(type) { return this.renderers.has(type); }

  byType(type) {
    return this.entries.filter(e => e.type === type);
  }

  summary() {
    const s = {
      totalEntries: this.entries.length,
      kills: 0, bossKills: 0, headshots: 0,
      damageDealt: 0, damageTaken: 0,
      shots: 0, hits: 0,
      armorAbsorbed: 0, armorWear: 0, armorBreaks: 0,
      couplingAbsorbed: 0, couplingCost: 0,
      containersSearched: 0, lootValue: 0, lootCount: 0,
      skillsUsed: 0, nadesThrown: 0,
      downedCount: 0, revivedCount: 0,
      duration: Math.max(0, this.endedAt - this.startedAt),
    };
    for (const e of this.entries) {
      switch (e.type) {
        case 'kill':
          s.kills++;
          if (e.target && e.target.isBoss) s.bossKills++;
          break;
        case 'damage_dealt':
          s.damageDealt += e.amount || 0;
          s.hits++;
          if (e.headshot) s.headshots++;
          if (e.armor) {
            s.armorAbsorbed += e.armor.absorbed || 0;
            s.armorWear += e.armor.wear || 0;
            if (e.armor.broke) s.armorBreaks++;
          }
          break;
        case 'damage_taken':
          s.damageTaken += e.amount || 0;
          if (e.armor) {
            s.armorAbsorbed += e.armor.absorbed || 0;
            s.armorWear += e.armor.wear || 0;
            if (e.armor.broke) s.armorBreaks++;
          }
          if (e.coupling && e.coupling.absorbed > 0) {
            s.couplingAbsorbed += e.coupling.absorbed;
            s.couplingCost += e.coupling.cost || 0;
          }
          break;
        case 'shot_fired': s.shots++; break;
        case 'search': s.containersSearched++; break;
        case 'loot':
          s.lootValue += e.value || 0;
          s.lootCount++;
          break;
        case 'skill_use': s.skillsUsed++; break;
        case 'nade_throw': s.nadesThrown++; break;
        case 'downed': s.downedCount++; break;
        case 'revived': s.revivedCount++; break;
      }
    }
    return s;
  }

  _registerDefaults() {
    /* ---- 造成伤害 ---- */
    this.register('damage_dealt', e => {
      const tgt = e.target ? (e.target.name || '?') : '?';
      const part = PART_NAMES[e.part] || e.part || '?';
      const wpn = e.weapon ? (e.weapon.name || '—') : '—';
      const hp = `${fmtNum(e.targetHpAfter)}/${fmtNum(e.targetMaxHp)}`;
      let armor = '';
      if (e.armor && e.armor.absorbed > 0) {
        armor = ` · 甲 Lv${e.armor.lv} 吸收 ${fmtNum(e.armor.absorbed)}J（-${fmtNum(e.armor.wear, 1)}%）`;
        if (e.armor.broke) armor += ' <span style="color:#ff5a5a">[破损]</span>';
      } else if (e.pierced) {
        armor = ' · <span style="color:#ff44aa">穿甲</span>';
      }
      const hsTag = e.headshot ? ' · <span style="color:#ffdd44">爆头</span>' : '';
      return {
        cls: 'out',
        head: `→ 命中 ${esc(tgt)}`,
        body: `${esc(wpn)} · ${part} · 伤害 <b>${fmtNum(e.amount)}</b>${armor}${hsTag}<br>敌方 HP ${hp}`,
      };
    });

    /* ---- 承受伤害 ---- */
    this.register('damage_taken', e => {
      const src = e.source ? (e.source.name || '未知') : '未知';
      const part = PART_NAMES[e.part] || e.part || '?';
      let armor = '';
      if (e.armor && e.armor.absorbed > 0) {
        armor = ` · ${e.armor.layer || '甲'} Lv${e.armor.lv} 吸收 ${fmtNum(e.armor.absorbed)}J（-${fmtNum(e.armor.wear, 1)}%）`;
        if (e.armor.broke) armor += ' <span style="color:#ff5a5a">[破损]</span>';
      }
      let coupling = '';
      if (e.coupling && e.coupling.absorbed > 0) {
        coupling = `<br>耦合 ${e.coupling.level || '?'} 吸收 ${fmtNum(e.coupling.absorbed)}J · 消耗 ${fmtNum(e.coupling.cost, 1)} 点`;
      }
      const hp = `${fmtNum(e.hpAfter)}/${fmtNum(e.maxHp)}`;
      const bleed = e.bleeding ? ' · <span style="color:#ff5a5a">流血</span>' : '';
      return {
        cls: 'in',
        head: `← 受到 ${esc(src)} 攻击`,
        body: `${part} · 伤害 <b>${fmtNum(e.amount)}</b>${armor}${coupling}<br>HP ${hp}${bleed}`,
      };
    });

    /* ---- 击杀 ---- */
    this.register('kill', e => {
      const tgt = e.target ? (e.target.name || '?') : '?';
      const tag = e.target && e.target.isBoss ? '👑 ' : (e.target && e.target.isElite ? '★ ' : '');
      const dist = e.distance !== undefined ? `距离 ${Math.round(e.distance)}m · ` : '';
      return {
        cls: 'kill',
        head: `☠ 击杀 ${tag}${esc(tgt)}`,
        body: `${dist}累计造成 ${fmtNum(e.damageContributed)} 伤害`,
      };
    });

    /* ---- 开火（仅用于统计，默认折叠可关闭） ---- */
    this.register('shot_fired', e => ({
      cls: 'shot',
      head: `🔫 开火`,
      body: `${esc(e.weapon || '—')}${e.pellets > 1 ? ' · ' + e.pellets + ' 弹丸' : ''} · ${fmtNum(e.energy)}J`,
    }));

    /* ---- 护甲独立事件（可选，用于护甲系统单独上报） ---- */
    this.register('armor_hit', e => ({
      cls: 'armor',
      head: `🛡 ${e.side === 'out' ? '敌方' : '我方'}护甲 ${esc(e.item || '—')} Lv${e.lv}`,
      body: `吸收 ${fmtNum(e.absorbed)}J · 耐久 -${fmtNum(e.wear, 1)}%${e.broke ? ' <span style="color:#ff5a5a">[破损]</span>' : ''}`,
    }));

    /* ---- 耦合独立事件 ---- */
    this.register('coupling_hit', e => ({
      cls: 'coupling',
      head: `⚡ 耦合防护 ${e.level || '?'}`,
      body: `吸收 ${fmtNum(e.absorbed)}J · 消耗 ${fmtNum(e.cost, 1)} 点（剩余 ${fmtNum(e.after)}/${fmtNum(e.max)}）`,
    }));

    /* ---- 搜索 / 拾取 ---- */
    this.register('search', e => ({
      cls: 'loot',
      head: `📦 搜索${e.isCorpse ? '尸体' : '容器'}`,
      body: esc(e.containerType || ''),
    }));

    this.register('loot', e => ({
      cls: 'loot',
      head: `💎 拾取 ${esc(e.name || '?')}`,
      body: `价值 ${fmtNum(e.value)} cp${e.qty > 1 ? ` ×${e.qty}` : ''}`,
    }));

    /* ---- 技能 / 投掷 ---- */
    this.register('skill_use', e => ({
      cls: 'skill',
      head: `✦ 技能 · ${esc(e.name || '?')}`,
      body: e.detail || '',
    }));

    this.register('nade_throw', e => ({
      cls: 'nade',
      head: `💣 投掷 ${esc(e.name || '?')}`,
      body: e.distance !== undefined ? `距离 ${Math.round(e.distance)}m` : '',
    }));

    /* ---- 状态 ---- */
    this.register('downed', e => ({
      cls: 'down',
      head: `💀 倒地`,
      body: `HP ${fmtNum(e.hp)}/${fmtNum(e.maxHp)}`,
    }));

    this.register('revived', e => ({
      cls: 'revive',
      head: `✚ 救起`,
      body: `HP ${fmtNum(e.hp)}/${fmtNum(e.maxHp)}`,
    }));

    this.register('extract', e => ({
      cls: 'extract',
      head: `🚁 撤离开始`,
      body: `位置 ${esc(e.pointName || '?')}`,
    }));
  }

  /**
   * 渲染战斗记录到指定容器。
   * @param {HTMLElement} container 滚动容器
   * @param {Object} opts
   *   filter: (entry) => boolean  条目过滤
   */
  render(container, opts = {}) {
    if (!container) return;
    const filter = opts.filter || (() => true);
    const entries = this.entries.filter(filter);
    if (!entries.length) {
      container.innerHTML = '<div class="cr-empty">无战斗记录</div>';
      return;
    }
    let html = '';
    /* 从最新到最旧 */
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      const r = this.renderers.get(e.type);
      if (!r) {
        html += `<div class="cr-entry cl-unknown">` +
          `<div class="cr-head-line"><span>[${esc(e.type)}]</span><span class="cr-time">${fmtTime(e.t)}</span></div>` +
          `</div>`;
        continue;
      }
      let d;
      try { d = r(e) || {}; }
      catch (err) { d = { cls: 'unknown', head: `[渲染错误 ${esc(e.type)}]`, body: '' }; }
      html += `<div class="cr-entry cl-${d.cls || 'unknown'}">` +
        `<div class="cr-head-line"><span>${d.head || ''}</span><span class="cr-time">${fmtTime(e.t)}</span></div>` +
        (d.body ? `<div class="cr-body">${d.body}</div>` : '') +
        `</div>`;
    }
    container.innerHTML = html;
  }
}

/**
 * 生成战斗记录 overlay（单次创建，后续复用）。
 * @param {Object} opts
 *   title, sub, summary (来自 summary()), log (CombatLog 实例), buttons: [{ label, primary, onClick }]
 */
export function showCombatReport(opts) {
  _injectStyles();
  const { title, sub, summary, log, buttons = [] } = opts || {};

  let overlay = document.getElementById('combat-report-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'combat-report-overlay';
    document.body.appendChild(overlay);
  }
  overlay.classList.add('on');

  const titleCls = (opts && opts.titleClass) || '';
  const summaryHtml = summary ? `
    <div class="cr-summary">
      <div class="cr-stat"><div class="k">击杀</div><div class="v">${summary.kills || 0}</div></div>
      <div class="cr-stat"><div class="k">爆头</div><div class="v">${summary.headshots || 0}</div></div>
      <div class="cr-stat"><div class="k">造成伤害</div><div class="v">${fmtNum(summary.damageDealt)}</div></div>
      <div class="cr-stat"><div class="k">承受伤害</div><div class="v red">${fmtNum(summary.damageTaken)}</div></div>
      <div class="cr-stat"><div class="k">护甲吸收</div><div class="v green">${fmtNum(summary.armorAbsorbed)}J</div></div>
      <div class="cr-stat"><div class="k">护甲损耗</div><div class="v red">${fmtNum(summary.armorWear, 1)}%</div></div>
      <div class="cr-stat"><div class="k">搜刮</div><div class="v">${summary.lootCount || 0}</div></div>
      <div class="cr-stat"><div class="k">携出价值</div><div class="v green">${fmtNum(summary.lootValue)}</div></div>
    </div>
  ` : '';

  const filters = [
    { id: 'all', label: '全部' },
    { id: 'dealt', label: '造成' },
    { id: 'taken', label: '承受' },
    { id: 'items', label: '物品' },
    { id: 'skills', label: '技能' },
  ];
  const filterHtml = filters.map(f =>
    `<button data-filter="${f.id}"${f.id === 'all' ? ' class="on"' : ''}>${f.label}</button>`
  ).join('');

  const btnHtml = buttons.map((b, i) =>
    `<button data-btn-idx="${i}"${b.primary ? ' class="primary"' : ''}>${esc(b.label)}</button>`
  ).join('');

  overlay.innerHTML = `
    <div class="cr-head">
      <div>
        <div class="cr-title ${titleCls}">${esc(title || '战斗记录')}</div>
        ${sub ? `<div class="cr-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>
    ${summaryHtml}
    <div class="cr-filter">${filterHtml}</div>
    <div class="cr-scroll" id="combat-report-scroll"></div>
    <div class="cr-actions">${btnHtml}</div>
  `;

  const scrollEl = overlay.querySelector('#combat-report-scroll');
  const currentFilter = { id: 'all' };

  const applyFilter = () => {
    const groupFn = FILTER_GROUPS[currentFilter.id] || (() => true);
    log.render(scrollEl, { filter: groupFn });
    scrollEl.scrollTop = 0;
  };
  applyFilter();

  overlay.querySelectorAll('.cr-filter button').forEach(btn => {
    btn.addEventListener('click', () => {
      overlay.querySelectorAll('.cr-filter button').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      currentFilter.id = btn.dataset.filter;
      applyFilter();
    });
  });

  overlay.querySelectorAll('.cr-actions button').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.btnIdx, 10);
      const b = buttons[idx];
      if (b && typeof b.onClick === 'function') b.onClick();
    });
  });

  return overlay;
}

export function hideCombatReport() {
  const overlay = document.getElementById('combat-report-overlay');
  if (overlay) overlay.classList.remove('on');
}
