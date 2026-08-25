# STORY.md - 朱扬麻将理论精华 PPT

## ① 用户意图对齐

- **目标受众**：破晓本人，偶尔打牌娱乐的程序员，正在开发麻将复盘软件。非专业选手，需要把理论术语"翻译"成能理解的语言。
- **核心目标**：看完后理解朱扬两本书的核心理论（机会数/强组合/攻防/番种），并知道这些理论已经在他的 majiang-ex 项目里落地成了代码。
- **PPT 长度**：16 页（封面 + 目录 + 4 章×3-4 页 + 结束页）
- **视觉调性**：麻将质感、暖色教学、图文并茂、浅色易读
- **内容边界**：必讲——机会数定义与计算、强组合辐射原理、四人抬轿vs7张无听、踩线、放飞鸽；不讲——血战到底完整规则（已在 PRD）、副露后评估（M4 未做）

## ② 页面布局骨架

**页面总数与分章**：16 页，4 章 + 封面/目录/结束。

| 章节 | 页码 | 章节扉页 |
|---|---|---|
| 封面 + 目录 | 01-02 | — |
| 第一章 机会数理论 | 03-06 | P03（扉页） |
| 第二章 组合秘籍 | 07-09 | P07（扉页） |
| 第三章 攻防战术 | 10-12 | P10（扉页） |
| 第四章 实战速查 | 13-16 | P13（扉页） |

**目录↔章节扉页契约**：目录 P02 声明 4 个章节 → 全篇有且仅有 4 个 section 扉页（P03/P07/P10/P13），编号 01-04 连续，逐字对应。

**Hero 页定位**：P01（封面）、P05（机会数计算公式 Hero）、P08（强组合辐射图 Hero）、P15（落地状态 Hero）、P16（结束页 Hero）= 5/16 = 31%。任意两个 Hero 间至少间隔 1 个 Supporting。✓

**rhythm 曲线**：
- P01 peak / P02 valley / P03 transition / P04 valley / P05 peak / P06 valley
- P07 transition / P08 peak / P09 valley
- P10 transition / P11 valley / P12 valley
- P13 transition / P14 valley / P15 peak / P16 peak

P11-P12 连续 2 个 valley → P13 用 transition 打破 ✓（无连续 ≥ 3 valley）

**非对称版式预算**：P04/P05/P08/P09/P11/P12/P15 = 7/16 = 44% ≥ 40% ✓
**对称版式预算**：P02（目录N卡片）、P06（图表+洞察）= 2 页 ✓

## ③ 页面大纲

| # | 文件 | 类型 | 角色 | rhythm | 版式 | visual | visual_role | density | anti_pattern | description |
|---|---|---|---|---|---|---|---|---|---|---|
| 01 | 01_cover | cover | hero | peak | 全幅视觉+骑线文字 | L1: SVG tile pattern | atmosphere | 30字/图1/留白35% | 禁止纯色块占位 | 朱扬两本书理论精华，麻将教学知识卡 |
| 02 | 02_catalog | catalog | supporting | valley | N卡片横排 | L3: chapter icons | — | 120字/0图/留白25% | 禁止每项<30字 | 四大章节导览：机会数/组合秘籍/攻防战术/实战速查 |
| 03 | 03_section1 | section | transition | transition | 全屏视觉+大标题 | L1: SVG 大字"机会数" | atmosphere | 30字/1图/留白40% | 禁止四卡片预览 | 第一章：机会数——快速听牌的量化武器 |
| 04 | 04_xiating | content | supporting | valley | 非对称双栏 | L1: SVG tile progression diagram | anchor | 220字/1图/留白25% | 禁止50:50等分双栏 | 什么是"下听"？用牌例从13张→听牌的演变图解释术语，打破认知障碍 |
| 05 | 05_formula | content | hero | peak | 巨型数字+洞察 | L1: SVG formula breakdown + tiles | anchor | 200字/1图/留白30% | 禁止等宽卡片横排；禁止数字塞进角落 | 机会数公式 10×4−4=36 逐步拆解：进张种类×4−已见张数，配牌例推导 |
| 06 | 06_benchmark | content | supporting | valley | 图表+洞察 | Chart: SVG bar comparison | evidence | 180字/1图/留白25% | — | 机会数基准值表：单吊3/间张4/两头听8/三面听11/24易听，配可视化柱状对比 |
| 07 | 07_section2 | section | transition | transition | 全屏视觉+大标题 | L1: SVG 大字"组合" | atmosphere | 30字/1图/留白40% | 禁止铺满正文段落 | 第二章：两张牌的辐射力——27/37/38为什么不能拆 |
| 08 | 08_radiation | content | hero | peak | 左大图+右侧文字 | L1: SVG radiation diagram (2+7 covers 1-9) | anchor | 250字/1图/留白20% | 禁止50:50等分；禁止图缩到200×70 | 为什么27/37/38最强？用辐射图展示2+7如何连接1-9全部数字，展开解释"辐射"含义 |
| 09 | 09_patterns | content | supporting | valley | 上下分栏 | L1: SVG two patterns side-by-side | evidence | 280字/1图/留白20% | — | 四人抬轿vs7张无听：两个7张牌型对比图解，展开解释"挨张"术语和形成秘籍 |
| 10 | 10_section3 | section | transition | transition | 全屏视觉+大标题 | L1: SVG 大字"攻防" | atmosphere | 30字/1图/留白40% | 禁止四卡片预览 | 第三章：开局到尾盘的生存法则 |
| 11 | 11_caixian | content | supporting | valley | 非对称双栏 | L1: SVG line diagram (147/258/369) | anchor | 240字/1图/留白25% | 禁止等宽四卡 | 踩线是什么？147/258/369三条线的可视化图解，解释为什么同线牌互相安全 |
| 12 | 12_tactics | content | supporting | valley | 左标题+右内容 | L1: SVG tactical tile examples | evidence | 260字/1图/留白20% | — | 腾挪/放飞鸽/欺骗战术：每种战术配具体牌例图示，解释何时用怎么用 |
| 13 | 13_section4 | section | transition | transition | 全屏视觉+大标题 | L1: SVG 大字"实战" | atmosphere | 30字/1图/留白40% | 禁止铺满正文 | 第四章：把理论变成决策 |
| 14 | 14_fan | content | supporting | valley | 图表+洞察 | Table: fan strategy | evidence | 200字/1表/留白25% | — | 番种策略速查表：7种番种打法要点一表看清 |
| 15 | 15_landing | content | hero | peak | 巨型数字+洞察 | L1: SVG status board | anchor | 220字/1图/留白25% | 禁止等宽卡片横排 | 理论→代码落地状态：6项已实现+2项待做，配实现路径标注 |
| 16 | 16_ending | ending | hero | peak | 居中金句/巨型数字 | L1: SVG decorative ending | atmosphere | 30字/1图/留白40% | — | 收束金句："数着进张打牌"——从凭手感变成有理论的决策 |
