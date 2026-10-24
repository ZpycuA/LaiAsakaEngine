/* ============================================================
   LaiAsaka Engine · Modes
   v3.0.0 · © 2026 ZpycuA · CC BY-NC 4.0
   ------------------------------------------------------------
   本文件注册"游戏模式"。模式决定：
     - 这一局的玩法重点（战斗 / 剧情 / 派系 / 好感）
     - 启用哪些 systems
     - 在关键事件上执行什么 hook
   
   当前注册：
     straight  ─ 硬核撤离 · 只跑战斗
     asaka     ─ 剧情模式 · 预留 dialogue/faction/affection 空壳
   
   未来可加：
     bossrush  ─ 首领连战
     sandbox   ─ 自由测试
   ============================================================ */

export function registerModes(engine) {
  const reg = engine.modeRegistry;

  /* ==========================================================
     模式 1 · straight
     硬核撤离 · 快节奏战斗 · 无剧情负担
     ========================================================== */
  reg.register('straight', {
    name: 'mode.straight.name',
    desc: 'mode.straight.desc',

    /* 这一局启用的系统 */
    systems: ['combat', 'ai', 'task', 'hud'],

    /* 进入对局时调用：不需要额外初始化 */
    setup(world) {
      // 关闭剧情相关系统（即使用户从 asaka 切回 straight 也不残留）
      world.dialogue  = null;
      world.faction   = null;
      world.affection = null;
    },

    teardown(world) {
      // 无需清理
    },

    /* 关键事件钩子（所有参数可选实现） */
    hooks: {
      /* 对局开始（切场景后第一次 tick） */
      onMatchStart(world) {
        // straight 模式无开场对话
      },
      /* 玩家实体创建完成 */
      onPlayerSpawn(world, player) {
        // straight 模式无初始关系
      },
      /* 敌人被击杀 */
      onEnemyKilled(world, enemy) {
        // straight 模式不扣声望
      },
      /* 玩家被击倒 */
      onPlayerDowned(world) {
        // straight 模式无队友自动救援
      },
      /* 撤离点开始计时 */
      onExtractStart(world, extract) {
        // 无特殊行为
      },
      /* 对局结束（无论成败） */
      onMatchEnd(world, success) {
        // straight 模式无额外奖励逻辑
      },
    },
  });

  /* ==========================================================
     模式 2 · asaka
     剧情模式 · 派系 / 好感 / 对话
     ----------------------------------------------------------
     本轮只提供接口骨架，具体逻辑下次填入 game.js 的 systems。
     ========================================================== */
  reg.register('asaka', {
    name: 'mode.asaka.name',
    desc: 'mode.asaka.desc',

    systems: ['combat', 'ai', 'task', 'hud', 'dialogue', 'faction', 'affection'],

    setup(world) {
      /* --- 对话系统空壳 --- */
      world.dialogue = {
        enabled: true,
        current: null,
        history: [],
        start(nodeId) {
          this.current = { id: nodeId, startedAt: Date.now() };
          this.history.push({ id: nodeId, at: Date.now() });
        },
        end() { this.current = null; },
        isPlaying() { return this.current !== null; },
      };

      /* --- 派系声望空壳 --- */
      world.faction = {
        reputation: {
          nipsel: 0,   // 尼珀斯尔工业
          bank: 0,     // 大陆银行
          prazer: 0,   // Prazer 协会
        },
        get(factionId) { return this.reputation[factionId] || 0; },
        modify(factionId, delta) {
          if (factionId in this.reputation) {
            this.reputation[factionId] += delta;
            return this.reputation[factionId];
          }
          return 0;
        },
      };

      /* --- 好感度空壳（角色 id → 好感值） --- */
      world.affection = {
        levels: {
          kate: 0,
          lingna: 0,
          buwen: 0,
        },
        get(charId) { return this.levels[charId] || 0; },
        modify(charId, delta) {
          if (charId in this.levels) {
            this.levels[charId] += delta;
            return this.levels[charId];
          }
          return 0;
        },
      };
    },

    teardown(world) {
      world.dialogue  = null;
      world.faction   = null;
      world.affection = null;
    },

    hooks: {
      onMatchStart(world) {
        /* TODO：下次接入对话表，触发开场剧情 */
        // if (world.dialogue) world.dialogue.start('intro');
        console.log('[Mode:asaka] 对局开始 · 剧情系统已就绪（空壳）');
      },

      onPlayerSpawn(world, player) {
        /* TODO：根据任务/派系状态应用初始关系 */
        // if (world.faction) { /* 读档应用 */ }
      },

      onEnemyKilled(world, enemy) {
        /* 简易声望衰减：击杀 Nipsel 会掉 Nipsel 声望 */
        if (!world.faction) return;
        const faction = enemy && enemy.spec ? enemy.spec.faction : null;
        if (!faction) return;
        world.faction.modify(faction, -5);
      },

      onPlayerDowned(world) {
        /* TODO：附近队友触发救援对话 */
      },

      onExtractStart(world, extract) {
        /* TODO：检查是否完成剧情目标 */
      },

      onMatchEnd(world, success) {
        /* TODO：结算好感度、派系声望、剧情进度 */
        if (success && world.affection) {
          // 示例：成功撤离，队伍好感 +1
          world.affection.modify('kate', 1);
          world.affection.modify('lingna', 1);
        }
        console.log('[Mode:asaka] 对局结束 ·', success ? '成功' : '失败');
      },
    },
  });

  /* ==========================================================
     预留扩展位 · 未来注册新模式的示例
     ----------------------------------------------------------
     reg.register('bossrush', {
       name: 'mode.bossrush.name',
       desc: 'mode.bossrush.desc',
       systems: ['combat', 'ai', 'hud'],
       setup(world) { ... },
       hooks: { ... },
     });
     ========================================================== */

  console.log(
    '[Modes] 已注册模式：' +
    reg.all().map(m => m.id).join(', ')
  );
}