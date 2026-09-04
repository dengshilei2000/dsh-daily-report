# dsh-daily-report · 日报助手

DeepSeek Harness（DSH Web GUI）的日报助手插件：**上午素材 / 下午素材**两个输入框，生成 Word 日报并通过钉钉发送。

- **今日完成工作**：分 1. 2. 3. 点，按上传的文档 / 源代码 / 会议纪要分类归纳
- **明日计划**：分 1. 2. 3. 点，逐条对应今日完成工作拓展
- **感悟总结**：一段连贯、充实的文字（不分点）
- 每框可上传文档（.docx/.txt/.md 等）或源代码文件夹压缩包（.zip，单个 ≤100MB），上传后自动解析文本并入日报生成
- 生成后可直接下载 Word 文档，或填写钉钉好友姓名发送附件
- 内置 **MCP Server**（Streamable HTTP）：`generate_report` / `get_report` / `list_reports` / `send_report` 四个工具，供 Claude Desktop、Cursor、DSH 的 `dsh-mcp-client` 等外部 MCP 客户端调用

## 安装

### 方式一：本地目录安装（推荐，便于后续改代码）

**Windows（PowerShell）**——`link:` 解析不了含空格的路径，请克隆到无空格目录；`$PWD` 会自动取当前目录，无需手写具体路径：

```powershell
# 克隆到任意无空格路径（例如 D:\dsh-daily-report，不要在带空格的目录下操作）
git clone https://github.com/dengshilei2000/dsh-daily-report.git
cd dsh-daily-report
npm install   # 安装运行时依赖（MCP SDK、zod）；link: 安装不会自动装依赖
dsh plugin --profile web add "link:$PWD"
dsh web   # 重启后生效
```

**macOS / Linux（bash）**：

```bash
git clone https://github.com/dengshilei2000/dsh-daily-report.git
cd dsh-daily-report
npm install   # 安装运行时依赖（MCP SDK、zod）
dsh plugin --profile web add "link:$(pwd)"
dsh web   # 重启后生效
```

> `$PWD`（PowerShell）与 `$(pwd)`（bash）都会自动展开为当前目录，命令里无需写死具体路径；唯一要求是当前目录路径不含空格（Windows 尤其注意，例如不要克隆到 `C:\Users\张三 lee\...` 这类目录）。

### 方式二：tarball 安装（分发给他人，无需对方克隆仓库）

```bash
# 在仓库目录内打包（生成 dsh-daily-report-<版本>.tgz，例如 0.2.0）
cd dsh-daily-report
npm pack
```

安装方拿到 `dsh-daily-report-0.2.0.tgz` 后（`dsh plugin` 内部走 pnpm，`file:` 安装会**自动安装插件依赖**，无需手动 `npm install`）：

```powershell
# Windows（PowerShell，$PWD 自动取当前目录，路径需无空格）
dsh plugin --profile web add "file:$PWD\dsh-daily-report-0.2.0.tgz"
```

```bash
# macOS / Linux（bash）
dsh plugin --profile web add "file:$(pwd)/dsh-daily-report-0.2.0.tgz"
```

### 安装后

重启 DSH（`dsh web`）使插件加载。刷新页面后：

- 侧栏底部出现「日报助手」入口（左侧品牌蓝竖条 + 文档图标）
- 页面右下角出现蓝色圆形悬浮按钮

点击任一入口即可打开日报面板。

## 使用

1. 在「上午素材」「下午素材」框内粘贴内容（学习文档、代码、会议纪要可混合），或上传文档 / 源码 zip
2. 点击「生成 Word 日报」→ 自动调用当前模型生成三栏内容并构建 `.docx`
3. （可选）填写钉钉好友姓名，点击「发送到钉钉」→ 插件唯一解析好友后发送附件

**后台运行**：上传文件、生成日报、发送到钉钉的过程中都可以随时点 ×（或点遮罩）关闭面板回到 Web 界面——任务会在后台继续，不会中断。此时右下角悬浮按钮上方会显示一个进度胶囊（转圈 + 当前状态）；任务在面板关闭期间完成后胶囊变绿（如「✓ 日报已生成，点击查看」），点击即可回到面板查看结果 / 下载 / 发送。若在生成中直接关闭浏览器标签页，任务仍会在 DSH 端完成（docx 已落盘，reportId 保留在内存账本，可通过 MCP `list_reports` 找回）。

> 生成日报会消耗模型 API 额度。钉钉发送依赖本机 `dws` CLI（钉钉工作台命令行）可用。

## MCP Server（外部客户端接入）

插件在 DSH Web 进程内暴露一个 **Streamable HTTP** 的 MCP 端点（无状态、无额外端口、仅本机回环）：

```
http://127.0.0.1:<DSH Web 端口>/api/daily-report/mcp
```

例如 DSH Web 运行在 `127.0.0.1:3080` 时，端点为 `http://127.0.0.1:3080/api/daily-report/mcp`。

### 工具

| 工具 | 说明 |
|---|---|
| `generate_report` | 传入 `morningMaterials` / `afternoonMaterials`（至少一项）→ 调用当前 DSH 模型生成三栏正文并保存 `.docx`；返回 `reportId`、三段正文、文件相对路径与 `downloadBase64` |
| `get_report` | 按 `reportId` 读取已生成日报的正文与文件信息 |
| `list_reports` | 列出本次 DSH 进程内已生成的日报（`reportId` + 日期 + 路径） |
| `send_report` | 把已生成的日报 `.docx` 作为附件发送给钉钉好友（`reportId` + `recipient` 姓名，唯一匹配，歧义时停止） |

> MCP 与 Web 面板共享同一内存账本：通过 MCP 生成的日报可以用面板发送，反之亦然。

### 客户端配置示例

**DSH 自身（`cordis.yml` 加入一行）：**

```yaml
- id: mcp-daily-report
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: daily-report
    transport: streamable-http
    url: http://127.0.0.1:3080/api/daily-report/mcp
```

模型将看到 `mcp__daily-report__generate_report` 等工具。

**Claude Desktop（`claude_desktop_config.json`）：**

```json
{
  "mcpServers": {
    "daily-report": {
      "type": "http",
      "url": "http://127.0.0.1:3080/api/daily-report/mcp"
    }
  }
}
```

**Cursor（项目级 `.mcp.json`）：**

```json
{
  "mcpServers": {
    "daily-report": {
      "type": "http",
      "url": "http://127.0.0.1:3080/api/daily-report/mcp"
    }
  }
}
```

### 独立 stdio 模式（无需 DSH，Codex / Claude Code / Cursor CLI 可用）

插件另提供一个**独立 stdio 进程** `lib/mcp-standalone.js`，不依赖 DSH 进程运行：模型直连 DeepSeek API，docx 直接写盘，钉钉仍走本机 `dws`。四个工具与内嵌 HTTP 版完全一致（同一套实现，只换 transport 与上下文适配）。

**环境变量：**

| 变量 | 说明 |
|---|---|
| `DAILY_REPORT_API_KEY` | DeepSeek API Key（缺省回退 `DEEPSEEK_API_KEY`）；`generate_report` 必需 |
| `DAILY_REPORT_API_BASE` | OpenAI 兼容 base URL，默认 `https://api.deepseek.com` |
| `DAILY_REPORT_MODEL` | 模型名，默认 `deepseek-chat` |
| `DAILY_REPORT_WORKDIR` | `daily-reports/` 写入目录，默认进程 cwd |

**Codex CLI（`~/.codex/config.toml`）：**

```toml
[mcp_servers.daily-report]
command = "node"
args = ["<插件绝对路径>/lib/mcp-standalone.js"]

[mcp_servers.daily-report.env]
DAILY_REPORT_API_KEY = "sk-..."   # 或直接在 shell 环境里导出 DEEPSEEK_API_KEY
DAILY_REPORT_MODEL = "deepseek-chat"
```

重启 Codex 后即可在对话中调用 `generate_report` 等工具（无需启动 DSH）。

**其他 stdio 客户端**（Claude Code、Cursor CLI 等）同样适用，把 `command`/`args` 指到该脚本即可；`npm install -g .` 之后可直接用 bin 名 `dsh-daily-report-mcp`。

**验证：** `node standalone-smoke-test.mjs`（mock API + stdio 全链路，9 项断言，无需真实 Key / DSH）。

### 注意事项

- **重启即清账**：`outputs` 账本是进程内存。重启 DSH 后历史 `.docx` 仍在磁盘（`daily-reports/`），但 `reportId` 全部失效，需重新 `generate_report`。
- **生成消耗模型额度**：`generate_report` 走 DSH 当前选中的模型，消耗 API 额度。
- **仅限本机**：端点绑定在 DSH Web 的回环地址上，未做鉴权。不要把 DSH Web 绑定到 `0.0.0.0` 后暴露给不可信网络。
- **依赖 `dws`**：`send_report` 依赖本机 `dws` CLI 可用。

## 卸载

```bash
dsh plugin --profile web remove dsh-daily-report
```

## 目录结构

```
dsh-daily-report/
├── package.json          # 插件元数据（bundle patch + client 声明 + MCP SDK 依赖 + bin）
├── cordis.patch.yml      # 组合补丁：注册 dsh-daily-report 行
├── lib/
│   ├── index.js          # Host 半部：HTTP 路由 + LLM 生成 + DOCX 构建 + 钉钉发送
│   ├── mcp-server.js     # MCP Server：4 个工具实现（HTTP 与 stdio 共用 createServer）
│   ├── mcp-standalone.js # 独立 stdio MCP Server（Codex 等，无需 DSH，直连 DeepSeek API）
│   └── client.js         # Client 半部：侧栏/右下角入口 + 日报面板（ModuleLoader 格式）
├── mcp-smoke-test.mjs        # HTTP 版 MCP 冒烟测试（12 项断言）
├── standalone-smoke-test.mjs # 独立 stdio 版冒烟测试（9 项断言）
└── README.md
```

## 测试

```bash
node mcp-smoke-test.mjs        # HTTP 版 MCP 端点（12 项断言，无需启动 DSH）
node standalone-smoke-test.mjs # 独立 stdio 版（mock API + PowerShell 写盘，9 项断言）
# 插件内置自检：GET /api/daily-report/self-test（27 项）
```

## 版本

- 0.2.2 面板可后台运行：上传/生成/发送中随时关闭面板，任务后台继续，右下角胶囊显示进度与完成状态
- 0.2.1 新增独立 stdio MCP Server（lib/mcp-standalone.js + bin `dsh-daily-report-mcp`）：Codex 等客户端无需 DSH 直接调用
- 0.2.0 新增 MCP Server（Streamable HTTP）：generate_report / get_report / list_reports / send_report
- 0.1.0 首个可分发版本

License: Apache-2.0
