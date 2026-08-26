# VNC 远程桌面集成

本文档描述 SnowLuma WebUI 中 VNC 远程桌面功能的实现方式，方便后续版本
同步上游时重新应用本集成。QQ 登录状态持久化细节见
[QQ-PERSISTENCE-AND-STEALTH.md](./QQ-PERSISTENCE-AND-STEALTH.md)。

## 设计目标

- **单端口**：VNC 桌面通过 WebUI 的 7860 端口访问，不暴露额外的 VNC/ws 端口
- **侧边栏集成**：VNC 作为 WebUI 的一个页面，与其他功能并列在侧边栏
- **会话认证**：复用 WebUI 登录会话令牌，无需独立的 VNC 密码
- **进程可控**：可在 WebUI 中启动/停止 x11vnc 进程，不用时不占资源
- **自带组件**：x11vnc + noVNC 直接安装在 Docker 镜像中，**停止时只杀死
  进程，不删除软件**；再次启动不用重新下载

## 架构

```
浏览器 (noVNC RFB 客户端 — 镜像内置 /usr/share/novnc)
   │  ① POST /api/vnc/start   →  启动镜像内置的 x11vnc
   │  ② GET  /vnc-client/*    →  后端从 /usr/share/novnc 提供 noVNC 静态资源
   │     WS   /vnc?token=...  →  后端 WebSocket↔RFB 代理
   │  ③ POST /api/vnc/stop    →  仅杀死 x11vnc 进程（软件保留）
   ▼
WebUI (Hono, 单端口 7860)
   ├── GET  /api/vnc/status   ─┐
   ├── POST /api/vnc/start    ─┤  packages/core/src/webui/vnc-proxy.ts
   ├── POST /api/vnc/stop     ─┘  （进程控制 + WebSocket 代理）
   ├── /vnc-client/*             （noVNC 静态服务）
   └── WS upgrade /vnc ──► net.connect(127.0.0.1:5900)  (x11vnc RFB)
                                  │
                                  ▼
                            Xvfb :0  ──►  QQ NT
```

### 数据流

1. 浏览器加载 `/vnc` 页面，「启动VNC」→ 后端轮询确认 x11vnc 已在 5900 端口
   就绪（x11vnc 是镜像内置组件，无需下载）。
2. 前端动态 `import('/vnc-client/core/rfb.js')`（运行时，不打进 bundle），
   用 noVNC 的 `RFB` 构造器发起 WebSocket 升级到 `ws(s)://<host>/vnc?token=<session>`。
3. WebUI 的 HTTP 服务器收到 `upgrade` 事件，`vnc-proxy.ts` 校验 session token。
4. 校验通过后，`ws` 库完成 RFC 6455 握手，代理桥接：浏览器 WS 二进制帧 →
   `net.connect(5900)` 的 RFB socket；RFB 响应 → WS 帧回传浏览器。
5. noVNC 在 canvas 上渲染远程桌面，鼠标/键盘事件通过 WS 发回。
6. 「终止VNC」→ 后端**仅杀死** x11vnc 进程（SIGTERM→SIGKILL）。x11vnc/noVNC
   仍安装在镜像中，可随时再次启动。

## 涉及的文件

### 后端 (`packages/core`)

| 文件 | 作用 |
|------|------|
| `src/webui/vnc-proxy.ts` | VNC 核心：启动/停止 x11vnc + WebSocket 代理 |
| `src/webui/server.ts` | 注册 `/api/vnc/*`、`/vnc-client/*`；监听启动后调用 `attachVncProxy()` |
| `package.json` | 新增依赖 `ws` + `@types/ws` |

### 前端 (`packages/webui`)

| 文件 | 作用 |
|------|------|
| `src/components/pages/vnc-page.tsx` | VNC 页面组件：连接/全屏/启停按钮 + 显示区 |
| `src/router/index.tsx` | 注册 `/vnc` 路由（`vncRoute`），扩展 `AppPath` |
| `src/components/layout/sidebar.tsx` | 侧边栏「远程桌面」导航项（Monitor 图标） |
| `vite.config.ts` | dev 代理 `/vnc`、`/vnc-client` |

> noVNC 客户端**不打进前端 bundle**，也不作为 npm 依赖：它由镜像内置
> （`novnc`/`websockify` apt 包，安装于 `/usr/share/novnc`），由后端在
> `/vnc-client/*` 静态托管，始终可用。

### Docker / 部署

| 文件 | 作用 |
|------|------|
| `Dockerfile` | 镜像**内置** x11vnc + noVNC（`x11vnc novnc websockify`），Xvfb/fluxbox 原名 |
| `entrypoint.sh` | 启动 Xvfb + fluxbox + QQ；**不自动启动 VNC** |
| `hf/Dockerfile` | Hugging Face Space 包装：`FROM ghcr.io/cheymin/snowluma:latest` + `ENV SNOWLUMA_HF_MODE=1` |
| `hf/nginx.conf` | HF 模式反代（7860→5099，含 `/vnc` WebSocket 升级头与长超时） |

## 关键实现细节

### 1. x11vnc 内置组件（`startVnc` / `stopVnc`）

镜像直接用 apt 安装 `x11vnc novnc websockify`。启动时直接 spawn 系统的
`x11vnc` 二进制，停止时只 kill 进程：

```ts
// 启动：spawn 系统的 x11vnc，detached + unref 后台运行
const child = spawn('x11vnc', ['-display', DISPLAY, '-rfbport', String(RFB_PORT),
  '-listen', 'localhost', '-nopw', '-forever', '-shared',
  '-noxdamage', '-threads', '-bg'], { detached: true, stdio: 'ignore', env });
child.unref();

// 停止：仅杀进程（SIGTERM → 超时 SIGKILL），软件保持安装
const pid = findVncPid();
if (pid && isVncProcess(pid)) process.kill(pid, 'SIGTERM');
```

### 2. WebSocket 代理（`attachVncProxy`）

WebUI 后端使用 `@hono/node-server` 的 `serve()`，它返回一个 Node
`http.Server` 实例。在 server 上挂载 `upgrade` 事件：

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

`attachVncProxy` 内部用 `ws` 库 `WebSocketServer({ noServer: true })` +
`handleUpgrade()` 完成 RFC 6455 握手，再 `net.connect(5900)` 双向 pipe：

- `ws.on('message')` → `rfb.write(buf)`（浏览器→RFB）
- `rfb.on('data')` → `ws.send(chunk)`（RFB→浏览器）

### 3. 认证

WebSocket 升级请求通常不带 `Authorization` 头（浏览器限制），token 通过
URL 查询参数传递：`ws(s)://host/vnc?token=<webui_session_token>`。
`extractToken()` 按优先级从三处提取：

1. `?token=` 查询参数（主用）
2. `Authorization: Bearer` 头（备用）
3. `Sec-WebSocket-Protocol: token.<value>`（noVNC 约定，备用）

校验逻辑复用 `server.ts` 中的 `sessionTokens` Map（与 REST API 同源），
token 过期或无效返回 `401`。

### 4. 进程管理（`startVnc` / `stopVnc`）

- **查找**：`lsof -ti:5900` / `ss` / `fuser` 获取监听端口 PID，
  再经 `isVncProcess()`（读 `/proc/<pid>/comm` == `x11vnc`）校验，绝不误杀
  pid=1 或自身。
- **启动**：`spawn('x11vnc', args, { detached: true, stdio: 'ignore' })`，
  `child.unref()` 不阻塞 Node；轮询 5900 端口就绪（最多 ~8s）。
- **停止**：定位并校验 PID → `SIGTERM` → 等待端口释放（~3s）→ 超时 `SIGKILL`；
  无法确认 PID 时 `pkill -x x11vnc` 兜底。**只杀进程，不删除软件。**

### 5. 前端页面

- 工具栏：`连接VNC` / `全屏` / `启动/终止VNC` + 状态指示（连接态 + 服务态）；
- 连接前轮询 `/api/vnc/status`（3s）；离开页面自动断开；
- 全屏支持 Esc 退出；
- noVNC 客户端通过 `import(/* @vite-ignore */ '/vnc-client/core/rfb.js')`
  运行时加载，不在 bundle 内。

## 相关环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SNOWLUMA_VNC_HOST` | `127.0.0.1` | RFB 监听地址 |
| `SNOWLUMA_VNC_PORT` | `5900` | RFB 端口 |
| `SNOWLUMA_NOVNC_DIR` | `/usr/share/novnc` | noVNC 客户端内置目录 |

## 同步上游时的移植清单

1. `packages/core/src/webui/vnc-proxy.ts` —— 直接复制（依赖 `@snowluma/common/logger` 与 `ws`）；
2. `packages/core/src/webui/server.ts` —— import VNC 模块 + `/api/vnc/*` 路由 +
   `/vnc-client/*` 静态服务 + `attachVncProxy(httpServer, ...)`；
3. `packages/core/package.json` —— `ws` / `@types/ws` 依赖；
4. `packages/webui/.../vnc-page.tsx`、`router/index.tsx`、`sidebar.tsx`、
   `vite.config.ts` —— 前端页面 / 路由 / 导航 / dev 代理；
5. `Dockerfile` / `entrypoint.sh` / `.github/workflows/docker-build.yml` /
   `.dockerignore` / `hf/Dockerfile` / `hf/nginx.conf` —— 部署与内置 VNC 组件。