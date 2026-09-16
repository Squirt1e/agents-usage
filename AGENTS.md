# AGENTS.md — agents-usage 仓库规则

这里只写「每次改动都必须遵守、并且能被验证」的硬性规则。工程入口与命令见
[`docs/desktop/README.md`](docs/desktop/README.md)，功能规格与验收见
[`openspec/`](openspec/)。

规则按主题分节。新增规则时同样给出：规则本身、判定标准、由哪个测试守住。

---

## 1. 界面动效规则（强制）

**所有切换都必须有过渡动画，不允许瞬间跳变。** 包括但不限于：页面/视图切换、显示与隐藏、
宽高与展开收起、状态切换（选中、开关、激活、拖动、主题、加载完成）、数值变化（配额、余额、
进度、倒计时归零）以及悬停、按下、禁用这类反馈。

「切换」的定义是**同一块界面前后呈现不同状态**。只要用户能看到变化前后的两种样子，变化本身
就必须是运动，而不是一次剪切。适用范围是面板前端 `src/desktop/`（根上的 `panel.css`、
`settings.css` 与 `panel/`、`settings/`、`components/`、`lib/` 各子目录），以及任何新加的桌面界面。

### 1.1 三条实现路径（按切换的形态选一条）

| 形态 | 实现 | 例子 |
| --- | --- | --- |
| 同一个元素换状态 | 基础规则上的 `transition` | `.switch` 打开、按钮悬停、卡片状态色 |
| 元素带着新状态挂载 | `animation` + `@keyframes` | 换页后新页面入场、消息出现、毛玻璃蒙层的文字出现 |
| 宿主窗口的尺寸（CSS 动不了窗口） | 逐帧动画并上报宿主 | `src/desktop/panel/panel-height.ts` 的高度过渡 |

窗口尺寸是唯一由 JS 驱动的动效：宿主只能「设置」尺寸，所以高度按帧沿缓动曲线上报
（`PANEL_HEIGHT_ANIMATION_MS`），并且同样要遵守 `prefers-reduced-motion`——偏好减弱动效时
直接给出目标高度，不做逐帧过渡。

### 1.2 参数预算（超出即视为破坏一致的观感）

- 反馈类（颜色、边框、背景、透明度）：`150ms ease`。
- 位移与入场：`160–180ms`，缓动 `cubic-bezier(0.22, 0.8, 0.24, 1)` 或 `ease-out`。
- 数值与尺寸（进度条宽度、仪表弧长、窗口高度）：`200–260ms ease`。
- 面板整体淡入淡出：`260ms`，且必须小于宿主隐藏窗口前的等待（`PANEL_HIDE_ANIMATION_MS`）。
- 循环动画（如加载 spinner）不计入往返预算，但同样必须在减弱动效时关闭。
- 离散属性（`visibility`、`display`）不参与时长预算：它们无法插值，只会按给定的时间点「跳变」。
  把淡出的按钮移出 Tab 顺序的标准写法是同组里写 `visibility 0s linear 150ms`——运动由旁边的
  `opacity`/`transform` 承担，延迟只是这一步落地的时间。守卫按属性名识别这种写法。

### 1.3 禁止项

- **禁止 `transition: all`**：它会把布局属性一起拖进动画，而窗口高度正是从这些盒子的实际
  下边缘量出来的。
- **禁止对参与高度测量的属性做动画**（换页动画里的 `scale`、内容块的 `height` 等）。位移
  `translateX/translateY` 不会污染测量，`scale` 会——测量会在动画中途读到中间值并把窗口一起带走。
- **禁止在 `prefers-reduced-motion` 之外写 `transition: none` / `animation: none`**：那是把切换
  重新变回剪切，等于绕过本节规则。
- **禁止给「遮蔽占位数据的蒙层」做透明度入场，也禁止让遮挡依赖 `backdrop-filter`**
  （`.frost-hint`，即没有数据时盖住假数据的毛玻璃覆盖层）：
  - 首帧就必须完整——它盖住的正是卡片在无数据时回退的占位数值（GLM 的 28% / 16%、钱包 ¥42.60），
    任何入场（蒙层本身或它的文字）都在用整段时长展示它要藏的东西；
  - 遮挡必须由**普通 `filter` 施加在被遮内容上**（`.is-covered > :not(.frost-hint)` 的
    `filter: blur()`），因为 `backdrop-filter` 的背景采样会在蒙层随卡片入场动画一同挂载时被
    推迟甚至不发生——「从设置页切回总览」正是这个场景，采样没落地时只剩一层薄色，假数据清晰可读。
    普通 `filter` 与被遮内容一起绘制，不存在这个时间窗。
  - 组件侧必须正确标记：占位数据显示时给容器加 `is-covered`，显示真实数据（含缓存）时不加，
    否则真实读数会被当成假数据糊掉。
  由 `tests/panel-motion.test.ts`（a cover protects what it covers）与 `tests/panel-cover.test.tsx`
  （哪一块在什么时候被标记）共同守住。
  （同理：任何以「遮住某些内容」为目的的元素，其遮挡机制都不能依赖背景采样。）

### 1.4 减弱动效（reduced motion）

`prefers-reduced-motion: reduce` 下必须关闭全部动效：`panel.css` 末尾有一个 `!important` 的
`*` 兜底块统一关闭（`!important` 是必需的——一个裸 `*` 规则会输给文件里每一条类规则，而那些
类规则声明的正是这条兜底要移除的 transition）。JS 侧的窗口高度动画用
`window.matchMedia('(prefers-reduced-motion: reduce)')` 判断。

新增切换不需要单独写兜底块，但必须保证兜底能覆盖它（也就是说：动效只能通过
`transition`/`animation` 实现，不能靠 JS 在别处补间）。

### 1.5 登记与守卫

**新增任何一个切换点，必须同时在 [`tests/panel-motion.test.ts`](tests/panel-motion.test.ts) 的
注册表里登记它**（选择器 + 需要被覆盖的属性，或动画名）。守卫会检查：

- 注册表里的每个切换确实声明了 `transition`/`animation`，且属性被逐条覆盖；
- 全表时长都在 1.2 的预算内（循环动画除外），每个 `animation` 名字都有对应的 `@keyframes`；
- 没有 `transition: all`，没有在减弱动效之外静音动效；
- 减弱动效的兜底块存在且覆盖所有注册的切换。

登记表之外的例外必须写进守卫文件的例外表，并附上原因——**没有原因就没有例外**。

### 1.6 已知例外（已在守卫中登记）

- **主题切换**：两套配色是 CSS 变量，面板底色是线性渐变，而渐变不可插值；把整块面板做成
  交叉淡入需要 View Transitions（WebKit 支持版本参差）。当前是瞬时重绘，属于已知缺口。
- **拖动跟手**：被拖动行的位移由拖动代码逐帧写 `transform`，绝不能过渡，否则会拖在光标后面
  （只允许它的底色与阴影过渡）。
- **焦点环**：`:focus-visible` 的描边必须立即出现，动画会让键盘焦点看起来慢半拍。
- **纯文本替换**：数字、标签、文案的 DOM 文本换新没有可插值的属性。

---

## 2. 其它硬性规则

- **总览卡片不得自行增加连接错误内容**：未经用户明确授权，不得在平台卡片内追加连接错误框、
  接口原始错误文案、重试按钮或配置跳转入口。判定标准是连接失败前后卡片的指标布局不因错误详情
  改变，详情只能在卡片外的底部连接状态浮层或既有设置页查看；已有的指标过期标记、卡片配置
  图标和无数据遮蔽提示不属于新增错误入口。由 `tests/panel-connection-details.test.tsx` 与
  `tests/panel-width.test.ts` 守住。
- **颜色只能来自变量**：`panel.css` 不写硬编码颜色，由 `tests/panel-palette.test.ts` 守住；
  两套主题共用同一组变量。
- **注释解释「为什么」**：面板代码里的注释用于记录取舍与踩过的坑（动效部分尤其如此），不要
  写复述代码的注释。
- **改动后的验证**：`npm run typecheck`、`npm run lint`、`npm test`。涉及桌面面板样式或行为的
  改动必须跑 `npm test`；涉及 `crates/` 或 `src-tauri/` 还要跑 `npm run rust:test` 与
  `npm run rust:clippy`（见 `docs/desktop/README.md`）。
- **规格先行**：行为变化先进 `openspec/changes/`，实现与规格必须对得上；工程说明同步更新
  `docs/desktop/`。

---

## 3. 提交约定（强制）

**提交信息用中文**，标题固定为 `<type>(<scope>): 描述`，`scope` 可省略。判定标准：标题不超过
72 个字符；`type` 只取 `feat`、`fix`、`docs`、`style`、`refactor`、`perf`、`test`、`build`、
`ci`、`chore`、`revert`；描述必须含中文且结尾不加标点；git 自己生成的 `Merge`/`Revert` 标题
不受约束。示例：`feat(panel): 新增配额条过渡动画`。

钩子由 husky 提供：`pre-commit` 用 lint-staged 只检查暂存文件（`eslint --fix`），`commit-msg`
调用 `scripts/verify-commit-msg.mjs`。由 `tests/verify-commit-msg.test.ts` 守住——它直接执行钩子
所用的那条命令，并核对 `.husky/` 与 `package.json` 的接线是否还在。

**不入库的目录**：`openspec/`、`.superpowers/`、`.agents/`（openspec 技能说明）与
`docs/superpowers/`。它们只服务于本地规划，被 `.gitignore` 排除，但仍是规格与设计的来源；
根目录的 `.idea/` 与 `.theme-preview.html` 同样不入库。判定标准是 `git status` 不出现这些路径，
由 `.gitignore` 与 `tests/verify-commit-msg.test.ts` 所在仓库根演示的忽略列表体现。

---

## 4. 发版规则（强制）

- **版本号只有 `package.json` 一处**：`src-tauri/tauri.conf.json` 的 `version` 指向
  `../package.json`，打包时 Tauri 现读它；`Cargo.toml` 的 `[workspace.package] version` 必须与
  `package.json` 相同。判定标准是这两处接线不变、两个版本字符串相等，由
  `tests/release-pipeline.test.ts` 守住。
- **打包与发布交给 GitHub**：`main` 的推送触发 `.github/workflows/release.yml`——先判断这个
  版本发过没有（`v<version>` 的 tag 或 release 存在就算发过），没发过才打 universal dmg 并用
  仓库里那份已提交的正文建 release，发过就只跑门禁；本地不再手工打包上传。**同一个版本只打一次包**，
  已发出的资产不再替换，所以 dmg 与它 tag 指向的提交是同一份代码。判定标准是触发时机、版本号来源、
  打包目标、只打一次、已发出的资产不再变动这五条接线，由 `tests/release-pipeline.test.ts` 守住。
- **release 正文随版本号提交在仓库里**：正文写成 `docs/release-notes/v<version>.md`，与该版本的
  版本号在同一条提交里，骨架沿用 `docs/release-notes/TEMPLATE.md`；「这个版本里有什么」只写一句话，
  从用户视角说这个版本与上一个版本的区别，不列提交。流水线只把这份已提交的正文贴上去并直接发布，
  不生成正文、不留 draft、不碰已发出去的 release；正文里不写校验和（资产页上的 SHA-256 由
  GitHub 现算）。判定标准是正文文件存在且骨架与模板一致、工作流里既不出现生成正文的命令
  （`--generate-notes`）也不出现替换资产或改写已发 release 的命令，由上面那条测试守住。
