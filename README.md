# Typora Markdown (WYSIWYG)

一个 VS Code 扩展：把 Markdown 编辑器变成「Typora 式」的同标签页**实时排版所见即所得**编辑器。

在同一个标签页里直接排版、编辑、输入——不再需要像内置的 *Markdown Preview* 那样左右分栏预览，也不需要在“源码 ↔ 预览”之间来回切换。

![mode](https://img.shields.io/badge/mode-ir%20%2F%20wysiwyg-blue)
![version](https://img.shields.io/badge/version-0.1.0--beta.1-orange)
![license](https://img.shields.io/badge/license-MIT-green)

> **状态：Beta 预发布（`0.1.0-beta.1`）** —— 核心功能已可用，欢迎试用与反馈。
> 快速安装：到 [Releases](https://github.com/ZhaoRibo/TyporaMD/releases) 下载 `.vsix`（详见下文「安装」）。

---

## 功能一览

- **同标签实时排版（Typora 风格）**
  - 通过 VS Code 的 `CustomTextEditor` 在同一标签页内编辑，不另开预览栏。
  - 提供两种编辑形态（`typoraMd.mode` 配置，默认 `ir`）：
    - `ir`（即时渲染，推荐）：内容即时排版，行内 Markdown 符号（`**`、`` ` ``、链接括号等）在非当前行自动隐藏，光标所在行才显示标记——最接近 Typora，也最稳定。
    - `wysiwyg`（纯所见即所得）：编辑区几乎看不到 Markdown 源码符号。
  - 写入回同步：你在编辑区做的修改会以整个文档为粒度**自动回写到磁盘文件**（防抖、IME 中文输入安全），配合 `Cmd/Ctrl+S` 保存（或开启 `autoSave` 像 Typora 一样自动保存）。
- **排版主题**
  - 文档区**铺满整个编辑器宽度**（不再有狭窄的两侧留白），阅读与书写更接近 Typora 的观感。
  - 三档主题：`auto`（跟随 VS Code 当前配色自动切换明/暗）、`light`、`dark`；代码块语法高亮主题 `github` / `github-dark`。
  - 主题切换**实时生效**，无需重建编辑器。
  - 工具栏可一键隐藏（专注写作）。
- **内容能力（由 Vditor 提供）**
  - GFM：标题、加粗/斜体/删除线、列表/有序/任务列表、引用、分割线、链接、表格、行内代码、代码块（带语法高亮）、行内/块级 KaTeX 公式。
  - 支持中文 IME 输入（组合输入期间不会触发错误的回写）。
  - 同目录相对路径图片可直接显示；`Cmd/Ctrl+点击` 链接可打开文件/网址。
  - **粘贴图片自动存盘**：直接粘贴剪贴板里的图片，会自动保存到文档旁的目录（默认 `media/`，可配置），并在文档中插入相对路径引用——不会把超长的 base64 塞进文档。

---

## 关于“复用已有 Markdown 插件”的说明（需求 2）

最初设想是直接复用内置的 *Markdown Preview* 渲染，以减少代码量与体积。但“分栏/独立预览”与“**同标签页内直接编辑渲染结果**”本质上是冲突的：

- 内置 Markdown Preview 是**只读渲染**，跑在独立预览面板里，无法在同一标签页内做到“点击就能编辑那段内容”；
- Typora 的核心体验是“所见即所得的**可编辑渲染**”。

因此本项目选用 **Vditor（MIT 协议）** 作为编辑内核：Vditor 的 IR / WYSIWYG 模式本身就是“渲染后可编辑”的编辑器，能真正实现同标签页的 Typora 体验。

为了控制体积与性能开销，扩展做了一些“瘦身”：

- 只**内置（vendored）Vditor 必要资源**（语言、图标、KaTeX 字体、GitHub 代码高亮、内容主题等均已裁剪），不再在线拉取 CDN；
- 不引入 Node 运行时依赖，全部为静态前端资源，扩展激活开销小；
- 插件本体（扩展宿主逻辑）非常薄，绝大部分逻辑在 webview 内完成。

> 若你确实想使用内置 Markdown Preview，也可以直接 `Cmd/Ctrl+Shift+V` 预览——两者互不影响。

---

## 安装

### 方式一：下载发布包（推荐，普通用户）

1. 打开本仓库的 [Releases](https://github.com/ZhaoRibo/TyporaMD/releases) 页面；
2. 下载最新（预）发布里的 `typora-md-wysiwyg-0.1.0-beta.1.vsix`；
3. VS Code 中：`扩展` 视图右上角 `...` → **从 VSIX 安装…** → 选择该文件；
4. 若 VS Code 未自动重载，执行命令面板（`Cmd/Ctrl+Shift+P`）→ `Developer: Reload Window`。

命令行安装（可选）：`code --install-extension typora-md-wysiwyg-0.1.0-beta.1.vsix`

### 方式二：从源码自行构建

```bash
npm install
npm run compile                      # 编译 TS -> out/
npx vsce package --no-dependencies    # 生成 typora-md-wysiwyg-0.1.0-beta.1.vsix
```

再按上面的「从 VSIX 安装」步骤导入即可。构建需要 Node.js 18+ 与 VS Code ≥ 1.85。

> ⚠️ **安装 / 升级后，请确保窗口已完成重新加载。**
>
> VS Code 在安装 VSIX 后**通常会自动重新加载窗口**（扩展宿主重载后，新版扩展才生效）。
> 若**没有自动重载**，或打开 `.md` 出现 **空白页、界面卡住、反复弹出新标签** 等异常——这些多为
> **旧版扩展仍在运行**所致，并非功能 bug——请手动执行命令面板（`Cmd/Ctrl+Shift+P`）→
> `Developer: Reload Window`（或重启 VS Code），重载后即可恢复正常。
> 升级到新版本 VSIX 时同理：确保扩展宿主已重载到新代码再使用。

### 开发调试

```bash
npm run watch          # 监听编译
```

在 VS Code 中按 `F5`（Extension Development Host）即可调试。

---

## 使用

1. **自动打开**：默认（`typoraMd.autoOpen: true`）下，打开任意 `.md` / `.markdown` / `.mdown` / `.mkd` 文件会自动在同标签页以 WYSIWYG 视图打开。
2. **切换视图**
   - 资源管理器 / 编辑器标签右键 → `Typora: ...` 菜单；
   - 命令面板（`Cmd/Ctrl+Shift+P`）：
     - `Typora: Open Current File in WYSIWYG View` —— 当前文件切到 WYSIWYG 视图（快捷键 `Cmd/Ctrl+Shift+T`）；
     - `Typora: Reopen as Markdown Source` —— 切回普通源码编辑（此后该文件不会被自动打开成 WYSIWYG）。
3. **主题切换**：命令面板 `Typora: Switch Editor Theme`（循环 Auto → Light → Dark），或改 `typoraMd.theme` 配置；颜色主题改变时明暗也会实时跟随。
4. **插入图片**：直接**粘贴**剪贴板里的图片（截图等），扩展会自动把图片保存到文档旁的目录（默认 `media/`，可用 `typoraMd.imageDir` 修改），并在插入位置写入相对路径引用，例如 `![](media/image-20260915-153012.png)`。
5. **保存**：编辑会自动回写文档（文档会显示“未保存”标记，属正常现象）；`Cmd/Ctrl+S` 保存到磁盘。若想完全像 Typora 自动保存，开启 `typoraMd.autoSave`。

---

## 配置项


| 配置                   | 默认    | 说明                                          |
| ---------------------- | ------- | --------------------------------------------- |
| `typoraMd.autoOpen`    | `true`  | 打开 Markdown 文件时自动进入 WYSIWYG 视图     |
| `typoraMd.mode`        | `ir`    | 编辑形态：`ir`（即时渲染，推荐）/ `wysiwyg`   |
| `typoraMd.theme`       | `auto`  | 编辑器主题：`auto` / `light` / `dark`         |
| `typoraMd.codeTheme`   | `auto`  | 代码块高亮：`auto` / `github` / `github-dark` |
| `typoraMd.showToolbar` | `true`  | 是否显示顶部格式工具栏                        |
| `typoraMd.imageDir`    | `media` | 粘贴图片的保存目录（相对文档；`.` = 同目录）  |
| `typoraMd.autoSave`    | `false` | 每次回写后自动保存到磁盘                      |
| `typoraMd.syncDelayMs` | `250`   | 回写到文件的防抖毫秒数                        |

---

## 项目结构

```
TyporaMD/
├─ package.json          # 扩展清单：命令 / 菜单 / 配置 / 自定义编辑器
├─ tsconfig.json
├─ src/
│  ├─ extension.ts       # 激活、自动打开、命令、上下文菜单
│  └─ editor.ts          # CustomTextEditor 宿主：webview、CSP、回写、主题/配置/外部变更
├─ media/
│  ├─ main.js            # webview 前端：初始化 Vditor、回写、主题、IME、图片/链接、粘贴存盘、工具栏提示
│  ├─ wysiwyg.css        # 满宽纸面排版、明/暗主题、工具栏布局与悬停提示
│  └─ vditor/            # 内置的 Vditor 4（已裁剪，含 LICENSE）
└─ out/                  # 编译产物（tsc 输出，不纳入版本控制）
```

---

## 已知限制

- 工具栏没有独立的“插入图片”按钮（Vditor 4 的 `image` 工具已失效，已移除）；但**直接粘贴图片即可**——会自动保存到 `typoraMd.imageDir`（默认 `media/`）并插入相对路径。
- 仅支持**剪贴板图片**粘贴保存；暂不支持通过工具栏选择本地文件上传附件。
- 图片保存目录名建议不含空格（含空格时 Markdown 链接可能需转义）。
- `wysiwyg` 模式处于“可用但 IR 更成熟”的状态；默认 `ir` 体验最接近 Typora 且最稳定。
- 编辑区写入会以整个文档为单位规范化内容（例如统一行尾），与 Typora 行为一致；协作/多端同时修改时以最后一次写入为准。

---

## 反馈与贡献

- **问题 / 建议**：欢迎到 [Issues](https://github.com/ZhaoRibo/TyporaMD/issues) 反馈，请附上 VS Code 版本、扩展版本与复现步骤。
- **排障提示**：安装 / 升级 VSIX 后若出现**空白页、界面卡住、反复弹出新标签**等异常，先执行命令面板 →
  `Developer: Reload Window`；仍无法解决时，打开菜单「查看 → 输出」，在下拉框选择 **Typora Markdown** 查看诊断日志。

---

## 开源许可

- 本项目：**MIT**（见随包的 `LICENSE` 文件）。
- 内置内核 [Vditor](https://github.com/Vditor/vditor)：**MIT**（见随包的 `media/vditor/LICENSE` 文件）。
