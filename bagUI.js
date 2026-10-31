/* ============================================================
   LaiAsaka Engine · Bag UI
   v1.0.0 · © 2026 ZpycuA · CC BY-NC 4.0
   ------------------------------------------------------------
   自注入 CSS + DOM，不依赖 index.html 任何既有元素。
   纯数据操作走 Inventory 接口，UI 只负责渲染 + 拖拽。
   ============================================================ */

const CSS = `
#bagui-overlay{position:fixed;inset:0;z-index:500;background:rgba(4,8,14,.94);display:none;flex-direction:column;font-family:-apple-system,"PingFang SC",sans-serif;color:#d8e2ee;padding:12px;touch-action:auto;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}#bagui-overlay.on{display:flex}
.bagui-wrap{display:flex;flex-direction:column;height:100%;max-width:1200px;margin:0 auto;width:100%}
.bagui-header{display:flex;justify-content:space-between;align-items:center;padding-bottom:8px;border-bottom:1px solid rgba(105,170,235,.3)}
.bagui-header h2{font-size:16px;letter-spacing:4px;color:#a8d8ff}
#bagui-close{width:32px;height:32px;border-radius:6px;background:rgba(60,100,150,.5);border:1px solid rgba(110,180,255,.4);color:#cfe8ff;font-size:16px;cursor:pointer}
.bagui-main{flex:1;display:flex;gap:12px;margin-top:10px;min-height:0}
.bagui-left,.bagui-right{flex:1;overflow-y:auto;padding:4px;min-width:0}
.bagui-right{flex:1.5;background:rgba(10,18,28,.5);border-radius:8px}
.bagui-sec{margin-bottom:10px;background:rgba(20,32,46,.6);border-radius:6px;padding:8px}
.bagui-sec h3{font-size:11px;letter-spacing:2px;color:#8fb0c8;margin-bottom:6px;display:flex;justify-content:space-between;font-weight:600}
.bagui-cap{font-size:9px;color:#5c82a8}
.bagui-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(56px,1fr));gap:4px}
.bagui-slot{aspect-ratio:1;background:rgba(10,18,30,.8);border:1px solid rgba(80,125,175,.2);border-radius:4px;position:relative;overflow:hidden;cursor:pointer;user-select:none}
.bagui-slot.has-item{background:rgba(30,50,75,.8);border-color:rgba(100,160,220,.5)}
.bagui-slot.drop-hint{box-shadow:0 0 0 2px #7bf5a8 inset}
.bagui-slot.empty{opacity:.4;cursor:default}
.bagui-icon{position:absolute;top:3px;left:50%;transform:translateX(-50%);font-size:18px;line-height:1}
.bagui-name{position:absolute;bottom:2px;left:2px;right:2px;font-size:8px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#cfe4f8}
.bagui-qty{position:absolute;top:1px;right:3px;font-size:9px;color:#ffd93d;font-weight:700}
.bagui-dur{position:absolute;bottom:0;left:0;right:0;height:2px;background:rgba(0,0,0,.6)}
.bagui-dur i{display:block;height:100%}
.bagui-ghost{position:fixed;z-index:9999;padding:4px 10px;background:rgba(60,120,190,.9);border:1px solid #7fd0ff;border-radius:4px;font-size:11px;transform:translate(-50%,-50%);pointer-events:none;white-space:nowrap;color:#fff;font-weight:600}
.bagui-detail{margin-top:10px;padding:10px;background:rgba(20,32,46,.8);border-radius:6px;max-height:180px;overflow-y:auto;font-size:11px;line-height:1.7}
.bagui-detail-title{font-size:14px;color:#a8d8ff;margin-bottom:6px;font-weight:700}
.bagui-flavor{font-size:10px;color:#6a8ca8;font-style:italic;margin-top:6px;padding-top:6px;border-top:1px dashed rgba(80,125,175,.3)}
.bagui-attach-title{font-size:10px;color:#8fb0c8;margin-top:8px;margin-bottom:4px;letter-spacing:2px}
.bagui-attach-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:4px}
.bagui-attach-slot{padding:5px 8px;background:rgba(10,18,28,.6);border:1px solid rgba(80,125,175,.2);border-radius:4px;display:flex;justify-content:space-between;font-size:10px}
.bagui-attach-label{color:#6a8ca8}
.bagui-attach-val{color:#cfe8ff}
.bagui-attach-empty{color:#4a6d8e}
.bagui-attach-slot.drop-hint{box-shadow:0 0 0 2px #7bf5a8 inset}
.bagui-empty{color:#5c82a8;text-align:center;padding:20px}
.bagui-val{position:absolute;top:1px;left:3px;font-size:8px;color:#a8d8ff;font-weight:600;text-shadow:0 1px 2px #000}
.bagui-total{font-size:10px;color:#ffd93d;letter-spacing:1px;font-weight:700}
.bagui-toolbar{display:flex;gap:6px;margin-top:8px;padding:6px;background:rgba(10,18,28,.5);border-radius:6px;align-items:center;justify-content:space-between}
.bagui-toolbar button{padding:5px 12px;font-size:11px;cursor:pointer;background:rgba(40,80,130,.7);border:1px solid rgba(110,180,255,.5);color:#cfe8ff;border-radius:5px;font-family:inherit}
.bagui-toolbar button:hover{background:rgba(50,100,160,.8)}
@media(max-width:768px){.bagui-main{flex-direction:column}.bagui-right{flex:1}}
`;

export class BagUI {
  constructor(engine, inventory) {
    this.engine = engine;
    this.inv = inventory;
    this.open = false;
    this.selectedUid = null;
    this._drag = null;
    this._injectCSS();
    this._buildDOM();
  }

  _injectCSS() {
    if (document.getElementById('bagui-style')) return;
    const s = document.createElement('style');
    s.id = 'bagui-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  _buildDOM() {
    if (document.getElementById('bagui-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'bagui-overlay';
    overlay.innerHTML = `
      <div class="bagui-wrap">
        <div class="bagui-header">
          <h2>背包 · 仓库</h2>
          <button id="bagui-close">✕</button>
        </div>
        <div class="bagui-main">
          <div class="bagui-left" id="bagui-left"></div>
          <div class="bagui-right" id="bagui-right"></div>
        </div>
        <div class="bagui-detail" id="bagui-detail">选择物品查看详情</div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('bagui-close').addEventListener('click', () => this.close());
window.addEventListener('pointermove', (e) => this._onMove(e));
window.addEventListener('pointerup', (e) => this._onUp(e));
window.addEventListener('pointercancel', () => { this._cancelDrag(); this._clearGhosts(); });
document.addEventListener('contextmenu', (e) => {
  if (this.open && e.target && e.target.closest && e.target.closest('#bagui-overlay')) {
    e.preventDefault();
  }
});
  }

toggle() { this.open ? this.close() : this.show(); }
show() {
  if (document.pointerLockElement) document.exitPointerLock();
  this.open = true;
  this._clearGhosts();
  document.getElementById('bagui-overlay').classList.add('on');
  this.refresh();
}
close() {
  this.open = false;
  document.getElementById('bagui-overlay').classList.remove('on');
  this._cancelDrag();
  this._clearGhosts();
}

  refresh() {
  if (!this.open) return;
  this._renderLeft();
  this._renderRight();
  this._renderToolbar();
  this._renderDetail();
}

_renderToolbar() {
  let bar = document.getElementById('bagui-toolbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'bagui-toolbar';
    bar.className = 'bagui-toolbar';
    const wrap = document.querySelector('.bagui-wrap');
    if (!wrap) return;
    const main = document.getElementById('bagui-left')?.parentNode;
    if (main && main.parentNode === wrap) {
      wrap.insertBefore(bar, main.nextSibling);
    } else {
      wrap.appendChild(bar);
    }
  }
  const isInMatch = this.engine.app && this.engine.app.world && this.engine.app.world.running;
  const totalVal = this.inv.getTotalValue();
  const carryVal = this.inv.getContainerValue('chest') + this.inv.getContainerValue('pocket') + this.inv.getContainerValue('bag');
  const label = isInMatch
    ? `携带 ${carryVal} cp`
    : `仓库 ${this.inv.getContainerValue('stash')} cp · 总值 ${totalVal} cp`;
  let html = `<span class="bagui-total">${label}</span>`;
  if (!isInMatch) {
    html += '<button id="bagui-stash-all">整理 · 全部入仓</button>';
  }
  bar.innerHTML = html;
  const btn = document.getElementById('bagui-stash-all');
  if (btn) btn.onclick = () => this._stashAll();
}

_stashAll() {
  const containers = ['chest', 'pocket', 'bag'];
  let moved = 0, failed = 0;
  for (const cName of containers) {
    const c = this.inv.containers[cName];
    if (!c) continue;
    const uids = c.uids.slice();
    for (const uid of uids) {
      const r = this.inv.addToContainer('stash', uid);
      if (r.ok) moved++;
      else failed++;
    }
  }
  console.log('[BagUI] 整理完成：入仓', moved, '失败', failed);
  this.refresh();
}

  _renderLeft() {
    const el = document.getElementById('bagui-left');
    const inv = this.inv;
    let html = '';
    html += '<div class="bagui-sec"><h3>装备</h3><div class="bagui-grid">';
    const equipList = [
      ['main', '主武器'], ['side', '副武器'],
      ['helmetShell', '头盔'], ['helmetVisor', '面罩'], ['helmetEar', '耳机'],
      ['vestFiber', '护甲'], ['vestPlate', '插板'],
      ['backpack', '背包'], ['chestRig', '胸挂'],
    ];
    for (const [slot, label] of equipList) html += this._slotHtml(inv.equipped[slot], { type: 'equip', slot }, label);
    html += '</div></div>';

    for (const name of ['chest', 'pocket', 'bag', 'safe']) {
      const c = inv.containers[name];
      if (!c || !c.cap) continue;
      html += `<div class="bagui-sec"><h3>${this._cname(name)}<span class="bagui-cap">${c.uids.length}/${c.cap}</span></h3><div class="bagui-grid">`;
      for (const uid of c.uids) html += this._slotHtml(uid, { type: 'container', name });
      for (let i = c.uids.length; i < c.cap; i++) html += `<div class="bagui-slot empty" data-src-type="container" data-src-name="${name}"></div>`;
      html += '</div></div>';
    }
    el.innerHTML = html;
    this._bindSlotEvents(el);
  }

  _renderRight() {
  const el = document.getElementById('bagui-right');
  if (!el) return;
  const isInMatch = this.engine.app && this.engine.app.world && this.engine.app.world.running;
  if (isInMatch) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const c = this.inv.containers.stash;
  let html = `<div class="bagui-sec"><h3>仓库<span class="bagui-cap">${c.uids.length}/${c.cap}</span></h3><div class="bagui-grid">`;
  for (const uid of c.uids) html += this._slotHtml(uid, { type: 'container', name: 'stash' });
  for (let i = c.uids.length; i < Math.min(c.cap, c.uids.length + 20); i++) html += `<div class="bagui-slot empty" data-src-type="container" data-src-name="stash"></div>`;
  html += '</div></div>';
  el.innerHTML = html;
  this._bindSlotEvents(el);
}

  _slotHtml(uid, src, hint) {
    const inv = this.inv;
    const srcAttrs = src.type === 'equip'
      ? `data-src-type="equip" data-src-slot="${src.slot}"`
      : `data-src-type="container" data-src-name="${src.name}"`;
    if (!uid) return `<div class="bagui-slot empty" ${srcAttrs}>${hint ? `<div class="bagui-name" style="bottom:50%;transform:translateY(50%);color:#5c82a8">${hint}</div>` : ''}</div>`;
    const item = inv.items.get(uid);
    if (!item) return `<div class="bagui-slot empty" ${srcAttrs}></div>`;
    const def = inv.getDef(item);
const rawName = def ? (def.name || def.n || def.id || '?') : '?';
const name = this.engine.i18n.t(rawName);
    const qty = item.qty > 1 ? `<span class="bagui-qty">×${item.qty}</span>` : '';
    const dur = item.durMax > 0 ? Math.round(item.dur / item.durMax * 100) : -1;
    const durBar = dur >= 0 ? `<div class="bagui-dur"><i style="width:${dur}%;background:${dur > 60 ? '#6fe07a' : dur > 30 ? '#ffd93d' : '#ff5a5a'}"></i></div>` : '';
    const val = inv.getItemValue(uid);
const valBadge = val > 0 ? `<div class="bagui-val">${val >= 1000 ? (val / 1000).toFixed(1) + 'k' : val}</div>` : '';
return `<div class="bagui-slot has-item" data-uid="${uid}" ${srcAttrs}>
  <div class="bagui-icon">${this._icon(item)}</div>
  <div class="bagui-name">${this._esc(name)}</div>
  ${qty}${durBar}${valBadge}
</div>`;
  }

_icon(item) {
  if (!item) return '?';
  const def = this.inv.getDef(item);
  if (def && def.icon) {
    const icon = String(def.icon);
    if (icon.startsWith('/') || icon.startsWith('http') || icon.startsWith('data:')) {
      return `<img src="${this._esc(icon)}" alt="" style="width:100%;height:100%;object-fit:contain">`;
    }
    return icon;
  }
  return {
    weapons: '🔫', ammo: '🔸', cons: '💊', nade: '💣', attach: '⚙', valuable: '💎',
    helmetShell: '⛑', helmetVisor: '🕶', helmetEar: '🎧',
    vestFiber: '🦺', vestPlate: '🛡', backpack: '🎒', chestRig: '🧥'
  }[item.table] || '?';
}

  _cname(n) { return { chest: '胸挂', pocket: '口袋', bag: '背包', safe: '安全箱', stash: '仓库' }[n] || n; }
  _esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

  _bindSlotEvents(root) {
  root.querySelectorAll('.bagui-slot.has-item').forEach(el => {
    const uid = el.dataset.uid;
    el.addEventListener('pointerdown', (e) => this._onDown(e, uid, el));
    el.addEventListener('click', () => { if (!this._drag) { this.selectedUid = uid; this._renderDetail(); } });
    el.addEventListener('dblclick', (e) => { e.preventDefault(); this._quickEquip(uid); });
  });
}

_quickEquip(uid) {
  const item = this.inv.items.get(uid);
  if (!item) return;
  let targetSlot = null;
  if (item.table === 'weapons') targetSlot = 'main';
  else if (item.table === 'helmetShell') targetSlot = 'helmetShell';
  else if (item.table === 'helmetVisor') targetSlot = 'helmetVisor';
  else if (item.table === 'helmetEar') targetSlot = 'helmetEar';
  else if (item.table === 'vestFiber') targetSlot = 'vestFiber';
  else if (item.table === 'vestPlate') targetSlot = 'vestPlate';
  else if (item.table === 'backpack') targetSlot = 'backpack';
  else if (item.table === 'chestRig') targetSlot = 'chestRig';
  if (!targetSlot) return;
  const r = this.inv.equip(targetSlot, uid);
  if (!r.ok) {
    console.warn('[BagUI] 快速装备失败', uid, targetSlot, r.reason);
    return;
  }
  this.selectedUid = uid;
  this.refresh();
}

  _renderDetail() {
    const el = document.getElementById('bagui-detail');
    const uid = this.selectedUid;
    if (!uid || !this.inv.items.has(uid)) { el.innerHTML = '<div class="bagui-empty">选择物品查看详情</div>'; return; }
    const item = this.inv.items.get(uid);
    const def = this.inv.getDef(item);
    if (!def) { el.innerHTML = '<div class="bagui-empty">未知物品</div>'; return; }
    const rawDetailName = def.name || def.n || '?';
const displayDetailName = this.engine.i18n.t(rawDetailName);
let html = `<div class="bagui-detail-title">${this._esc(displayDetailName)}</div>`;
const unitVal = this.inv.getItemValue(uid);
if (item.qty > 1) {
  const unit = Math.round(unitVal / item.qty);
  html += `<div>数量：${item.qty}（单价 ${unit} cp · 总价 ${unitVal} cp）</div>`;
} else if (unitVal > 0) {
  html += `<div>价值：${unitVal} cp</div>`;
}
if (item.durMax > 0) html += `<div>耐久：${Math.round(item.dur)}/${item.durMax}（${Math.round(item.dur / item.durMax * 100)}%）</div>`;    if (def.rpm) html += `<div>射速 ${def.rpm} RPM · 弹匣 ${def.mag || '—'}</div>`;
    if (def.flavor) html += `<div class="bagui-flavor">「${this._esc(def.flavor)}」</div>`;
    if (item.attachments) {
      html += '<div class="bagui-attach-title">配件槽（拖配件到此）</div><div class="bagui-attach-grid">';
      for (const slot of ['muzzle', 'sight', 'mag', 'grip']) {
        const aUid = item.attachments[slot];
        html += `<div class="bagui-attach-slot" data-weapon-uid="${uid}" data-attach-slot="${slot}">`;
        html += `<span class="bagui-attach-label">${slot}</span>`;
        if (aUid) {
  const aDef = this.inv.getDef(this.inv.items.get(aUid));
  const aRawName = aDef ? (aDef.name || aDef.n || '?') : '?';
  const aDisplayName = this.engine.i18n.t(aRawName);
  html += `<span class="bagui-attach-val">${this._esc(aDisplayName)}</span>`;
} else html += '<span class="bagui-attach-empty">空</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    el.innerHTML = html;
    el.querySelectorAll('.bagui-attach-slot').forEach(s => {
      s.addEventListener('pointerup', (e) => {
        if (!this._drag || !this._drag.moved) return;
        const srcUid = this._drag.uid;
        this._cancelDrag();
        this._handleDrop(srcUid, s);
      });
    });
  }

  /* ===== 拖拽 ===== */
  _onDown(e, uid, el) {
    if (e.button !== undefined && e.button > 0) return;
    e.preventDefault();
    this._drag = { uid, startX: e.clientX, startY: e.clientY, moved: false, ghost: null, srcEl: el };
  }

  _onMove(e) {
    if (!this._drag) return;
    if (!this._drag.moved) {
      const dx = e.clientX - this._drag.startX, dy = e.clientY - this._drag.startY;
      if (dx * dx + dy * dy < 100) return;
      this._drag.moved = true;
      const item = this.inv.items.get(this._drag.uid);
      const def = item ? this.inv.getDef(item) : null;
      const ghost = document.createElement('div');
      ghost.className = 'bagui-ghost';
      ghost.textContent = def ? (def.name || def.n) : '?';
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
      document.body.appendChild(ghost);
      this._drag.ghost = ghost;
      if (this._drag.srcEl) this._drag.srcEl.style.opacity = 0.4;
    }
    if (this._drag.ghost) { this._drag.ghost.style.left = e.clientX + 'px'; this._drag.ghost.style.top = e.clientY + 'px'; }
    document.querySelectorAll('.bagui-slot.drop-hint,.bagui-attach-slot.drop-hint').forEach(x => x.classList.remove('drop-hint'));
    const tgt = document.elementFromPoint(e.clientX, e.clientY);
    if (tgt) {
      const s = tgt.closest('.bagui-slot,.bagui-attach-slot');
      if (s && s !== this._drag.srcEl) s.classList.add('drop-hint');
    }
  }

  _onUp(e) {
    if (!this._drag) return;
    const moved = this._drag.moved;
    const uid = this._drag.uid;
    const srcEl = this._drag.srcEl;
    if (!moved) { this._cancelDrag(); return; }
    const tgt = document.elementFromPoint(e.clientX, e.clientY);
    this._cancelDrag();
    if (!tgt) { if (srcEl) srcEl.style.opacity = 1; return; }
    const slotEl = tgt.closest('.bagui-slot,.bagui-attach-slot');
    if (!slotEl) { if (srcEl) srcEl.style.opacity = 1; return; }
    this._handleDrop(uid, slotEl);
  }

   _clearGhosts() {
  document.querySelectorAll('.bagui-ghost').forEach(g => { try { g.remove(); } catch (_) {} });
   }

  _cancelDrag() {
    if (this._drag && this._drag.ghost) this._drag.ghost.remove();
    if (this._drag && this._drag.srcEl) this._drag.srcEl.style.opacity = 1;
    document.querySelectorAll('.bagui-slot.drop-hint,.bagui-attach-slot.drop-hint').forEach(x => x.classList.remove('drop-hint'));
    this._drag = null;
  }

  _handleDrop(uid, slotEl) {
    const inv = this.inv;
    let target;
    if (slotEl.classList.contains('bagui-attach-slot')) {
      target = { type: 'attach', weaponUid: slotEl.dataset.weaponUid, slot: slotEl.dataset.attachSlot };
    } else {
      const st = slotEl.dataset.srcType;
      if (st === 'equip') target = { type: 'equip', slot: slotEl.dataset.srcSlot };
      else if (st === 'container') target = { type: 'container', name: slotEl.dataset.srcName };
      else return;
    }

    const srcParent = inv.parentOf.get(uid);
    inv._detach(uid);

    let result;
    if (target.type === 'equip') result = inv.equip(target.slot, uid);
    else if (target.type === 'container') result = inv.addToContainer(target.name, uid);
    else if (target.type === 'attach') result = inv.attachTo(target.weaponUid, target.slot, uid);
    else result = { ok: false, reason: 'bad_target' };

    if (!result.ok) {
      this._restoreTo(uid, srcParent);
    } else if (result.swapped) {
      this._restoreTo(result.swapped, srcParent);
    }
    this.refresh();
  }

  _restoreTo(uid, parent) {
    if (!parent) { this.inv.addToContainer('stash', uid); return; }
    if (parent.startsWith('eq:')) { this.inv.equip(parent.slice(3), uid); return; }
    if (parent.startsWith('c:')) { this.inv.addToContainer(parent.slice(2), uid); return; }
    const p = this.inv.items.get(parent);
    if (p && p.attachments) {
      for (const k in p.attachments) if (!p.attachments[k]) if (this.inv.attachTo(parent, k, uid).ok) return;
    }
    if (p && p.subSlots) {
      for (const k in p.subSlots) if (!p.subSlots[k]) if (this.inv.attachToSubSlot(parent, k, uid).ok) return;
    }
    this.inv.addToContainer('stash', uid);
  }
}
