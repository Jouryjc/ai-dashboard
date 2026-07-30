# AiLab 发布流程

把做好的大屏版本 HTML 发布到 AiLab CodeBox，得到一个公网可访问的 URL。本文档基于真实链路验证（2026-07-30，CodeBox `codebox:v1.1` 镜像），每一步都是实测可行。

## 一句话流程

> 用户填好 AiLab 凭据 → 点发布 → 服务端创建/复用一个 CodeBox 容器 → 把大屏 HTML 上传进去并在 9229 端口起静态服务 → 用 `publish` 把 9229 暴露到公网 → 把公网 URL 推给前端 → 用户点「打开预览」在新窗口看到大屏。

## 前置条件

- **发布配置已填好**：设置 · 发布配置里的 `endpoint` / `accessKey` / `secretKey`（见 `PublishConfig`，持久化在 `server/data/publish-config.json`）。
- **宿主机有 `ssh` 命令**：Windows 10 1809+ 自带 OpenSSH 客户端；Linux/macOS 默认有。没有则发布失败，提示用户启用 ssh。
- **ailab-codebox CLI 二进制在仓库里**：`server/bin/ailab-codebox/` 下按平台选一个。

## 端到端 7 步（服务端发布器执行）

输入：`PublishConfig` + `dashId` + `versionId`。

| 步骤 | 命令 | 作用 | 关键产出 |
|------|------|------|---------|
| ① init | `ailab-codebox init --endpoint … --access-key … --secret-key …` | 写凭据到 `~/.ailab-codebox/config.yaml`（幂等，凭据未变则跳过） | — |
| ② resolve | `ailab-codebox list --keyword <name>` | 查是否已有同名 CodeBox | 命中则复用，否则走 ③ |
| ③ create | `ailab-codebox create --name <name> --image-id 2 --cpu 1 --memory 2048 --storage 20` | 创建容器（**image-id 必填**，`codebox:v1.1`=2） | uuid |
| ④ open | `ailab-codebox open --name <name>` | 写 SSH 配置：`~/.ssh/config` 的 managed block + 私钥 `~/.ssh/ailab-<name>` | `host_alias`（= name） |
| ⑤ 上传 | `ssh <name> "cat > /workspace/index.html" < html` | 借 open 写好的 alias 免密上传大屏 HTML | — |
| ⑥ 起服务 | `ssh <name> "pkill -f http.server; nohup python3 -m http.server 9229 --bind 0.0.0.0 -d /workspace &"` | 在容器 9229 起静态服务（**必须绑 0.0.0.0**） | — |
| ⑦ publish | `ailab-codebox publish --name <name>` | 把容器内 9229 暴露到公网 | **`public_url`** |

**命名规则**：CodeBox name = `<project-slug>-dev`（小写、非字母数字转 `-`、去噪音后缀）。同一个大屏/项目复用同一个 CodeBox，重复发布只重新上传 HTML + 重启 serve。

## 镜像说明

只有一个可用镜像 `codebox:v1.1`（image_id=2），经实测**自带 `python3`（`/usr/bin/python3`）和 `node`**，所以步骤 ⑥ 的 `python3 -m http.server` 直接可用，无需定制镜像。

## 关键端口链路

```
用户浏览器  →  公网  public_url (http://<public_host>:<host_port>)
                            ↑ publish 返回，服务端做端口映射
                  宿主机 :host_port  (由 AiLab 自动分配，实测如 20012)
                            ↓
                  容器内 127.0.0.1:9229  (create 时自动预置的 debug 端口)
                            ↓
                  python3 -m http.server (serve /workspace/index.html)
```

- `create` 时容器内 `9229/tcp` 自动映射到宿主机某个 debug 端口（不用手动加 `--port`）。
- `publish` 只查询并暴露这个已预置的 debug 端口，不改端口映射。
- **必须 `--bind 0.0.0.0`**：只监听 `127.0.0.1` 的话公网访问不到（这是 Skill 文档强调的坑）。

## publish 返回字段（实测）

```json
{
  "container_port": 9229,
  "host_port": 20012,
  "protocol": "tcp",
  "public_host": "59.37.133.154",
  "public_address": "59.37.133.154:20012",
  "public_url": "http://59.37.133.154:20012"
}
```

发布器只需取 `public_url`，推回前端。

## 在系统中的接入点

| 现有结构 | 改造 |
|---------|------|
| `POST /api/v1/dashboards/:id/publish` | 不变，仍返回 202；真实进度走 SSE |
| `handlePublish` 里的 `after(rt, 5000, …)` 假审批 | 换成真实 7 步发布器 |
| `versionAdded` SSE 事件 | `Version` 加 `publicUrl` 字段，URL 自动到前端 |
| TopBar 「已保存」指示 / VersionDrawer「已发布」徽标 | 读 `publicUrl`，加「打开预览」按钮，调 `shell.openExternal` |

## 失败处理

任何一步失败 → 走现有卡点流程：`setBlocker(type:'failed')` + `setStatus('blocked')` + `updateDashboard('needs_attention')`，前端弹问题卡片（重试发布 / 呼叫人工）。常见失败：凭据错、缺 ssh、端口占用、CodeBox 起不来。

## 已知约束

- **CodeBox 公网 IP 固定为 AiLab 服务端地址**（实测 `59.37.133.154`），host_port 每次分配可能不同。
- **CodeBox 默认无持久化语义**：容器删了内容就没了，但发布是幂等的（重新创建 + 上传即可）。
- **凭据明文落本地**（`config.yaml` + `publish-config.json`），单用户演示形态。
