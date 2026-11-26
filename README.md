# ComfyUI 工作流插件 · comfy_runner

把 **ComfyUI 的 API 工作流**导入 PromptStudio，在右侧工具栏里直接改提示词、出图、出视频——
不用切回 ComfyUI 的网页。

- 导入 ComfyUI「导出（API）」的 json，插件**自动找出**该改哪儿：提示词、负向、分辨率/像素/比例、时长、模型、LoRA、参考图槽。
- 面板里只填你关心的：提示词、负向、分辨率（预设 / 宽高 / MP 像素 / 比例键）、时长、种子；步数、采样器、其余参数**沿用工作流原值**。
- 生成结果直接在面板里看（图片点开大图、视频带播放条），可「存为参考图」回到 PromptStudio 继续用。
- 改过的模型 / LoRA / 分辨率 / 时长 / 种子可以**写回这份工作流**，下次打开还在。

## 安装

两种装法任选其一：

**装 zip（推荐）**：从本仓库 [Releases](../../releases) 下载
`prompt-studio-plugin-comfy_runner-<版本>.zip` → 打开 PromptStudio →「设置」→ 插件卡片 →
「安装插件 (zip)」选中它 → 回到插件列表点「信任并加载」。

**放文件夹**：把整个 `comfy_runner\` 目录拷进 PromptStudio 的 `plugins\` 下
（安装版默认 `%LOCALAPPDATA%\Programs\PromptStudio\plugins\`），重启程序后在设置里点「信任并加载」。

前置条件：本机 ComfyUI 正在运行（默认 `http://127.0.0.1:8188`）。地址在
「设置 → 插件 → ComfyUI 工作流 → ComfyUI 地址」里改，面板右上角的圆点变绿就是连上了。

## 用法

1. **导入工作流**：ComfyUI 菜单 → 工作流 → **导出（API）**，把得到的 json 拖进插件「导入工作流」页
   （或点选文件、或把 json 文本粘进框里）。非 API 格式（UI 格式）会提示你先导出 API。
2. **看一眼识别结果**：页面会列出类型（图片/视频）、节点数、提示词→哪个字段、分辨率→哪个节点、时长→哪个字段。
   认错了就在下拉里改选，然后「保存这个工作流」。
3. **生成**：回到「生成」页，选工作流 → 写提示词（四个按钮可从 PromptStudio 一键带过来：
   取描述 / 取结果 / 取历史 / 负向提示词）→ 调分辨率/时长/种子 → 点「生成」。
4. **看结果**：完成后面板里直接显示；产物同时落盘在
   `data\plugins\comfy_runner\out\<prompt_id>\`。
5. **保存改动**（可选）：改完模型/LoRA/分辨率后点「保存这些改动」，或勾「生成后自动保存」——
   会写回 `data\plugins\comfy_runner\wf\<id>.json`，下次生成仍用新值。自动保存不会覆盖提示词。

## 它能认出什么

| 项目 | 规则 |
| --- | --- |
| 任务模式 | 优先读 MiniMax 导演台节点的 `task_type`（t2v / i2v / fl2v / r2v / v2v / rv2v / mixed），没有导演台时按参考图数量推断 |
| 提示词 | 文本类字段（text / prompt / value / global_prompt …），也认复合节点里 JSON 串中的 `segments[N].prompt`，面板会显示「将写入：节点.字段 › 路径」 |
| 负向 | `negative_prompt` 等负向字段，或沿负向连线找到的编码节点 |
| 分辨率 | 空 latent 节点的 width/height → 任意带 width/height 的节点 → `ResolutionSelector`（比例 + 百万像素）→ 都没有就给一个可改的「虚拟分辨率」（改它会在每张参考图后自动插一个 ImageScale） |
| 时长 | `length` / `total_frames` / `num_frames` + `frame_rate` / `fps`，换算成秒 |
| 模型 / LoRA | 扫 `unet_name` / `ckpt_name` / `clip_name` / `vae_name` / `lora_name` 等字段；ComfyUI 开着时点「从 ComfyUI 拉模型列表」可下拉选真实文件 |
| 参考图槽 | 沿导演台的 `i2v_groups` / `r2v_groups` → GroupsCombine → 分组节点，识别首帧/尾帧/参考图槽；空槽在生成时按上传顺序自动新建 LoadImage |

## 被开关挡住的字段怎么办

有些工作流把提示词或 latent 接在 `ComfySwitchNode` 上（比如 Qwen-Image-2.1 编辑模板默认走「按参考图尺寸」）。
插件会认出这种接法，生成时**自动把开关切到你的值那一路**，并在面板上提示一句；不想让它自动切，就在 ComfyUI 里改接线后重新导出。

## 文件

| 文件 | 说明 |
| --- | --- |
| `plugin.json` | 插件声明：id `comfy_runner`、设置项（ComfyUI 地址 / 轮询间隔 / 默认负向）、`web.mount = sidebar` |
| `plugin.py` | 检测器 + 路由 `import / workflows / detail / save / delete / run / status / view / ping / options / persist` |
| `web/panel.js` | 右侧工具栏面板：导入页 + 生成页（分辨率/像素/比例、参考图槽、模型、LoRA、结果区、保存） |
| `web/panel.css` | 面板样式，只用宿主 CSS 变量（`--bg/--bg2/--line/--fg/--fg2/--acc`） |

运行时数据都在 PromptStudio 的 `data\plugins\comfy_runner\` 下：`wf\` 存导入的工作流、`out\` 存产物、`index.json` 是清单。

## 许可

本插件随 PromptStudio 一起使用，遵循仓库根目录的 [LICENSE](LICENSE)（PromptStudio License 1.0，非商业）：
个人学习研究、自用修改、装到自己的 PromptStudio 里都行；**除作者外不可商用**。
