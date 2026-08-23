import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Monitor,
  MonitorOff,
  Play,
  Square,
  Maximize2,
  Minimize2,
  Wifi,
  WifiOff,
  RefreshCw,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const TOKEN_KEY = 'snowluma_token';

type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

interface VncStatus {
  running: boolean;
  pid: number | null;
  port: number;
}

/**
 * Minimal noVNC RFB surface used by this page. The client library itself is
 * deliberately NOT bundled into the app: the backend downloads it at runtime
 * on 「启动VNC」 into a hidden dir and serves it at /vnc-client/*, and removes
 * it again on 「终止VNC」 — so the environment holds no noVNC residue while
 * the remote desktop is stopped.
 */
interface RfbInstance {
  scaleViewport: boolean;
  resizeSession: boolean;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
  disconnect(): void;
}
interface RfbConstructor {
  new (
    target: HTMLElement,
    url: string,
    options: { credentials?: Record<string, string> },
  ): RfbInstance;
}

function buildWsUrl(token: string | null): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${window.location.host}/vnc${tokenQuery}`;
}

function stateLabel(state: ConnState): string {
  switch (state) {
    case 'idle': return '未连接';
    case 'connecting': return '连接中…';
    case 'connected': return '已连接';
    case 'disconnected': return '已断开';
    case 'error': return '连接失败';
  }
}

async function fetchVncStatus(): Promise<VncStatus> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch('/api/vnc/status', {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return res.json();
}

async function postVncAction(action: 'start' | 'stop'): Promise<VncStatus> {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch(`/api/vnc/${action}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${action} failed: ${res.status}`);
  return res.json();
}

/**
 * Loads the noVNC RFB class from the runtime-served client (not bundled).
 * The dynamic-import URL is outside the bundle graph, so Vite keeps it as a
 * runtime fetch to the same origin's /vnc-client/ path.
 */
async function loadRfb(): Promise<RfbConstructor> {
  const url = `${window.location.origin}/vnc-client/core/rfb.js`;
  const mod = (await import(/* @vite-ignore */ url)) as { default?: RfbConstructor };
  if (typeof mod?.default !== 'function') {
    throw new Error('noVNC 客户端未就绪，请重试「启动VNC」');
  }
  return mod.default;
}

/**
 * VNC 远程桌面页面。
 *
 * 布局：
 *   ┌──────────────────────────────────────────────┐
 *   │ [连接VNC] [全屏] [启动/终止VNC]   状态指示   │ ← 工具栏
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │              VNC 显示区域                    │
 *   │                                              │
 *   └──────────────────────────────────────────────┘
 *
 * - 「连接VNC」：动态加载运行时 noVNC 客户端并建立 WebSocket 到 /vnc。
 * - 「全屏」：切换 VNC 显示区域为浏览器全屏。
 * - 「启动/终止VNC」：启动 = 后端按需下载并启动 VNC；终止 = 后端杀死
 *   VNC 进程并删除容器内的 VNC/noVNC 软件与一切残留。
 */
export function VncPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RfbInstance | null>(null);

  const [connState, setConnState] = useState<ConnState>('idle');
  const [vncRunning, setVncRunning] = useState<boolean | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // ── 进程状态轮询 ──
  const refreshStatus = useCallback(async () => {
    try {
      const s = await fetchVncStatus();
      setVncRunning(s.running);
    } catch {
      setVncRunning(null);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 3000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  // ── VNC 连接管理 ──
  const disconnect = useCallback(() => {
    const rfb = rfbRef.current;
    if (rfb) {
      try { rfb.disconnect(); } catch {}
      rfbRef.current = null;
    }
  }, []);

  const connect = useCallback(async () => {
    disconnect();
    setErrorMsg(null);

    if (!vncRunning) {
      setErrorMsg('VNC 服务未启动，请先点击「启动VNC」');
      setConnState('error');
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const token = localStorage.getItem(TOKEN_KEY);
    const url = buildWsUrl(token);
    setConnState('connecting');

    try {
      const RFB = await loadRfb();
      const rfb = new RFB(container, url, { credentials: { password: '' } });
      rfbRef.current = rfb;
      rfb.scaleViewport = true;
      rfb.resizeSession = false;

      rfb.addEventListener('connect', () => setConnState('connected'));
      rfb.addEventListener('disconnect', (ev: unknown) => {
        const detail = (ev as { detail?: { clean?: boolean } }).detail;
        setConnState(detail?.clean ? 'disconnected' : 'error');
        if (!detail?.clean) setErrorMsg('远程桌面连接已断开');
        rfbRef.current = null;
      });
      rfb.addEventListener('securityfailure', (ev: unknown) => {
        const detail = (ev as { detail?: { reason?: string } }).detail;
        setErrorMsg(`认证失败：${detail?.reason ?? '未知原因'}`);
        setConnState('error');
      });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setConnState('error');
    }
  }, [disconnect, vncRunning]);

  // 离开页面时断开
  useEffect(() => () => disconnect(), [disconnect]);

  // 全屏 Esc 退出
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  // ── 进程控制 ──
  const toggleVncProcess = useCallback(async () => {
    setActionLoading(true);
    setErrorMsg(null);
    try {
      if (vncRunning) {
        disconnect();
        // 终止 = 杀进程 + 删除容器内 VNC/noVNC 软件与残留
        const status = await postVncAction('stop');
        setVncRunning(status.running);
        setConnState('idle');
      } else {
        // 启动 = 后端按需下载 VNC + noVNC 并轮询等待端口就绪
        const status = await postVncAction('start');
        setVncRunning(status.running);
        if (!status.running) {
          setErrorMsg('VNC 启动失败，请检查容器内 Xvfb 是否正常运行');
        }
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setActionLoading(false);
    }
  }, [vncRunning, disconnect]);

  const stateColor =
    connState === 'connected' ? 'text-log-success' :
    connState === 'connecting' ? 'text-log-info' :
    connState === 'error' ? 'text-log-error' :
    'text-muted-foreground';

  return (
    <div className={cn('flex h-full flex-col gap-3 p-4', fullscreen && 'fixed inset-0 z-50 bg-background p-4')}>
      {/* ── 工具栏：3 个按钮 + 状态指示 ── */}
      <Card className="shrink-0">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="flex flex-wrap items-center gap-2">
            {/* 连接 VNC */}
            <Button
              size="sm"
              onClick={connect}
              disabled={connState === 'connecting' || !vncRunning}
              title={!vncRunning ? '请先启动 VNC 服务' : undefined}
            >
              <Wifi className="size-3.5" />
              <span className="ml-1.5">连接VNC</span>
            </Button>

            {/* 全屏 */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFullscreen((f) => !f)}
            >
              {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              <span className="ml-1.5">{fullscreen ? '退出全屏' : '全屏'}</span>
            </Button>

            {/* 启动/终止 VNC 进程 */}
            <Button
              variant={vncRunning ? 'destructive' : 'default'}
              size="sm"
              onClick={toggleVncProcess}
              disabled={actionLoading}
            >
              {actionLoading ? (
                <RefreshCw className="size-3.5 animate-spin" />
              ) : vncRunning ? (
                <Square className="size-3.5" />
              ) : (
                <Play className="size-3.5" />
              )}
              <span className="ml-1.5">
                {actionLoading ? '处理中…' : vncRunning ? '终止VNC' : '启动VNC'}
              </span>
            </Button>
          </div>

          {/* 状态指示 */}
          <div className="flex items-center gap-3 text-xs">
            <div className={cn('flex items-center gap-1.5 font-medium', stateColor)}>
              {connState === 'connected' ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {stateLabel(connState)}
            </div>
            <div className={cn(
              'flex items-center gap-1.5 font-medium',
              vncRunning === null ? 'text-muted-foreground' :
              vncRunning ? 'text-log-success' : 'text-muted-foreground'
            )}>
              <Monitor className="size-3.5" />
              {vncRunning === null ? '检测中…' : vncRunning ? '服务运行中' : '服务未启动'}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── VNC 显示区域 ── */}
      <Card className="relative min-h-0 flex-1 overflow-hidden">
        <CardContent className="h-full p-0">
          <div
            ref={containerRef}
            className="relative flex h-full w-full items-center justify-center bg-black"
          >
            {/* noVNC 会在此插入 canvas。未连接时覆盖一层状态提示。 */}
            {connState !== 'connected' && (
              <div className="absolute inset-0 z-10 grid place-items-center">
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  {connState === 'error' ? (
                    <>
                      <MonitorOff className="size-12 opacity-50" />
                      <div className="max-w-md text-center">
                        <p className="text-sm font-medium text-foreground">无法连接到远程桌面</p>
                        {errorMsg && <p className="mt-1 text-xs">{errorMsg}</p>}
                        <p className="mt-2 text-xs">
                          请确认 VNC 服务已启动，然后点击「连接VNC」。
                        </p>
                      </div>
                    </>
                  ) : connState === 'idle' ? (
                    <>
                      <Monitor className="size-12 opacity-40" />
                      <div className="max-w-md text-center">
                        <p className="text-sm font-medium">远程桌面未连接</p>
                        <p className="mt-1 text-xs">
                          {vncRunning
                            ? '点击「连接VNC」开始远程会话。'
                            : '请先点击「启动VNC」，再点击「连接VNC」。'}
                        </p>
                      </div>
                    </>
                  ) : (
                    <>
                      <Monitor className="size-12 animate-pulse opacity-50" />
                      <p className="text-sm">{stateLabel(connState)}</p>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
