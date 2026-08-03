---
name: big-screen-replica
description: 数据可视化大屏(指挥中心/监控大屏/运营驾驶舱)的复刻与创作,产出 Daimon Blueprint Widget 并放上 Dashboard。两种触发:(1) 复刻——用户提供大屏截图/设计稿,说"实现这个大屏""复刻/还原这个页面""照着图做";(2) 创作——用户没有图片,说"做一个数据大屏""生成指挥中心大屏""帮我搭个监控驾驶舱"。核心方法:region 裁剪精读原图(复刻)/ design-language 设计规范(创作)→ 固定设计稿舞台 + transform 等比缩放 → 真实地图 GeoJSON 转 SVG 内联 → 无头浏览器截图对比校验闭环。也适用于把已有大屏 HTML 改造为 Widget。
---

# Big Screen Replica(大屏复刻与创作)

把大屏参考图复刻成 Blueprint Widget,或在没有参考图时按设计规范创作大屏。目标:**先被一眼认出是同品类的大屏**,再谈适配与工程规范。

## 模式分支(先判定)

- **复刻模式**:用户提供了参考图 → 走下方"总流程",精读原图,像素级还原。
- **创作模式**:用户只有主题没有图 → 读 [references/design-language.md](references/design-language.md),按其"创作流程"执行:选骨架(A 指挥中心 / B 平台运营 / C 纯面板网格)→ 列面板清单 → 算高度预算 → 组装 → 截图校验。步骤 1(读图精读)替换为"确认主题与数据",步骤 2-6 相同。

## 总流程(按序执行)

1. **读图精读** — 全图 + region 裁剪,建立完整内容清单
2. **判定模式** — Object-led 复刻模式,加载 `widget` 与 `widgetdesign`(读 `object-fidelity.md`)
3. **备料** — 地图/图表等资产确定化(GeoJSON 脚本转换、数据照抄原图)
4. **写页面** — 固定设计稿舞台 + scale-to-fit 的单文件 `index.html`
5. **截图校验闭环** — 无头浏览器渲染,对比原图,修到无裁切无溢出(>=2 轮)
6. **上架** — Widget.create -> validate -> Canvas.create -> placeWidget -> 输出 daimon-canvas 块

## 1. 读图精读(复刻模式,不可跳过)

- 先把图片复制进工作目录再读,先看整图把握三栏/面板布局。
- 整图会被降采样,**小字必须 region 裁剪**:对顶部指标条、每个侧栏、每张底部分别裁原分辨率区域(`region` 参数,原始像素坐标)。至少裁 3-4 块。
- 产出一份清单再动手:面板划分与占比、每段文字标签、每个数值与单位、配色(背景/主色/警示色)、图表类型(进度条/堆叠条/表格/排名/地图飞线)。
- **数值照抄原图**作为示例数据,不要自编"更合理"的数。

## 2. 判定模式

有参考图 = Object-led 模式。用 `Skill` 工具加载 `widget`,再加载 `widgetdesign` 并读其 `references/object-fidelity.md`:保留品类骨架(深色科技底、发光标题、四角括号面板、数字字体),不套通用卡片模板。运行时契约仍遵守 `runtime-core.md`(语义标签、fit 硬约束)与 `daimon-runtime-integration.md`(无外部依赖、宿主安全区)。

## 3. 备料

- **地图**:下载真实 GeoJSON(省/市边界,如 DataV `https://geo.datav.aliyun.com/areas_v3/bound/<adcode>_full.json`),用 `scripts/geojson_to_svg.py` 投影成 SVG 路径 JSON,**内联**进 HTML(Widget 沙盒为 opaque origin,不能 fetch 第三方接口)。若参考图是 3D 俯视透视地图,用模式库的"压扁法"(形体组非均匀 scale),不要调投影参数硬凑。
- **图标/装饰**:纯 SVG/CSS 手绘,不用图标库、emoji、外部图片。

```bash
python scripts/geojson_to_svg.py input.json out.json --width 640 --height 520 --decimate 2
```

输出 `{ "地市名": { "d": "<svg path>", "cx": .., "cy": .. } }`,cx/cy 为中心点投影坐标,用于节点与标签定位。

## 4. 写页面(关键范式)

组件 CSS 片段见 [references/big-screen-patterns.md](references/big-screen-patterns.md);骨架选型、配色纪律、密度节奏见 [references/design-language.md](references/design-language.md)(创作模式必读,复刻模式补缺口)。核心原则:

- **固定设计稿舞台 + 等比缩放**:按原图像素(如 1749×982)写死 `.stage`,JS 计算 `s = 容器宽 / 设计宽`,`transform: scale(s)`,并把外层容器高度设为 `设计高 * s`(让宿主能量出内容高度)。ResizeObserver 监听。大屏的正确响应式是缩放,不是流式重排。
- **高度预算是最大坑**:`header + 指标条 + 主区` 的高度之和必须 <= 设计高。写完先心算每栏各面板高度总和,溢出在截图阶段才暴露会多花一轮。
- 覆盖在 SVG 上的 HTML 标签(如节点名牌)定位时,注意 getBoundingClientRect 是缩放后的屏幕坐标,换算回舞台坐标要除以舞台 s;`preserveAspectRatio="meet"` 的居中留白也要计入。
- 动画(飞线流动、节点呼吸)用 stroke-dashoffset/opacity,并包 `@media (prefers-reduced-motion: reduce)` 静态降级。
- 数字用窄体数字字体栈(`"Bahnschrift","DIN Alternate",sans-serif`),中文走系统字体栈;文字用语义标签(`h1/h2/output/table`)。
- 右上约 190×44px 是宿主控制区,不要放可交互内容;文字信息可左移避让。

## 5. 截图校验闭环(>=2 轮)

```bash
python scripts/render_shot.py index.html shot.png --width 1749 --height 982
```

脚本自动查找本机 Chrome/Edge 并无头截图。然后 `ReadMediaFile` 读回,与原图同视角对比,重点查:

- 整体/单栏溢出(底部被裁是最常见失败)
- 卡片、表格行文字裁切;数值超出容器
- 地图节点、飞线、覆盖标签错位
- 边缘:对顶条和底条各裁一块 region 复核

修一轮截一轮,直到无裁切无溢出。再补一张小尺寸(如 420×320)确认缩放后整体可读。

## 6. 上架

1. `Canvas(action="create", title="<2-8 字看板名>")`
2. `Widget(action="create", type="html", creationHints=[...])`,把 `index.html` 写到返回的 `workspaceRoot/index.html`
3. `Widget(action="validate")` 必须 `status: valid`
4. `Canvas(action="placeWidget", layout={mode:"grid",x:0,y:0,w:12,h:<按宽高比折算>})`;行高 44px,h ≈ (1092 × 设计高/设计宽 + 12) / 44 向上取整
5. 回复末尾输出 ` ```daimon-canvas ` 预览块(canvasId 用 create 返回值,禁止编造)

展示型复刻**不要**创建 Automation/Binding/slots/events。只有用户要求接真实数据时才再加数据任务。
