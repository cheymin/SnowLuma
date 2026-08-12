import { useCallback, useEffect, useRef, useState } from 'react';
import RFB from '@novnc/novnc';
import { Monitor, MonitorOff, RefreshCw, Maximize2, Minimize2, Wifi, WifiOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';

const TOKEN_KEY = 'snowluma_token';

type ConnState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'error';

function buildWsUrl(token: string | null): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // The VNC proxy authenticates via `?token=` — same WebUI session credential.
  const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
  return `${proto}//${window.location.host}/vnc${tokenQuery}`;
}

function getStateLabel(state: ConnState): string {
  switch (state) {
    case 'idle': return '未连接';
    case 'connecting': return '连接中…';
    case 'connected': return '已连接';
    case 'disconnected': return '已断开';
    case 'error': return '连接失败';
  }
}

/**
 * VNC 桌面页面：通过 WebUI 单端口 (7860) 上的 `/vnc` WebSocket 代理连接到
 * 容器内 x11vnc (RFB :5900)。使用 noVNC 核心库渲染远程桌面。
 *
 * 认证：复用 WebUI 登录会话令牌（localStorage 中的 `snowluma_token`），
 * 通过 `?token=` 查询参数传递给 WS 升级请求，后端校验后才转发到 RFB。
 */
export function VncPage() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [state, setState] = useState<ConnState>('idle');
  const [scale, setScale] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const disconnect = useCallback(() => {
    const rfb = rfbRef.current;
    if (rfb) {
      try { rfb.disconnect(); } catch {}
      rfbRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    disconnect();
    setErrorMsg(null);
    const container = containerRef.current;
    if (!container) return;

    const token = localStorage.getItem(TOKEN_KEY);
    const url = buildWsUrl(token);
    setState('connecting');

    try {
      // noVNC 的 RFB 构造器会立即发起 WebSocket 升级并完成 RFB 握手。
      // `target` 是一个 DOM 元素，RFB 会在此插入 <canvas>。
      const rfb = new RFB(container, url, {
        // 容器内 x11vnc 启动时使用 -nopw，所以这里无需密码。
        credentials: { password: '' },
      });
      rfbRef.current = rfb;

      // 缩放模式：让远程桌面自适应容器大小。
      rfb.scaleViewport = scale;
      rfb.resizeSession = false;

      rfb.addEventListener('connect', () => {
        setState('connected');
      });
      rfb.addEventListener('disconnect', (ev: unknown) => {
        const detail = (ev as { detail?: { clean?: boolean } }).detail;
        setState(detail?.clean ? 'disconnected' : 'error');
        if (!detail?.clean) setErrorMsg('远程桌面连接已断开');
        rfbRef.current = null;
      });
      rfb.addEventListener('securityfailure', (ev: unknown) => {
        const detail = (ev as { detail?: { reason?: string } }).detail;
        setErrorMsg(`认证失败：${detail?.reason ?? '未知原因'}`);
        setState('error');
      });
      rfb.addEventListener('desktopname', (ev: unknown) => {
        const detail = (ev as { detail?: { name?: string } }).detail;
        if (detail?.name) document.title = `${detail.name} · SnowLuma`;
      });
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }, [disconnect, scale]);

  // 切换缩放时实时应用到已存在的 RFB 实例。
  useEffect(() => {
    if (rfbRef.current) rfbRef.current.scaleViewport = scale;
  }, [scale]);

  // 进入页面自动连接，离开时断开。
  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect]);

  // 全屏切换。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const stateColor =
    state === 'connected' ? 'text-log-success' :
    state === 'connecting' ? 'text-log-info' :
    state === 'error' ? 'text-log-error' :
    'text-muted-foreground';

  return (
    <div className={cn('flex h-full flex-col gap-4 p-4', fullscreen && 'fixed inset-0 z-50 bg-background p-4')}>
      {/* 工具栏 */}
      <Card className="shrink-0">
        <CardHeader className="flex flex-row items-center justify-between gap-4 py-3">
          <div className="flex items-center gap-3">
            <div className="grid size-9 place-items-center rounded-lg bg-primary/10 ring-1 ring-primary/20">
              <Monitor className="size-4 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">远程桌面</CardTitle>
              <CardDescription className="text-xs">通过 VNC 访问容器内 QQ 桌面</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className={cn('flex items-center gap-1.5 rounded-md bg-muted/50 px-2.5 py-1.5 text-xs font-medium', stateColor)}>
              {state === 'connected' ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              {getStateLabel(state)}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setScale((s) => !s)}
              title={scale ? '切换到 1:1 原始尺寸' : '切换到自适应缩放'}
            >
              {scale ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              <span className="ml-1.5">{scale ? '原始尺寸' : '自适应'}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setFullscreen((f) => !f)}
              title={fullscreen ? '退出全屏 (Esc)' : '全屏'}
            >
              {fullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
              <span className="ml-1.5">{fullscreen ? '退出全屏' : '全屏'}</span>
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={connect}
              disabled={state === 'connecting'}
            >
              <RefreshCw className={cn('size-3.5', state === 'connecting' && 'animate-spin')} />
              <span className="ml-1.5">重连</span>
            </Button>
          </div>
        </CardHeader>
      </Card>

      {/* 桌面画布 */}
      <Card className="relative min-h-0 flex-1 overflow-hidden">
        <CardContent className="h-full p-0">
          <div
            ref={containerRef}
            className={cn(
              'relative h-full w-full bg-black',
              scale ? 'flex items-center justify-center' : 'overflow-auto',
            )}
          >
            {/* noVNC 会在此插入 canvas。未连接时覆盖一层状态提示。 */}
            {state !== 'connected' && (
              <div className="absolute inset-0 z-10 grid place-items-center">
                <div className="flex flex-col items-center gap-3 text-muted-foreground">
                  {state === 'error' ? (
                    <>
                      <MonitorOff className="size-12 opacity-50" />
                      <div className="text-center">
                        <p className="text-sm font-medium text-foreground">无法连接到远程桌面</p>
                        {errorMsg && <p className="mt-1 max-w-md text-xs">{errorMsg}</p>}
                        <p className="mt-2 text-xs">请确认容器内 x11vnc 已启动，然后点击「重连」。</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <Monitor className="size-12 animate-pulse opacity-50" />
                      <p className="text-sm">{getStateLabel(state)}</p>
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
