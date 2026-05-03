# xilon-agent

一个主打“透明可见”的 CLI Agent。

当前版本已提供这些基础能力：

- 交互式 CLI 对话
- 启动时可选择 Kimi 模型
- 模型回复流式输出
- 每轮完整展示发送给模型的消息内容
- 展示 prompt/completion/cached token
- 按内置 Kimi 价格表估算每轮成本
- 退出时展示当前会话总 token 和总成本
- 本地历史记录查看与删除

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

6. 如果你想直接使用 `xilon-agent` 命令

```bash
npm link
```

## 用法

启动交互式会话：

```bash
node dist/cli.js
```

启动后会先列出内置 Kimi 模型，你可以输入序号选择模型，也可以直接回车使用 `.env` 中的 `XILON_DEFAULT_MODEL`。

单次对话：

```bash
node dist/cli.js chat 你好，介绍一下你自己
```

查看历史：

```bash
node dist/cli.js history list
```

查看某条历史详情：

```bash
node dist/cli.js history show <id>
```

删除某条历史：

```bash
node dist/cli.js history delete <id>
```

## 历史记录位置

历史记录默认保存在当前用户目录下的 `.xilon-agent/history`。

## 当前版本说明

这一版内置了你提供的 Kimi 价格表，会根据所选模型自动估算输入、缓存命中输入和输出费用。
