# 大屏复刻模式库

复刻深色科技风大屏时常用的结构与 CSS 片段。按参考图选用,不要无脑全用 —— 参考图没有的装饰不要加。

## 目录

- 舞台缩放骨架(JS)
- 背景(径向辉光 + 网格)
- 标题头(发光渐变字 + 翼线 + 下划光带)
- 四角括号面板 + 斜切标题栏
- 指标卡(图标 + 发光数字)
- 进度条 / 四色堆叠条
- 排名条(段式虚线条)
- 地图飞线与节点脉冲
- 配色令牌
- 高度预算与排错表

## 舞台缩放骨架

```html
<div class="viewport" id="viewport"><div class="stage" id="stage">...1749x982 设计稿...</div></div>
<script>
var DW = 1749, DH = 982;
var viewport = document.getElementById("viewport"), stage = document.getElementById("stage");
function fit() {
  var s = (viewport.clientWidth || DW) / DW;
  stage.style.transform = "scale(" + s + ")";
  viewport.style.height = Math.round(DH * s) + "px";
}
fit();
if (window.ResizeObserver) new ResizeObserver(fit).observe(viewport);
window.addEventListener("resize", fit);
</script>
```

```css
.viewport { width:100%; position:relative; overflow:hidden; }
.stage { position:absolute; left:0; top:0; width:1749px; height:982px; transform-origin:0 0; }
```

## 背景

```css
background:
  radial-gradient(1200px 500px at 50% -10%, rgba(30,80,200,.28), transparent 60%),
  radial-gradient(900px 600px at 85% 110%, rgba(16,60,160,.22), transparent 60%),
  linear-gradient(180deg,#04102e 0%,#030a20 55%,#02071a 100%);
/* 网格层:44px 双线,透明度 .05 */
```

## 标题头

- 主标题:40px/800/字距 6px,`background:linear-gradient(180deg,#eaf6ff 20%,#7fc4ff 85%)` + `background-clip:text` 透明字,`text-shadow:0 0 24px rgba(60,150,255,.35)`。
- 翼线:标题两侧 300px×2px 渐变线,`skewY(±4deg)`。
- 下划光带:560px 宽,中心亮两边透明的 2px 线 + 中心径向光斑(blur 2px)。
- 右上:时钟(每秒刷新)+ 副标语;**离右缘 >=190px** 避让宿主控件。

## 四角括号面板

```css
.panel { position:relative; background:linear-gradient(180deg, rgba(14,38,96,.5), rgba(6,16,44,.42));
  border:1px solid rgba(58,120,230,.2); }
/* 用 ::before/::after + 内部 <i class="ck"> 的 ::before/::after 画四角 14px 直角括号,2px #3fb4ff */
```

斜切标题栏:16px 标题,`clip-path:polygon(0 0,100% 0,calc(100% - 12px) 100%,0 100%)`,左侧 4px 发光竖条。

## 指标卡

- 卡:半透明蓝渐变 + 1px 蓝边 + 左侧 2px 竖光线。
- 数字:22-32px `.num` 字体栈,`#37e0ff`,`text-shadow:0 0 12px rgba(55,224,255,.45)`;单位用 `<small>` 降字号降透明度。
- 警示卡换橙:`#ff9d5c` + 同色辉光。
- 图标:52px 内联手绘 SVG(等距立方体/芯片/盾牌),`filter:drop-shadow(0 0 8px rgba(60,180,255,.55))`。
- **宽度估算**:卡内容宽 = (设计宽 - 边距 - 间距)/卡数 - 图标 - padding;数字按 0.55em/字符估算,不够就降字号到 22px 或让标签两行。

## 进度条 / 堆叠条

- 进度条:6px 圆角,底 `rgba(60,110,220,.18)`,填充 `linear-gradient(90deg,#1d6cff,#39d6ff)` + 辉光;右侧百分比徽章(1px 蓝边框小方块)。
- 四色堆叠条(地市状态):8px 高 flex 分段,优秀 `#2ee6a8` / 良好 `#2b9bff` / 较差 `#ff4d5e` / 无数据 `#5b6b85`;条上方右侧对齐四色计数。

## 排名条

段式虚线条:`background:repeating-linear-gradient(90deg,#37c8ff 0 6px,transparent 6px 9px)`,宽按分数百分比。TOP1-3 徽章实心蓝渐变,TOP4-5 半透明。

## 地图飞线与节点脉冲

```css
@keyframes flymove { to { stroke-dashoffset:-40 } }
.fly { animation:flymove 1.6s linear infinite; }   /* stroke-dasharray:5 5 */
@keyframes nodepulse { 0%,100%{opacity:.9} 50%{opacity:.5} }
.pulse { animation:nodepulse 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .fly,.pulse { animation:none !important; } }
```

飞线:二次贝塞尔 `M 起点 Q 控制点 终点`,控制点取中点向弧外偏 26-46px;主线路可换红/青双色。节点:外圈 7px 25% 透明光晕 + 内圈 3px 实心。

覆盖在 SVG 上的 HTML 标签定位(舞台坐标系):

```js
var s = viewport.clientWidth / DW;                    // 舞台缩放
var k = Math.min(r.width / vbW, r.height / vbH);      // viewBox -> 屏幕 px
var offX = (r.left - wrapR.left) / s;                 // svg 元素在舞台中的偏移
var innerX = (r.width / s - vbW * k) / 2;             // meet 居中留白
tag.style.left = (offX + innerX + px * k) + "px";     // px 为 viewBox 坐标
```

### 3D 透视地图(压扁法)

参考图的地图是倾斜俯视的 3D 透视(常见于数据大屏),真实 GeoJSON 正视投影会比原图"瘦高"。**不要**为了拉宽去调 geojson_to_svg 的宽高参数(区域纵横比固定,只会更糟);正确做法是对地图形体做非均匀缩放:

```js
var SX = 1.75, SY = 0.92, CCX = 600, CCY = 230;      // sx>sy,绕 viewBox 中心
var gT = el("g", { transform:
  "translate(" + CCX + "," + CCY + ") scale(" + SX + "," + SY + ") translate(" + (-CCX) + "," + (-CCY) + ")" }, svg);
// 行政区路径(含 translate(0,14) 的深色挤出副本)全部画进 gT
function tx(x) { return CCX + (x - CCX) * SX; }       // 锚点坐标换算
function ty(y) { return CCY + (y - CCY) * SY; }
```

三条规则:

1. **只有地图形体进缩放组**(行政路径 + 挤出副本);节点光柱、光点、飞线、文字标签一律在组外用 `tx()/ty()` 换算后的锚点画,否则文字会被横向拉伸变形。
2. 描边宽度会随缩放失真(x 向变粗),可接受;要求高时在路径上加 `vector-effect="non-scaling-stroke"`。
3. 挤出副本的偏移 `translate(0,14)` 放在缩放组内层,实际垂直偏移 = 14 × SY。
4. 俯视感配色:顶面深色填充 + 亮边,挤出层更深(`rgba(8,20,52,.9)`),高光区县用纵向渐变填充。

## 配色令牌(深色科技蓝)

| 用途 | 值 |
|---|---|
| 深底 | `#04102e / #030a20 / #02071a` |
| 主青(数字/高亮) | `#37e0ff` |
| 主蓝(线条/填充) | `#2b8bff / #1d6cff` |
| 正文 | `#cfe3ff`,次级 `#8fb4e4`,弱 `#7ea6d8` |
| 成功/优秀 | `#2ee6a8`;安全分 `#2ee6c8` |
| 警示 | `#ff9d5c / #ffb84d`;危险 `#ff4d5e` |
| 无数据 | `#5b6b85`,占位文字 `#5f7ba6` |

## 高度预算与排错表

**预算**:各栏面板高度之和 + 间距 <= 主区高;`header + 指标条 + 主区` <= 设计高。先心算再写码。

| 症状 | 原因 | 修法 |
|---|---|---|
| 底部面板/表格行被裁 | 高度总和超设计高 | 压缩 td/行 padding、降次要面板固定高、减栏间距 |
| 指标卡数字/标签裁切 | 字号相对卡宽过大 | 降到 22px、图标 52→44、标签两行 |
| 覆盖标签跑偏 | 屏幕坐标当舞台坐标用 | 全部除以舞台 s,计入 meet 留白(见上) |
| 地图比原图"瘦高"、不像 3D | 参考图是俯视透视,正视投影纵横比固定 | 形体组 scale(sx>sy) 压扁,标签/光柱用 tx/ty 换算后组外画(见"3D 透视地图") |
| 透视后地图文字被拉宽 | 文字画进了缩放组 | 文字/标签移出缩放组,锚点过 tx/ty |
| 小尺寸看不清 | 正常,缩放特性 | 确认 420px 宽时整体结构可读即可,不做流式重排 |
| 时钟/图标被宿主控件遮挡 | 右上安全区 | 内容左移,离右缘 >=190px |
