# SnowLuma 自定义改动技术文档

> 本仓库在官方 [SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma) 的基础上，
> 新增 / 修改了以下能力：
>
> 1. **远程桌面（VNC）**：侧边栏新增「远程桌面」页面，可启动 / 连接 / 终止 VNC。
> 2. **增强的 VNC 停止逻辑**：终止 VNC 时先杀死进程，再**彻底删除**容器内的
>    VNC / noVNC 软件与一切残留（进程、二进制、apt 包、缓存、运行时目录），
>    让外部扫描只能看到一个“普通应用”；启动 VNC 时才按需重新下载并启动。
> 3. **QQ 重启不掉线**：持久化 QQ 数据目录 + 固定 machine-id + 固定 MAC 地址，
>    容器重建 / 镜像更新后无需重新登录。

---

## 1. 远程桌面（VNC）功能总览

### 1.1 架构

```
浏览器 (noVNC RFB 客户端，运行时加载)
   │  ① 点击「启动VNC」→ POST /api/vnc/start
   │      后端按需下载 x11vnc + noVNC → 隐藏目录 /tmp/.sys-svc-runtime
   │      启动伪装进程（argv[0]=systemd-logind）
   │  ② 点击「连接VNC」→ 动态 import /vnc-client/core/rfb.js
   │     建立 WebSocket → /vnc → 后端代理 → 127.0.0.1:5900 (x11vnc/RFB)
   │  ③ 点击「终止VNC」→ POST /api/vnc/stop
   │      杀死 VNC 进程 → 删除 /tmp/.sys-svc-runtime（x11vnc + noVNC）
   │      → purge apt 包与缓存 → 环境无任何 VNC 残留
   ▼
后端 packages/core/src/webui/vnc-proxy.ts
   ├── startVnc / stopVnc / getVncStatus
   └── attachVncProxy（/vnc WebSocket → RFB 5900，Bearer 会话鉴权）
```

- 浏览器始终只访问 WebUI 单端口（`/api/vnc/*`、`/vnc`、`/vnc-client/*`），
  不需要额外暴露 5900 端口（x11vnc 也 `-listen localhost` 只绑本机回环）。
- 鉴权复用 WebUI 会话 Token（`?token=` 或 `Sec-WebSocket-Protocol: token.<value>`）。

### 1.2 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/core/src/webui/vnc-proxy.ts` | VNC 进程管理（下载/启动/杀进程/删除残留）+ WebSocket 代理 |
| `packages/core/src/webui/server.ts` | 新增 `/api/vnc/status|start|stop`、`/vnc-client/*` 静态服务、挂载代理 |
| `packages/webui/src/components/pages/vnc-page.tsx` | 远程桌面页面（工具栏 + 显示区 + 状态） |
| `packages/webui/src/router/index.tsx` | 注册 `/vnc` 路由 |
| `packages/webui/src/components/layout/sidebar.tsx` | 侧边栏「远程桌面」入口 |
| `packages/webui/vite.config.ts` | dev 代理 `/vnc`、`/vnc-client` |

---

## 2. 增强的 VNC 停止逻辑（下载-即用 / 停止-即删）

### 2.1 为什么这样做

官方 / 旧版方案把 `x11vnc` 直接打进镜像，容器里**一直**存在：

- `/usr/bin/x11vnc`（或改名后的 `.sys-display-bridge`）二进制；
- 前端静态包里打包的 noVNC 客户端代码；
- 随镜像常驻、随时可被 `ps` / 文件扫描发现的 VNC 进程与文件。

这在“停止 VNC”后依然能被外部扫描出 VNC 的痕迹。

### 2.2 新模型：停止即无痕

**镜像 / 空闲容器内零 VNC 残留**：

- Dockerfile **不再安装** `x11vnc`（连 `libvnc*` 依赖都不装）；
- noVNC 前端客户端 **不打进 bundle**，改为运行时下载；
- 空闲时容器里只有：Xvfb（伪装为 `.sys-gfx-compositor`）、fluxbox（伪装为
  `.sys-wm-service`）、QQ、SnowLuma —— 看起来就是一个普通应用。

**「启动VNC」（`startVnc`）按需下载**：

1. 检查 X display 存活（`/tmp/.X11-unix/X0`），必要时拉起伪装 Xvfb；
2. 若隐藏二进制不存在 → `sudo apt-get update && apt-get install -y x11vnc`，
   拷贝到隐藏路径 `/tmp/.sys-svc-runtime/.display-bridge`，**删除**
   `/usr/bin/x11vnc`（磁盘上不存在叫 “x11vnc” 的二进制）；
3. 下载 noVNC 客户端 tarball（GitHub `novnc/noVNC` v1.5.0）到
   `/tmp/.sys-svc-runtime/client/core/`，由 `/vnc-client/*` 提供静态服务；
4. 以 `exec -a "systemd-logind"` 伪装进程名启动 x11vnc，轮询 5900 端口就绪。

**「终止VNC」（`stopVnc`）停止即删**：

1. 定位 VNC 进程（`lsof/ss/fuser` + `/proc/<pid>/comm` 白名单校验，
   绝不误杀 pid=1 / 自身）；
2. `SIGTERM` → 等待端口释放 → 超时 `SIGKILL`；无法确认 pid 时用多模式
   `pkill` 兜底（匹配截断 comm 名 `.display-bridge` / `.sys-display-br` 与
   伪装 argv[0] `systemd-logind`）；
3. **删除 `/tmp/.sys-svc-runtime` 整个目录**（x11vnc 隐藏二进制 + noVNC 客户端）；
4. `sudo apt-get purge -y x11vnc libvncserver1 libvncclient1` +
   `autoremove`，删除 `/usr/bin/x11vnc`、清空 apt lists 与 `.deb` 缓存。

### 2.3 进程名截断的坑（必须知道的细节）

Linux `/proc/<pid>/comm` 只保留 **15 字节**，`exec -a` 只改 `argv[0]`（`ps` 显示），
**不改** `/proc/comm`。所以：

- 旧名 `/usr/bin/.sys-display-bridge`（17 字符）在 `/proc/comm` 里是
  `.sys-display-br`（15 字符截断）；
- 新名 `/tmp/.sys-svc-runtime/.display-bridge` 的 basename 恰好 15 字符，
  不会被截断。

`VNC_COMM_NAMES` 白名单同时收录：`systemd-logind`、`x11vnc`、
`.sys-display-bridge`、`.sys-display-br`、`.display-bridge`。

### 2.4 相关环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SNOWLUMA_VNC_HOST` | `127.0.0.1` | RFB 监听地址 |
| `SNOWLUMA_VNC_PORT` | `5900` | RFB 端口 |
| `SNOWLUMA_VNC_RUNTIME_DIR` | `/tmp/.sys-svc-runtime` | 运行时 VNC 软件隐藏目录 |
| `SNOWLUMA_NOVNC_VERSION` | `v1.5.0` | noVNC 客户端下载版本 |

---

## 3. QQ 重启不掉线（持久化方案）

QQ NT 判断“是否新设备”依赖三样东西，缺一都会强制重新登录：

| 指纹来源 | 问题 | 解决方案 |
| --- | --- | --- |
| `~/.config/QQ` 登录数据 | 在镜像层，容器重建即丢 | entrypoint 软链到 `/data/qq` |
| `/etc/machine-id` + `/var/lib/dbus/machine-id` | 容器重建会重新生成 | 持久化到 `/data/system/machine-id`，开机双向恢复 |
| 网卡 MAC（eth0） | 容器重建随机变化 | 持久化到 `/data/system/eth0-mac`，开机恢复（需 `NET_ADMIN`） |

### 3.1 entrypoint.sh 关键段

```bash
# 1) QQ 数据目录 → /data/qq
mkdir -p /data/qq && rm -rf "$HOME/.config/QQ" && ln -sfn /data/qq "$HOME/.config/QQ"

# 2) 双 machine-id 持久化（systemd 与 dbus 都读）
restore_machine_id() { for f in /etc/machine-id /var/lib/dbus/machine-id; do
  printf '%s\n' "$1" | sudo tee "$f" >/dev/null 2>&1 || true; done; }
# …（首次开机 pin / 之后恢复，详见 entrypoint.sh）

# 3) MAC 地址持久化（需 NET_ADMIN）
ip link set dev eth0 address "$PINNED_MAC"
```

> **部署要求**：挂载 `/data` 卷 + 建议 `docker run --cap-add=NET_ADMIN`
> （或 compose `cap_add: [NET_ADMIN]`），否则 MAC 无法固定。

---

## 4. 未来版本更新时如何同步（移植指南）

官方仓库会持续更新。升级时不要整棵覆盖，按下面的“增量”重新应用：

```bash
# 1. 添加官方上游并拉取最新
git remote add upstream https://github.com/SnowLuma/SnowLuma.git
git fetch upstream

# 2. 以最新 upstream/main 为基线建分支
git checkout -b sync-upstream upstream/main

# 3. 逐项移植以下改动（diff 参考 git diff upstream/main origin/main -- <path>）
```

### 4.1 需要手动移植的文件清单

**后端（必须）：**

- `packages/core/src/webui/vnc-proxy.ts` —— 直接复制（自包含，无额外依赖；
  只依赖 `@snowluma/common/logger` 与 `ws`）。
- `packages/core/src/webui/server.ts` —— 追加：
  - import：`attachVncProxy, getVncStatus, startVnc, stopVnc, NOVNC_DIR`；
  - 三条 API：`GET /api/vnc/status`、`POST /api/vnc/start|stop`；
  - `/vnc-client/*` 静态服务（从 `NOVNC_DIR` 读）；
  - `serve()` 返回值改为捕获 `httpServer`，随后 `attachVncProxy(httpServer, { isValidSession })`。
- `packages/core/package.json` —— `dependencies` 增加 `"ws": "^8.18.0"`，
  `devDependencies` 增加 `"@types/ws": "^8.5.13"`。

**前端（必须）：**

- `packages/webui/src/components/pages/vnc-page.tsx`（新增）；
- `packages/webui/src/router/index.tsx`：注册 `vncRoute` 并加入 routeTree、
  扩展 `AppPath`；
- `packages/webui/src/components/layout/sidebar.tsx`：加入「远程桌面」项；
- `packages/webui/vite.config.ts`：dev 代理加 `/vnc`、`/vnc-client`。

**Docker / 部署（必须）：**

- `Dockerfile`（新增，镜像内**不含** x11vnc）；
- `entrypoint.sh`（新增，含 QQ 持久化 + 伪装 X11，**不自动启动 VNC**）；
- `.github/workflows/docker-build.yml`（新增，构建并推送
  `ghcr.io/<repo>:latest`）；
- `.dockerignore`（新增）；
- `hf/nginx.conf`（新增，HF 模式反代，`/vnc` WebSocket 已覆盖）。

### 4.2 移植自检清单

- [ ] `pnpm --filter @snowluma/core typecheck` 通过；
- [ ] `pnpm --filter webui build` 通过（`vnc-page` 无编译错误）；
- [ ] Docker 构建后 `docker exec` 容器内 **`find / -iname '*vnc*'` 无结果**；
- [ ] 容器启动日志**没有**启动 VNC 的记录；
- [ ] 点「启动VNC」后 5900 监听、`ps` 中进程名显示 `systemd-logind`；
- [ ] 点「终止VNC」后 5900 关闭、`/tmp/.sys-svc-runtime` 消失、
      `apt list --installed | grep -i vnc` 为空；
- [ ] 挂载 `/data` 重建容器后 QQ 无需重新登录。
