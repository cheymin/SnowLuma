# VNC 远程桌面集成

本文档描述 SnowLuma WebUI 中 VNC 远程桌面功能的实现方式，方便后续版本同步上游时重新应用本集成。

## 设计目标

- **单端口**：VNC 桌面通过 WebUI 的 7860 端口访问，不暴露额外的 VNC/ws 端口
- **侧边栏集成**：VNC 作为 WebUI 的一个页面，与其他功能并列在侧边栏
- **会话认证**：复用 WebUI 登录会话令牌，无需独立的 VNC 密码
- **进程可控**：可在 WebUI 中启动/停止 x11vnc 进程，不用时不占资源
- **进程隐藏**：x11vnc 进程名伪装为 `systemd-logind`，避免进程检测

## 架构

```
浏览器 (7860)
   │
   ├── HTTP ────► WebUI (Hono)
   │                 ├── 静态资源 / API 路由
   │                 ├── GET  /api/vnc/status   ──┐
   │                 ├── POST /api/vnc/start    ──┤  vnc-proxy.ts
   │                 └── POST /api/vnc/stop     ──┘
   │
   └── WebSocket (Upgrade /vnc)
                        │
                        ▼  attachVncProxy()
                   WebSocket Server (ws)
                        │  RFC 6455 帧 ↔ raw RFB bytes
                        ▼
                   127.0.0.1:5900  (x11vnc RFB)
                        │
                        ▼
                   Xvfb :0  ──►  QQ NT (Wine)
```

### 数据流

1. 浏览器加载 `/vnc` 页面，noVNC 的 `RFB` 构造器发起 WebSocket 升级到 `ws(s)://<host>/vnc?token=<session>`
2. WebUI 的 HTTP 服务器收到 `upgrade` 事件，`vnc-proxy.ts` 校验 session token
3. 校验通过后，`ws` 库完成 RFC 6455 握手，建立 WebSocket 连接
4. 代理桥接：浏览器 WS 二进制帧 → `net.connect(5900)` 的 RFB socket；RFB 响应 → WS 帧回传浏览器
5. noVNC 在 canvas 上渲染远程桌面，鼠标/键盘事件通过 WS 发回

## 涉及的文件

### 后端 (`packages/core`)

| 文件 | 作用 |
|------|------|
| `src/webui/vnc-proxy.ts` | VNC 核心：WebSocket 代理 + 进程管理（start/stop/status） |
| `src/webui/server.ts` | 注册 `/api/vnc/*` 路由；监听启动后调用 `attachVncProxy()` |
| `package.json` | 新增依赖 `ws` + `@types/ws` |

### 前端 (`packages/webui`)

| 文件 | 作用 |
|------|------|
| `src/components/pages/vnc-page.tsx` | VNC 页面组件：3 按钮 + 显示区域 |
| `src/router/index.tsx` | 注册 `/vnc` 路由（`vncRoute`） |
| `src/components/layout/sidebar.tsx` | 侧边栏「远程桌面」导航项（Monitor 图标） |
| `src/types/novnc.d.ts` | `@novnc/novnc` 的 TypeScript 类型声明（库本身无 .d.ts） |
| `package.json` | 新增依赖 `@novnc/novnc` |

### Docker / 部署

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 安装 x11vnc + Xvfb；x11vnc 二进制重命名为 `.sys-display-bridge`（stealth） |
| `entrypoint.sh` | 启动 Xvfb 虚拟显示 + x11vnc（`-listen localhost -rfbport 5900 -nopw`） |

## 关键实现细节

### 1. WebSocket 代理（`attachVncProxy`）

WebUI 后端使用 `@hono/node-server` 的 `serve()`，它返回一个 Node `http.Server` 实例。我们在这个 server 上挂载 `upgrade` 事件：

```ts
const httpServer = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const instance = serve({ fetch: app.fetch, port, hostname: host }, () => resolve(instance));
});

attachVncProxy(httpServer, {
  isValidSession: (token) => {
    const info = sessionTokens.get(token);
    return !!info && Date.now() <= info.expiresAt;
  },
});
```

`attachVncProxy` 内部用 `ws` 库的 `WebSocketServer({ noServer: true })` + `handleUpgrade()` 完成 RFC 6455 握手，然后用 `net.connect(5900)` 连接到 x11vnc 的 RFB socket，双向 pipe：

- `ws.on('message')` → `rfb.write(buf)` （浏览器→RFB）
- `rfb.on('data')` → `ws.send(chunk)` （RFB→浏览器）

### 2. 认证

WebSocket 升级请求不带 `Authorization` 头（浏览器限制），所以 token 通过 URL 查询参数传递：

```
ws(s)://host/vnc?token=<webui_session_token>
```

`vnc-proxy.ts` 的 `extractToken()` 按优先级从三处提取：
1. `?token=` 查询参数（主用）
2. `Authorization: Bearer` 头（备用）
3. `Sec-WebSocket-Protocol: token.<value>`（noVNC 约定，备用）

校验逻辑复用 `server.ts` 中的 `sessionTokens` Map（与 REST API 同源），token 过期或无效返回 `401`。

### 3. 进程管理

x11vnc 的查找/启动/停止通过端口号定位，不依赖父进程关系（因为 x11vnc 可能由 `entrypoint.sh` 启动，也可能是 API 启动）：

- **查找**：`lsof -ti:5900` 获取监听 5900 端口的 PID
- **启动**：`spawn('/bin/bash', ['-c', 'exec -a "systemd-logind" x11vnc ... -bg'])`
  - `exec -a` 将 argv[0] 伪装为 `systemd-logind`，`ps` 中不显示 `x11vnc`
  - `-bg` 让 x11vnc 后台运行，spawn 的子进程 `unref()` 后不阻塞 Node
- **停止**：`process.kill(pid, 'SIGTERM')`，1.5 秒后仍存活则 `SIGKILL`

### 4. 前端页面布局

```
┌──────────────────────────────────────────────────┐
│ [连接VNC] [全屏] [启动/终止VNC]     状态指示     │ ← 工具栏 Card
├──────────────────────────────────────────────────┤
│                                                  │
│                VNC 显示区域                      │ ← 画布 Card (flex-1)
│                (noVNC canvas)                    │
│                                                  │
└──────────────────────────────────────────────────┘
```

- **连接VNC**：手动触发 noVNC 连接（非自动连接）。VNC 服务未启动时按钮禁用
- **全屏**：CSS `fixed inset-0 z-50` 覆盖整个视口，Esc 退出
- **启动/终止VNC**：根据 `vncRunning` 状态切换。启动后轮询 `/api/vnc/status` 更新状态
- **状态轮询**：每 3 秒 `GET /api/vnc/status` 更新进程状态指示

### 5. 隐藏进程（Stealth）

两处配合实现进程隐藏：

1. **Dockerfile**：构建时将 x11vnc 二进制重命名为 `.sys-display-bridge`（隐藏文件 + 无 x11vnc 字样）
2. **vnc-proxy.ts**：启动时用 `exec -a "systemd-logind"` 伪装 argv[0]，`/proc/<pid>/comm` 显示为 `systemd-logind`

环境变量 `SNOWLUMA_VNC_BIN` 可覆盖二进制路径（开发环境用标准 `x11vnc`）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SNOWLUMA_VNC_HOST` | `127.0.0.1` | RFB 连接地址（不应改为非 localhost） |
| `SNOWLUMA_VNC_PORT` | `5900` | RFB 端口 |
| `SNOWLUMA_VNC_BIN` | 自动检测 | x11vnc 二进制路径（Docker 内 `.sys-display-bridge`） |

## API 端点

| 方法 | 路径 | 说明 | 返回 |
|------|------|------|------|
| GET | `/api/vnc/status` | 查询 x11vnc 进程状态 | `{ running: boolean, pid: number\|null, port: number }` |
| POST | `/api/vnc/start` | 启动 x11vnc | 同上 |
| POST | `/api/vnc/stop` | 停止 x11vnc | 同上 |

所有端点需 `Authorization: Bearer <token>` 认证（与 WebUI 其他 API 一致）。

## 版本同步指南

当需要从上游 `SnowLuma/SnowLuma` 同步新版本时，按以下步骤重新应用 VNC 集成：

### 1. 同步上游代码

```bash
git remote add upstream https://github.com/SnowLuma/SnowLuma.git
git fetch upstream
git checkout main
git merge upstream/main  # 或 rebase
```

### 2. 重新应用 VNC 后端

确认以下文件存在且未被上游覆盖（如有冲突，保留我们的版本）：

- `packages/core/src/webui/vnc-proxy.ts` — 整个文件是我们的新增
- `packages/core/package.json` — 确保 `ws` + `@types/ws` 依赖存在
- `packages/core/src/webui/server.ts` — 检查三处改动：
  1. import 行：`import { attachVncProxy, getVncStatus, startVnc, stopVnc } from './vnc-proxy';`
  2. `serve()` 调用改为捕获返回值并调用 `attachVncProxy()`
  3. `/api/vnc/*` 三个路由

### 3. 重新应用 VNC 前端

- `packages/webui/src/components/pages/vnc-page.tsx` — 整个文件是我们的新增
- `packages/webui/src/types/novnc.d.ts` — 整个文件是我们的新增
- `packages/webui/package.json` — 确保 `@novnc/novnc` 依赖存在
- `packages/webui/src/router/index.tsx` — 检查：
  1. `vncRoute` 路由定义
  2. 路由树中加入 `vncRoute`
  3. `AppPath` 类型加入 `'/vnc'`
- `packages/webui/src/components/layout/sidebar.tsx` — 检查：
  1. import 加入 `Monitor`
  2. `NAV_ITEMS` 数组中加入远程桌面项

### 4. Docker 文件

- `Dockerfile` — 确保 x11vnc 安装 + `.sys-display-bridge` 重命名 + VNC 相关环境变量
- `entrypoint.sh` — 确保 Xvfb + x11vnc 启动逻辑（`-listen localhost -rfbport 5900 -nopw`）

### 5. 验证

```bash
pnpm install --no-frozen-lockfile
pnpm --filter @snowluma/core typecheck
pnpm --filter webui typecheck
pnpm --filter webui build
pnpm --filter @snowluma/core build
pnpm --filter @snowluma/core test
```

全部通过后即可提交推送。

## 依赖说明

| 依赖 | 版本 | 用途 | 安装位置 |
|------|------|------|----------|
| `ws` | `^8.18.0` | RFC 6455 WebSocket 服务端实现 | `packages/core` |
| `@types/ws` | `^8.5.13` | ws 的 TypeScript 类型（dev） | `packages/core` |
| `@novnc/novnc` | `^1.5.0` | 浏览器端 VNC 客户端（noVNC） | `packages/webui` |

`ws` 会被 vite 打包进 core 的 dist bundle（不在 external 列表），运行时无需单独安装。`@novnc/novnc` 被打包进 webui 前端 chunk（约 194 kB gzip 59 kB）。

## 故障排查

- **连接VNC 按钮 disabled**：x11vnc 未运行，先点「启动VNC」
- **503 Service Unavailable**：WebSocket 升级时 x11vnc 未运行
- **401 Unauthorized**：session token 过期，重新登录 WebUI
- **黑屏 / 无画面**：Xvfb 未启动或 QQ NT 未运行，检查容器日志
- **`lsof` not found**：容器内未安装 lsof（Dockerfile 应包含）
