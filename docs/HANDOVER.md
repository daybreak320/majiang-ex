# majiang-ex 阶段性成果与 Codex 交接手册

> 更新时间：2026-08-20 ｜ 交接背景：Trae 停用，后续由 Codex 接手 UI 与联调工作
> 本文件既是"当前进展快照"，也是"新协作者（Codex）的入场手册"。请先读本文件，再读 `PRD.md` 与 `docs/theory/mahjong-theory-zhuyang.md`。

---

## 1. 项目一句话定位

**成都血战到底麻将的"训练 + 复盘"应用**：用户与三家 AI（进攻型/稳健型/效率型）完整打一整局，AI 决策基于**朱扬《麻将"机会数"理论与实战》《成都麻将高级打法》两本书的理论**，局后可自动复盘指出打牌问题。

技术栈：Vite + React 19 + TypeScript + Vitest（规则引擎纯 TS 无依赖，UI 用 Tailwind 4 + framer-motion）。构建/测试命令见 §7。

## 2. 当前里程碑状态（对照 PRD 第 12 章）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 完整对局 | 规则引擎 + AI + 可玩 UI（定缺/碰杠胡/终局结算/存档恢复/倒计时） | ✅ **完成**（Trae 与规则层此前已完成） |
| M2 基础复盘 | 局后诊断引擎：2 个主要问题 + 1 个优秀决策 | 🟡 **核心引擎完成**（`src/review/`），**UI 复盘页未接**（原定 Trae 做） |
| M3 训练闭环 | 专项训练题（听牌/舍牌/牌型） | ⬜ 未开始，理论弹药已备 |
| M4 算法升级 | 副露/听牌场景的牌效评估 | ⬜ 未开始，理论弹药已备 |

## 3. 三方协作史（为什么代码长这样）

- **Trae（已停用）**：从旧"单机训练"应用改造为"四人实战血战到底"。产出：`src/game/` 规则引擎全套（core/scoring/ai/engine/replay/settlement）、`src/components/SichuanGame.tsx`（527 行核心 UI）、首页 + 实战双页面（`App.tsx`）、逐事件存档恢复（`persistence.ts`）、倒计时与拟人停顿（`ui.ts`）。停用前留下一个未清理的僵尸导入（已修，见 §6）。
- **荧惑（本 AI，负责逻辑领地）**：把朱扬两本书理论"喂"进项目，三层落地：
  1. `docs/theory/mahjong-theory-zhuyang.md` —— 理论知识库文档；
  2. `src/knowledge/mahjongTheory.ts` —— 可引用理论模块（机会数/强组合/安全分/番种表）；
  3. 接入 `src/game/ai.ts` 出牌决策（机会数加权）+ 新建 `src/review/` 复盘诊断引擎。
- **破晓（指挥官）**：在 Trae/Codex 下 UI 指令，在荧惑这边下逻辑指令，两边交付在 git 汇合后 review。

## 4. 代码地图

```
src/
├── game/            # 规则引擎（Trae + 荧惑，纯 TS 无 React）
│   ├── core.ts      # 108 张牌、确定性随机、开局、定缺推荐
│   ├── scoring.ts   # isWinningHand 判胡、番型、5 番封顶计分
│   ├── ai.ts        # 三风格 AI（效率型已接入机会数）、chooseDiscard、getAIReason
│   ├── engine.ts    # 事件驱动状态机 executeCommand(state, command)
│   ├── replay.ts    # 事件回放、状态校验、序列化
│   ├── settlement.ts# 终局结算：查叫/查花猪/杠分退款
│   ├── persistence.ts # 逐事件本地存档恢复
│   ├── ui.ts        # 拟人停顿、shouldAdvanceAI
│   └── presentation.ts # 事件时间线、buildGameReview（简易版）、结算摘要
├── knowledge/       # 朱扬理论模块（荧惑新增，纯 TS）
│   └── mahjongTheory.ts  # countOpportunities / isStrongCombo / safetyScore / CHENGDU_FAN_TABLE
├── review/          # M2 复盘引擎（荧惑新增，纯 TS，不依赖 UI）
│   ├── types.ts     # 报告契约：DiscardDecision / ReviewIssue / ReviewReport
│   ├── analyzer.ts  # analyzeGame(events) → 2 问题 + 1 亮点
│   └── analyzer.test.ts
└── components/      # UI（Trae 领地）
    ├── SichuanGame.tsx   # 四方牌桌主战场（527 行）
    ├── MajiangTile.tsx / MajiangHand.tsx  # 牌面
    └── ...（旧训练组件保留）
```

**领地约定（重要）**：`src/game/`、`src/knowledge/`、`src/review/`、`docs/theory/` 归逻辑侧（现在归荧惑，未来 Codex 可只读）；`src/components/`、`src/App.tsx`、`src/index.css` 归 UI 侧（未来归 Codex）。**测试是全体的契约**：任何改动不得让 92 个测试变红。

## 5. 朱扬理论落地链路（本次最重要成果）

```
理论书 → docs/theory/mahjong-theory-zhuyang.md（知识库）
       → src/knowledge/mahjongTheory.ts（可编程理论）
            ├─ countOpportunities(hand, visible, {dingque}) → AI 出牌加权（ai.ts）
            ├─ 同函数 → src/review/analyzer.ts 牌效诊断（打牌前后机会数对比）
            ├─ brokenStrongCombos → 强组合被拆检测（复盘）
            ├─ safetyScore → 攻防诊断（尾盘危险线）
            └─ gangBreaksStructure → 杠牌结构校验（待复盘接入）
```

关键设计决策（Codex 改代码前必读）：

1. **机会数口径**：`countOpportunities` 复用引擎 `isWinningHand`（13 张 + 1 张进张判胡），口径与判胡完全一致；支持 `dingque` 扣减（血战缺门不能当进张）。**只对无副露的 14 张手牌有效**（碰/杠后不评估，留给 M4）。
2. **AI 决策融合**：`chooseDiscard` 排序 = `structureScore`（全盘结构分）+ `opportunityScore`（机会数 × 风格权重：效率 0.9 / 进攻 0.7 / 稳健 0.55）− `danger`（稳健型避险）。两者互补：结构分管全盘，机会数是中后盘"一进听"时的精确制导。
3. **复盘数据来源**：`analyzeGame(events)` 从事件流提取 `tile_discarded`，向后找第一个带 `state` 快照的事件（`executeCommand` 保证命令末事件必带完整 `GameStateSnapshot`），重建 14 张手牌诊断，无需自己重放。
4. **2+1 输出**：`buildReport` 聚合 → `summary.majorIssues`（≤2 个严重度 ≥4 的问题）+ `summary.goodDecision`（1 个优秀决策，机会数损失为 0 或最少且未破坏强组合）+ `stats.opportunityTrend`（机会数趋势曲线数据，供 UI 画图）。
5. **定缺强制不误报**：定缺门只剩 1 张时的强制出牌不算牌效错误；尾盘（墙 ≤ 40）打 3/6/9 危险线非熟张才算攻防问题。

## 6. 当前验证基线（2026-08-20 实测）

| 项目 | 结果 |
|---|---|
| 全量测试 `npx vitest run` | ✅ **12 文件 / 92 测试全绿**（3s 内） |
| 生产构建 `npm run build` | ✅ 通过（tsc -b 无错 + vite build 853ms，主 JS 448 kB） |
| ESLint（src/game|review|knowledge|components|App.tsx） | ✅ 0 错误 0 警告 |
| 类型检查 | ✅ 无错误（此前 presentation.ts 僵尸导入 `recommendDingque` 已清理） |

> 注意：全仓 `npm run lint` 仍受**历史遗留** `src/utils/tracker.ts` 格式问题影响（旧代码，与本项目无关，不要顺手重构）。

## 7. 常用命令

```bash
npm run dev          # 本地开发
npx vitest run       # 全量测试（92）
npm run build        # 生产构建
npx eslint src/game src/review src/knowledge src/components src/App.tsx  # lint 核心领地
```

## 8. Codex 接手指南（下一步起点）

**最近一次会话中确认的计划**：M2 复盘引擎核心已完成，接下来是 **Trae 未做完的复盘页 UI**，以及此前排队中的移动端实机内测。建议顺序：

1. **复盘页 UI（M2 收尾）**：读 `src/review/types.ts` 的 `ReviewReport` 契约 → 在 `src/components/` 新建复盘页组件，渲染"2 个主要问题 + 1 个优秀决策 + 机会数趋势"，加"认可 / 不认可"按钮（PRD 12.3 要求）。输入：`analyzeGame(state.events)` 的输出。注意现有 `presentation.ts` 的 `buildGameReview` 是**简易版**（AI 对拍评级），与 `src/review/` 的智能版并存，接 UI 时优先用 `src/review/`。
2. **移动端实机内测**：修正不同屏幕的牌桌密度与触控细节（DEVELOPMENT_PROGRESS.md 下一步准确起点第 1 条）。
3. **Git 收尾**：`main` 分支已有本阶段基线 tag（见 git log），后续按里程碑提交。

**Codex 入场规则**：
- 改逻辑先跑 `npx vitest run`，改 UI 先 `npm run build`；
- 新增功能对照 `PRD.md` 里程碑，不要越界重构规则引擎；
- 理论相关问题查 `docs/theory/mahjong-theory-zhuyang.md` 与 `src/knowledge/mahjongTheory.ts` 的注释。

## 9. 已知边界与待办

- 🟡 复盘引擎只诊断无副露手牌（碰/杠后跳过，M4 补）；
- 🟡 复盘页 UI 未接（上一条 Codex 第一优先）；
- 🟡 训练题生成（M3）弹药已备未开工：可用 `brokenStrongCombos` / `classifyWaitShape` 出"拆错搭"题；
- ⬜ git 远端推送与 GitHub 开发分支（DEVELOPMENT_PROGRESS.md 下一步起点第 3 条）；
- ⬜ 两本书原文细节补全（微信读书 API 只拿到骨架 + 热门划线精华，详见理论文档第 7 节）。
