# zylos-a2a

面向 Zylos 的双向 A2A v1.0 通信组件。

[English](./README.md) · [设计说明](./docs/DESIGN.md) · [安全策略](./SECURITY.md)

`zylos-a2a` 既能把当前 Zylos Agent 通过 A2A JSON-RPC 暴露给受信任的
Peer，也能发现和调用已配置的其他 Agent。入站任务通过 C4 进入当前
Zylos Runtime；任务状态、上下文历史和 Push 配置保存在本地 SQLite 中。

## 主要能力

- 支持 A2A v1.0 标准方法及兼容旧方法名：发送、流式响应、订阅、查询、
  列表、取消和 Push 配置。
- 支持标准 Agent Card 地址 `/.well-known/agent-card.json` 和旧地址回退。
- 按 Peer 隔离认证、信任、限流、任务所有权和上下文历史。
- 出站请求固定 DNS 解析结果、拒绝重定向、防 SSRF、响应脱敏、Push
  回调认证、可选 HMAC 签名，以及仅记录元数据的审计日志。
- 默认只调用一个明确指定的 Peer；实验性多 Agent fan-out 必须显式执行。

组件不自动实现 Agent Directory、自动选 Agent 或跨组织信任。每个 Peer
都需要由运维人员显式配置并建立双向信任。

## 环境要求

- Zylos 0.7.1 或更高版本。
- Node.js 22.13 或更高版本（持久化使用无需实验开关的内置 `node:sqlite`）。
- 对外暴露服务时，使用可信 TLS 反向代理或受控私网。

## 安装

进入 Zylos Registry 前使用完整仓库名：

```bash
zylos add zylos-ai/zylos-a2a
```

登记完成后可使用短名称：

```bash
zylos add a2a
```

安装器会创建权限为 `0600` 的
`~/zylos/components/a2a/config.json`。组件默认禁用并只监听本机；请先复核
身份字段、配置预期的信任策略，再显式启用。升级时会保留运行配置和持久化数据。

## 配置 Peer

下面是一个双向信任 Peer 的最小示例。两个方向应使用不同的强随机 Token，
并且只通过私密渠道交换。

```json
{
  "enabled": true,
  "server": {
    "host": "127.0.0.1",
    "port": 9900,
    "public_url": "https://agent.example.com/a2a"
  },
  "identity": {
    "name": "My Zylos Agent",
    "description": "A persistent Zylos agent",
    "skills": []
  },
  "auth": {
    "bearer_token": "",
    "peer_tokens": {
      "research-agent": "替换为对方调用本机时使用的-token"
    },
    "trusted_peers": ["research-agent"],
    "rate_limit_per_minute": 60
  },
  "outbound": {
    "peers": {
      "research-agent": {
        "url": "https://research.example.com/a2a",
        "token": "替换为对方签发给本机的-token"
      }
    }
  }
}
```

由反向代理终止 TLS 时，`server.host` 应继续保持本机监听，
`server.public_url` 填写外部可访问的 A2A 根地址。私网 Peer 和私网 Push
回调默认禁止；只有在受控网络中才应显式开启对应 `allow_private` 配置。

## 验证连接

本机 Agent Card 不包含已配置的认证凭据。所有身份字段都会公开，分享前仍应复核其内容：

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js card
```

发现并调用已配置 Peer：

```bash
node ~/zylos/.claude/skills/a2a/scripts/a2a.js discover research-agent

node ~/zylos/.claude/skills/a2a/scripts/a2a.js call research-agent <<'A2AMSG'
请概述你当前可以提供的能力。
A2AMSG
```

使用 `--context <context-id>` 延续同一会话；使用 `list` 和 `history` 查看
本机持久化状态。`orchestrate` 是实验性显式功能，普通调用不会自动 fan-out。

## 取消语义

排队中的任务可以在分发前真正取消。任务开始运行后，当前 Zylos Core 还没有
暴露由 A2A task ID 精确定位 Runtime turn 的句柄。因此 `CancelTask` 会记录
取消意图、返回 `TaskNotCancelable`，并丢弃后续迟到结果；组件不会把“停止
回传”误报成“已经中断执行”。

## 开发验证

```bash
npm ci
npm run check
```

测试使用真实临时 SQLite 数据库和 HTTP Server。发布时必须同步更新
`package.json`、`package-lock.json`、`SKILL.md` 和 `CHANGELOG.md` 的版本。

## 许可证

[MIT](./LICENSE)
