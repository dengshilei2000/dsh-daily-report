# leigeqaq · dsh-daily-report 日报助手

DeepSeek Harness（DSH Web GUI）的日报助手插件：**上午素材 / 下午素材**两个输入框，生成 Word 日报并通过钉钉发送。

- **今日完成工作**：分 1. 2. 3. 点，按上传的文档 / 源代码 / 会议纪要分类归纳
- **明日计划**：分 1. 2. 3. 点，逐条对应今日完成工作拓展
- **感悟总结**：一段连贯、充实的文字（不分点）
- 每框可上传文档（.docx/.txt/.md 等）或源代码文件夹压缩包（.zip，单个 ≤100MB），上传后自动解析文本并入日报生成
- 生成后可直接下载 Word 文档，或填写钉钉好友姓名发送附件

## 安装

### 方式一：本地目录安装（推荐，便于后续改代码）

```bash
git clone https://github.com/dengshilei2000/leigeqaq.git
cd leigeqaq
dsh plugin --profile web add link:$(pwd)
dsh web   # 重启后生效
```

### 方式二：tarball 安装

```bash
cd leigeqaq
npm pack   # 生成 dsh-daily-report-0.1.0.tgz
# 安装方执行：
dsh plugin --profile web add file:D:/path/to/dsh-daily-report-0.1.0.tgz
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

> 生成日报会消耗模型 API 额度。钉钉发送依赖本机 `dws` CLI（钉钉工作台命令行）可用。

## 卸载

```bash
dsh plugin --profile web remove dsh-daily-report
```

## 目录结构

```
leigeqaq/
├── package.json          # 插件元数据（bundle patch + client 声明）
├── cordis.patch.yml      # 组合补丁：注册 dsh-daily-report 行
├── lib/
│   ├── index.js          # Host 半部：HTTP 路由 + LLM 生成 + DOCX 构建 + 钉钉发送
│   └── client.js         # Client 半部：侧栏/右下角入口 + 日报面板（ModuleLoader 格式）
└── README.md
```

## 版本

- 0.1.0 首个可分发版本

License: Apache-2.0
