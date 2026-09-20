# 血战到底之破晓杀机 · 暂停状态书

> 最后更新：2026-09-20（打 tag `v0.2-pause` 时刻）
> 恢复方式：`git checkout v0.2-pause` 即精确回到此刻完整状态。

## 一、项目定位
把川麻博主「破晓哥」实战决策系统性萃取为学习体系 + majiang-ex「电子导师」。
- 代码工程：`/Users/daybreak/Desktop/960/majiang-ex`
- 产品名：「血战到底之破晓杀机」
- UI 命名铁律：禁「朱扬 / 潇老师 / 清照 / Experience」等来源字样，统一「破晓哥」；经验推理面板=敲破黑板；出牌助手=晓算一下。
- 线上：**https://poxiao-majiang-45266.app.workbuddy.host/**（旧链接 `5ecf54bb…app.workbuddy.link` 已失效）

## 二、已完成里程碑
- 破晓哥全量萃取收官：216 卡 / 36 规则入产品（单测全绿）。
- 邂逅麻将五合集批量萃取：621 决策卡入合并池；合并池 `ALL_XIAOSHI_CASES` = 破晓哥 216 + 邂逅 621 = **837**。
- 导师面板：每条建议挂相关实战案例（按 theme 取最多 2 条 + 溯源）。
- 赛中导师互动：异议 / 段位机制（`xiaoshiDissent.ts`，localStorage 持久化，段位 0/6/15/30/50）。
- 鸣牌与定缺口径定稿：非缺门牌任何时候可碰 / 明杠，缺门那门永久禁。

## 三、下一步里程碑（未决项，恢复后优先）
1. **规则沉淀**：`主题地图/rule-candidates.json` 有 41+11 条候选规则未入产品 → 落成可判定规则写进 `src/knowledge/xiaoshiAdvisor.ts` 的 `buildXiaoshiAdvice`。接新规则先跑 `__freq_probe.test.ts`。
2. **第二三萃取对象**：青山（71 条，重庆成麻换三张，落卡须标规则语境）、胡牌圣手（掼蛋+麻将混合，需甄别）。抖音采集需 Chrome 扫码登录（未登录只能抓推荐流，作者作品列表抓不到）。工具链见 `主题地图/抖音采集` 笔记。
3. **导师调优**：提高阈值 / 要求证据形状；跳过开局伪信号（弃牌 ≥ 12 张）。

## 四、已知坑（恢复时必看）
- 根 tsconfig 是 solution 型，`tsc --noEmit` 空跑 0 错，必须 `tsc -b` / `npm run build`。
- 发布：`vite.config.mts` 读 `process.env.PORT`；startCmd 用 `npm run dev`（包无 `start` 脚本）。遇「预留域名未绑定到本次发布环境」→ 先 `unpublish`（按目录）再 `createNewApp:true`（旧沙箱域名绑定会失效）。
- git 在沙箱里写 `.git` 会被静默拦截，commit / push 须 `dangerouslyDisableSandbox`；偶发 `.git/index.lock` 残留，`rm -f` 即可。
- 具体牌张决策须人工核对，宁缺毋滥；导师 = 风格镜像非唯一真理。

## 五、知识库与数据资产位置
- 决策卡 / 规则：`src/knowledge/`（xiaoshiCases / xiehouCases / xiaoshiKnowledge / xiaoshiTypes / Advisor）。
- 萃取工具链：`tools/`；抖音采集 `tools/douyin_grab.py` 等。
- 抖音 vault：`xiehou/vault/<id>/`（污染视频隔离 `_foreign/`）。
- 全部已提交 GitHub `git@github.com:daybreak320/majiang-ex.git`，无本地独占未提交资产。
