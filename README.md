# xilon-agent

`xilon-agent` 是一个基于 `Node.js + TypeScript` 实现的 CLI Agent，默认命令名为 `xilonagent`。

当前版本以 `ReAct + Tool Call` 为核心，支持终端交互、会话状态持久化、本地工具执行、长期记忆、上下文压缩，以及飞书长连接接入。

## 功能概览

### 交互与会话

- 追加式 transcript 交互，不使用整屏重复重绘
- 流式展示 `Thinking`、工具调用与最终回答
- 启动时自动选择默认模型或回退到内置精选模型
- 输入 `/` 弹出命令列表，支持方向键选择
- 提供 `/help`、`/history`、`/todos`、`/plan`、`/sessions`、`/resume`、`/stats`、`/model`、`/clear`、`/exit`
- 支持当前会话轮次查看与删除、会话快照保存与恢复
- 支持单次 `chat` 模式与 `--print` / `print` headless 模式

### Agent 能力

- `ReAct` 推理与 `Tool Call` 调用链路
- `todo_write` 驱动的任务拆解与 `/plan`
- 长期记忆保存与自动注入
- 上下文压缩与长会话 summary 保留
- 权限控制，支持 `ask / allow / deny`
- 本地历史记录、usage 统计与成本估算

### 本地工具链

- 文件浏览：`get_cwd`、`list_drives`、`list_files`
- 文件搜索：`glob_search`、`grep_files`
- 文件读取与修改：`read_file`、`write_file`、`edit_file`
- 命令执行：`run_command`
- 会话工具：`todo_write`、`save_memory`、`list_memories`、`list_sessions`
- 扩展能力：插件工具骨架与 `delegate_task`

### 文件系统能力

- 默认从当前工作目录启动，但 `cwd` 不是文件系统边界
- 支持任意本地绝对路径访问，不局限于项目目录
- Windows 下可通过 `list_drives` 发现盘符后继续探索整机文件
- 搜索逻辑内置容错遍历、结果截断与异常目录跳过，避免全盘扫描时直接失败
- 支持将本地文件直接发送到飞书，不要求先按文本读取

### 飞书桥接

- 基于飞书长连接模式接收事件，不需要公网回调地址
- 单聊消息直接进入 agent，群聊默认只处理 `@bot` 文本
- 飞书会话独立保存，并支持 `/clear`、`/stats`、`/todos`、`/model <id>`
- 支持本地文件上传并回发到当前飞书会话
- 内置重复事件与重复消息去重，降低偶发重复回复

## 实现逻辑

### 1. Agent 主循环

- `src/cli.ts` 负责 CLI 输入、slash 菜单、会话切换、print 模式与交互输出
- `src/agent.ts` 负责构造 system prompt、发起模型请求、处理 `tool_calls`、整理最终回答
- 模型输出采用 `<analysis>` 与 `<final>` 双段协议，CLI 只展示清洗后的可见内容

### 2. 工具调用链

- `src/tools.ts` 统一注册内置工具 schema，并负责工具参数解析与执行
- 当模型返回 `tool_calls` 时，agent 逐个执行工具，将结果回填到消息上下文，再继续下一轮推理
- 文件、搜索、命令执行、todo、memory、delegate 等能力都走同一条工具链

### 3. 会话与上下文管理

- `src/storage.ts` 持久化保存历史记录、会话快照与长期记忆
- `src/context.ts` 负责长会话压缩，保留摘要并裁剪旧消息
- `src/memory.ts` 会在新请求前检索相关长期记忆并注入上下文
- `src/permissions.ts` 负责工具权限判定，控制高风险操作是否允许执行

### 4. 飞书运行链路

- `src/feishu.ts` 通过飞书长连接接收 `im.message.receive_v1`
- 消息会按会话维度串行处理，并持久化为独立 session snapshot
- 飞书端同样复用 `runAgentTurn()` 与本地工具链，只是增加了当前聊天的文件发送能力
- 当用户要求“把文件发出来”时，agent 会优先调用 `send_local_file`，直接上传并发送文件消息

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 复制环境变量

```bash
copy .env.example .env
```

### 3. 填写 `.env`

```env
XILON_API_KEY=your_api_key
XILON_BASE_URL=https://api.moonshot.cn/v1
XILON_DEFAULT_MODEL=moonshot-v1-8k
XILON_SYSTEM_PROMPT=You are a helpful CLI assistant.
XILON_PERMISSION_MODE=ask
XILON_CONTEXT_CHAR_BUDGET=20000

# Feishu bridge
XILON_FEISHU_APP_ID=
XILON_FEISHU_APP_SECRET=
XILON_FEISHU_PERMISSION_MODE=deny
```

### 4. 开发运行

```bash
npm run dev
```

### 5. 构建运行

```bash
npm run build
node dist/cli.js
```

### 6. 绑定全局命令

```bash
npm link
```

然后可直接启动：

```bash
xilonagent
```

## 使用方式

### 交互式会话

```bash
xilonagent
```

交互模式特性：

- 自动选择默认模型
- 追加式 transcript 输出
- 实时显示 `Thinking`、`Tool`、`Assistant`
- 展示 token、缓存命中与成本统计
- 输入 `/` 呼出命令列表
- 输入 `!命令` 让 agent 结合 shell 命令进行处理

### 单次对话

```bash
xilonagent chat 你好，介绍一下你自己
```

### print / headless 模式

```bash
xilonagent --print 帮我概括当前目录结构
```

### 会话管理

列出会话：

```bash
xilonagent sessions
```

恢复最近一次会话：

```bash
xilonagent resume
```

恢复指定会话：

```bash
xilonagent resume <session_id>
```

### 本地历史记录

```bash
xilonagent history list
xilonagent history show <id>
xilonagent history delete <id>
```

### 飞书桥接

启动飞书桥接：

```bash
xilonagent feishu
```

接入说明：

- 在飞书开放平台创建自建应用并开通机器人能力
- 事件订阅选择“长连接接收事件”
- 至少启用 `im.message.receive_v1`
- 不需要公网地址、回调 URL 或 challenge 校验
- 默认 `XILON_FEISHU_PERMISSION_MODE=deny`
- 如需允许飞书端执行命令或改文件，可改为 `allow`

飞书端内置命令：

- `/clear` 重置当前飞书会话上下文
- `/stats` 查看当前会话统计
- `/todos` 查看当前待办
- `/model <id>` 切换模型并重置当前飞书会话

## 数据目录

默认数据目录位于当前用户目录下的 `.xilon-agent`：

- `history`：本地历史记录
- `sessions`：CLI 与飞书的会话快照
- `memory`：长期记忆

如有需要，可通过 `XILON_DATA_DIR` 覆盖默认数据目录。

## 当前版本说明

- 内置 Kimi 价格表，自动估算输入、缓存命中输入与输出成本
- 长会话会自动执行上下文压缩
- 当前主交互方式为稳定优先的 append-only CLI，而不是重型全屏 TUI
