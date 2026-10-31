/* ============================================================
   LaiAsaka Engine · Inventory Data Layer
   v1.0.0 · © 2026 ZpycuA · CC BY-NC 4.0
   ------------------------------------------------------------
   纯数据逻辑，不做 DOM。所有物品以 UID 隔离，跨物品引用一律
   是 UID 字符串。杜绝对象引用自环 / 无限递归 / DOM 状态不同步。

   核心特性：
     · UID 隔离（Map<uid, item>）
     · 父链自环检测（wouldCreateCycle / isDescendant）
     · 配件子槽递归（subSlots）
     · 栈合并（同 defId 同 dur）
     · 容器容量原子检查
     · 完整序列化
   ============================================================ */

let _uidCounter = 0;

function _genUid(prefix) {
  _uidCounter++;
  return prefix + '_' + Date.now().toString(36) + '_' + _uidCounter.toString(36);
}

const STACK_LIMITS = {
  ammo: 999,
  cons: 99,
  nade: 20,
  attach: 1,
  weapon: 1,
  helmetShell: 1,
  helmetVisor: 1,
  helmetEar: 1,
  vestFiber: 1,
  vestPlate: 1,
  backpack: 1,
  chestRig: 1,
};

const EQUIP_SLOTS = [
  'main', 'side',
  'helmetShell', 'helmetVisor', 'helmetEar',
  'vestFiber', 'vestPlate',
  'backpack', 'chestRig',
];

const EQUIP_TABLE = {
  main: 'weapons', side: 'weapons',
  helmetShell: 'helmetShell', helmetVisor: 'helmetVisor', helmetEar: 'helmetEar',
  vestFiber: 'vestFiber', vestPlate: 'vestPlate',
  backpack: 'backpack', chestRig: 'chestRig',
};

const CONTAINER_NAMES = ['chest', 'pocket', 'bag', 'safe', 'stash'];

const WEAPON_ATTACH_SLOTS = ['muzzle', 'sight', 'mag', 'grip'];

export class Inventory {
  constructor(contentRegistry) {
    this.content = contentRegistry;
    this.items = new Map();
    this.parentOf = new Map();
    this.equipped = {};
    this.containers = {};

    for (const slot of EQUIP_SLOTS) this.equipped[slot] = null;
    for (const name of CONTAINER_NAMES) {
      this.containers[name] = {
        uids: [],
        cap: name === 'stash' ? 200 : (name === 'pocket' ? 4 : (name === 'safe' ? 3 : 0)),
      };
    }
  }

  /* ====================== 创建 / 销毁 ====================== */
  createItem(table, defId, extras = {}) {
    const def = this.content.get(table, defId);
    if (!def) {
      console.warn('[Inv] 未找到定义:', table, defId);
      return null;
    }
    const uid = _genUid(table === 'weapons' ? 'w' : defId);

    const item = {
      uid,
      table,
      defId,
      qty: extras.qty || 1,
      dur: extras.dur !== undefined ? extras.dur : (def.maxDur || 0),
      durMax: def.maxDur || 0,
      attachments: null,
      subSlots: null,
    };

    if (table === 'weapons') {
      item.attachments = {};
      for (const k of WEAPON_ATTACH_SLOTS) item.attachments[k] = null;
    }

    this.items.set(uid, item);
    this.parentOf.set(uid, null);
    return uid;
  }

  destroyItem(uid) {
    const item = this.items.get(uid);
    if (!item) return false;

    if (item.attachments) {
      for (const k in item.attachments) {
        if (item.attachments[k]) this.destroyItem(item.attachments[k]);
      }
    }
    if (item.subSlots) {
      for (const k in item.subSlots) {
        if (item.subSlots[k]) this.destroyItem(item.subSlots[k]);
      }
    }

    this.items.delete(uid);
    this.parentOf.delete(uid);
    return true;
  }

  /* ====================== 查询 ====================== */
  getItem(uid) {
    return this.items.get(uid) || null;
  }

  getDef(itemOrUid) {
    const item = typeof itemOrUid === 'string' ? this.items.get(itemOrUid) : itemOrUid;
    if (!item) return null;
    return this.content.get(item.table, item.defId);
  }

  getContainer(name) {
  return this.containers[name] || null;
}

getItemValue(itemOrUid) {
  const item = typeof itemOrUid === 'string' ? this.items.get(itemOrUid) : itemOrUid;
  if (!item) return 0;
  const def = this.getDef(item);
  if (!def) return 0;
  let unit = def.value || 0;
  if (item.durMax > 0 && item.dur !== undefined) {
    const ratio = Math.max(0, Math.min(1, item.dur / item.durMax));
    unit = Math.round(unit * (0.3 + 0.7 * ratio));
  }
  return unit * (item.qty || 1);
}

getContainerValue(name) {
  const c = this.containers[name];
  if (!c) return 0;
  let total = 0;
  for (const uid of c.uids) total += this.getItemValue(uid);
  return total;
}

getTotalValue() {
  let total = 0;
  for (const slot in this.equipped) {
    const uid = this.equipped[slot];
    if (uid) total += this.getItemValue(uid);
  }
  for (const name of CONTAINER_NAMES) {
    total += this.getContainerValue(name);
  }
  return total;
}

  /* ====================== 容器操作 ====================== */
  addToContainer(name, uid) {
    const container = this.containers[name];
    const item = this.items.get(uid);
    if (!container || !item) return { ok: false, reason: 'no_target' };

    if (this.wouldCreateCycle(uid, 'c:' + name)) {
      return { ok: false, reason: 'cycle' };
    }

    /* 栈合并（同 defId 同 dur） */
    if (STACK_LIMITS[item.table] > 1 && item.dur === item.durMax) {
      const limit = STACK_LIMITS[item.table];
      for (const otherUid of container.uids) {
        const other = this.items.get(otherUid);
        if (!other) continue;
        if (other.table !== item.table) continue;
        if (other.defId !== item.defId) continue;
        if (other.dur !== item.dur) continue;
        const space = limit - other.qty;
        if (space >= item.qty) {
          other.qty += item.qty;
          this._detach(uid);
          this.destroyItem(uid);
          return { ok: true, merged: true };
        } else if (space > 0) {
          other.qty += space;
          item.qty -= space;
        }
      }
    }

    if (container.uids.length >= container.cap) {
      return { ok: false, reason: 'full' };
    }

    this._detach(uid);
    container.uids.push(uid);
    this.parentOf.set(uid, 'c:' + name);
    return { ok: true };
  }

  removeFromContainer(name, uid) {
    const container = this.containers[name];
    if (!container) return false;
    const idx = container.uids.indexOf(uid);
    if (idx < 0) return false;
    container.uids.splice(idx, 1);
    if (this.parentOf.get(uid) === 'c:' + name) this.parentOf.set(uid, null);
    return true;
  }

  /* ====================== 装备操作 ====================== */
  equip(slot, uid) {
    if (!EQUIP_SLOTS.includes(slot)) return { ok: false, reason: 'bad_slot' };
    const item = this.items.get(uid);
    if (!item) return { ok: false, reason: 'no_item' };

    const expectedTable = EQUIP_TABLE[slot];
    if (expectedTable && item.table !== expectedTable) {
      return { ok: false, reason: 'type_mismatch' };
    }

    if (this.wouldCreateCycle(uid, 'eq:' + slot)) {
      return { ok: false, reason: 'cycle' };
    }

    const oldUid = this.equipped[slot];
    this._detach(uid);

    this.equipped[slot] = uid;
    this.parentOf.set(uid, 'eq:' + slot);

    if (slot === 'backpack') {
      const d = this.getDef(item);
      this.containers.bag.cap = d ? (d.cap || 0) : 0;
    }
    if (slot === 'chestRig') {
      const d = this.getDef(item);
      this.containers.chest.cap = d ? (d.cap || 0) : 0;
    }
    return { ok: true, swapped: oldUid };
  }

  unequip(slot) {
    if (!EQUIP_SLOTS.includes(slot)) return null;
    const uid = this.equipped[slot];
    if (!uid) return null;
    this.equipped[slot] = null;
    this.parentOf.set(uid, null);
    if (slot === 'backpack') this.containers.bag.cap = 0;
    if (slot === 'chestRig') this.containers.chest.cap = 0;
    return uid;
  }

  /* ====================== 配件操作 ====================== */
  attachTo(weaponUid, slot, attachUid) {
    const weapon = this.items.get(weaponUid);
    const attach = this.items.get(attachUid);
    if (!weapon || !attach) return { ok: false, reason: 'no_item' };
    if (!weapon.attachments) return { ok: false, reason: 'not_weapon' };
    if (attach.table !== 'attach') return { ok: false, reason: 'type_mismatch' };
    if (!(slot in weapon.attachments)) return { ok: false, reason: 'bad_slot' };

    if (this.wouldCreateCycle(attachUid, weaponUid)) {
      return { ok: false, reason: 'cycle' };
    }

    const oldUid = weapon.attachments[slot];
    this._detach(attachUid);
    weapon.attachments[slot] = attachUid;
    this.parentOf.set(attachUid, weaponUid);
    return { ok: true, swapped: oldUid };
  }

  detachFrom(weaponUid, slot) {
    const weapon = this.items.get(weaponUid);
    if (!weapon || !weapon.attachments) return null;
    const uid = weapon.attachments[slot];
    if (!uid) return null;
    weapon.attachments[slot] = null;
    this.parentOf.set(uid, null);
    return uid;
  }

  attachToSubSlot(hostUid, subSlot, attachUid) {
    const host = this.items.get(hostUid);
    const attach = this.items.get(attachUid);
    if (!host || !attach) return { ok: false, reason: 'no_item' };
    if (attach.table !== 'attach') return { ok: false, reason: 'type_mismatch' };

    if (!host.subSlots) {
      const hostDef = this.getDef(host);
      const subSlots = hostDef && hostDef.subSlots;
      if (!subSlots || !subSlots.includes(subSlot)) {
        return { ok: false, reason: 'bad_slot' };
      }
      host.subSlots = {};
      for (const s of subSlots) host.subSlots[s] = null;
    }
    if (!(subSlot in host.subSlots)) return { ok: false, reason: 'bad_slot' };

    if (this.wouldCreateCycle(attachUid, hostUid)) {
      return { ok: false, reason: 'cycle' };
    }

    const oldUid = host.subSlots[subSlot];
    this._detach(attachUid);
    host.subSlots[subSlot] = attachUid;
    this.parentOf.set(attachUid, hostUid);
    return { ok: true, swapped: oldUid };
  }

  /* ====================== 自环检测（核心鲁棒性） ====================== */
  wouldCreateCycle(sourceUid, targetParent) {
    if (!targetParent) return false;
    if (targetParent.startsWith('c:') || targetParent.startsWith('eq:')) return false;
    return this.isDescendant(sourceUid, targetParent);
  }

  isDescendant(ancestorUid, nodeUid) {
    let cur = nodeUid;
    const seen = new Set();
    while (cur) {
      if (cur === ancestorUid) return true;
      if (seen.has(cur)) return true;
      seen.add(cur);
      cur = this.parentOf.get(cur) || null;
    }
    return false;
  }

  /* ====================== 内部 ====================== */
  _detach(uid) {
    const parent = this.parentOf.get(uid);
    if (!parent) return;

    if (parent.startsWith('eq:')) {
      const slot = parent.slice(3);
      if (this.equipped[slot] === uid) {
        this.equipped[slot] = null;
        if (slot === 'backpack') this.containers.bag.cap = 0;
        if (slot === 'chestRig') this.containers.chest.cap = 0;
      }
    } else if (parent.startsWith('c:')) {
      const name = parent.slice(2);
      const container = this.containers[name];
      if (container) {
        const idx = container.uids.indexOf(uid);
        if (idx >= 0) container.uids.splice(idx, 1);
      }
    } else {
      const parentItem = this.items.get(parent);
      if (parentItem) {
        if (parentItem.attachments) {
          for (const k in parentItem.attachments) {
            if (parentItem.attachments[k] === uid) parentItem.attachments[k] = null;
          }
        }
        if (parentItem.subSlots) {
          for (const k in parentItem.subSlots) {
            if (parentItem.subSlots[k] === uid) parentItem.subSlots[k] = null;
          }
        }
      }
    }
    this.parentOf.set(uid, null);
  }

  /* ====================== 序列化 ====================== */
  serialize() {
    const items = [];
    for (const item of this.items.values()) items.push(JSON.parse(JSON.stringify(item)));
    const parentOf = [];
    for (const [k, v] of this.parentOf) parentOf.push([k, v]);
    const containers = {};
    for (const name in this.containers) {
      containers[name] = {
        uids: this.containers[name].uids.slice(),
        cap: this.containers[name].cap,
      };
    }
    return {
      items,
      parentOf,
      equipped: JSON.parse(JSON.stringify(this.equipped)),
      containers,
      uidCounter: _uidCounter,
    };
  }

  deserialize(data) {
    if (!data) return;
    this.items.clear();
    this.parentOf.clear();
    for (const item of data.items || []) this.items.set(item.uid, item);
    for (const [k, v] of data.parentOf || []) this.parentOf.set(k, v);
    this.equipped = data.equipped || {};
    for (const slot of EQUIP_SLOTS) {
      if (!(slot in this.equipped)) this.equipped[slot] = null;
    }
    this.containers = data.containers || {};
    for (const name of CONTAINER_NAMES) {
      if (!this.containers[name]) {
        this.containers[name] = {
          uids: [],
          cap: name === 'stash' ? 200 : (name === 'pocket' ? 4 : (name === 'safe' ? 3 : 0)),
        };
      }
    }
    _uidCounter = data.uidCounter || 0;
  }
}
