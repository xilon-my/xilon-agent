# xilon-agent

一个主打“透明可见”的 CLI Agent，默认命令名是 `xilonagent`。

当前版本已提供这些基础能力：

- 交互式 CLI 对话
- 直接使用 `xilonagent` 命令启动
- 启动时自动选择默认模型或精选模型
- 追加式会话输出，不使用整屏重复重绘
- 模型回复流式输出
- 代码搜索工具：`list_files`、`glob_search`、`grep_files`、`read_file`
- 代码修改工具：`write_file`、`edit_file`
- PowerShell 命令执行带权限确认，支持 `ask / allow / deny`
- 当前会话 todo 管理与 `/plan`
- 会话快照保存、会话列表与恢复
- 长期记忆保存与自动注入
- 插件工具骨架与子任务代理能力
- 飞书机器人桥接，可通过飞书与 agent 对话
- 展示 prompt/completion/cached token
- 按内置 Kimi 价格表估算每轮成本
- 退出时展示当前会话总 token 和总成本
- 本地历史记录查看与删除
- 提供 `/help`、`/history`、`/todos`、`/plan`、`/sessions`、`/resume`、`/stats`、`/model`、`/clear` 等 CLI 命令
- 输入 `/` 时弹出可选指令列表，可用方向键选择

## 快速开始

1. 安装依赖

```bash
npm install
```

2. 复制环境变量模板

```bash
copy .env.example .env
```

3. 填写 `.env`

```env
XILON_API_KEY=your_api_key
XILON_BASE_URL=https://api.moonshot.cn/v1
XILON_DEFAULT_MODEL=moonshot-v1-8k
XILON_SYSTEM_PROMPT=You are a helpful CLI assistant.
XILON_PERMISSION_MODE=ask
XILON_CONTEXT_CHAR_BUDGET=20000
XILON_FEISHU_APP_ID=
XILON_FEISHU_APP_SECRET=
XILON_FEISHU_VERIFICATION_TOKEN=
XILON_FEISHU_PERMISSION_MODE=deny
```

4. 开发模式运行

```bash
npm run dev
```

5. 构建后运行

```bash
npm run build
node dist/cli.js
```

6. 绑定全局命令

```bash
npm link
```

之后即可直接使用：

```bash
xilonagent
```

## 用法

启动交互式会话：

```bash
xilonagent
```

启动后会自动优先使用 `.env` 中的 `XILON_DEFAULT_MODEL`；如果未配置或不可用，则回退到内置精选模型。进入会话后可使用 `/help`、`/history`、`/todos`、`/plan`、`/sessions`、`/resume`、`/stats`、`/model`、`/clear`、`/exit`，输入 `/` 可弹出命令列表并用方向键选择。

交互模式采用追加式 transcript 输出，包含：

- 会话头部中的模型、上下文和价格信息
- 每轮的 `You`、`Thinking`、`Tool`、`Assistant` 输出层级
- 每轮与累计 token/费用统计
- 辅助状态信息，如 `history_id`、`response_id`、`finish_reason`
- 当前 todo 数量与长期记忆自动召回

交互模式额外支持：

- 输入 `!命令` 直接让 agent 执行并解释 shell 命令
- `/history` 查看当前会话轮次并删除部分上下文
- `/todos` 查看当前任务列表
- `/plan` 为目标生成任务计划并更新 todo
- `/sessions` 查看本地保存的会话快照
- `/resume` 恢复之前的会话

单次对话：

```bash
xilonagent chat 你好，介绍一下你自己
```

print/headless 模式：

```bash
xilonagent --print 帮我概括当前目录结构
```

列出可恢复会话：

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

启动飞书桥接：

```bash
xilonagent feishu
```

飞书桥接说明：

- 在飞书开放平台创建自建应用并开通机器人能力
- 在事件订阅里选择“使用长连接接收事件”
- 事件订阅里至少启用 `im.message.receive_v1`
- 不需要配置公网地址、事件回调 URL 或内网穿透
- 不需要处理事件 challenge 校验
- 当前实现支持文本消息
- 单聊消息会直接进入 agent
- 群聊消息默认只处理带 `@bot` 的文本
- 飞书会话会独立保存为 session snapshot
- 飞书里的 `/clear`、`/stats`、`/todos`、`/model <id>` 可直接使用
- 默认 `XILON_FEISHU_PERMISSION_MODE=deny`
- 如果你希望飞书端允许执行命令或改文件，再显式改成 `allow`

查看历史：

```bash
xilonagent history list
```

查看某条历史详情：

```bash
xilonagent history show <id>
```

删除某条历史：

```bash
xilonagent history delete <id>
```

## 历史记录位置

历史记录默认保存在当前用户目录下的 `.xilon-agent/history`。

会话快照默认保存在 `.xilon-agent/sessions`，长期记忆保存在 `.xilon-agent/memory`。
飞书对话也会落到 `.xilon-agent/sessions` 与 `.xilon-agent/history`。

## 当前版本说明

这一版内置了你提供的 Kimi 价格表，会根据所选模型自动估算输入、缓存命中输入和输出费用，并在长会话中自动做上下文压缩。
