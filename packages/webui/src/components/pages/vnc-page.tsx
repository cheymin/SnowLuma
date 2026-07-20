import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, Monitor, MonitorOff, Plug, PlugZap } from 'lucide-react';
import { cn } from '@/lib/utils';

type ConnState = 'idle' | 'connecting' | 'connected' | 'error';

export function VncPage() {
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<unknown>(null);
  const [state, setState] = useState<ConnState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [vncReady, setVncReady] = useState(false);

  // Probe VNC server status on mount
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/vnc/status', {
          headers: { Authorization: `Bearer ${localStorage.getItem('snowluma_token')}` },
        });
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setVncReady(data.running === true);
        } else {
          setVncReady(false);
        }
      } catch {
        if (!cancelled) setVncReady(false);
      }
    };
    void check();
    const timer = setInterval(check, 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const connect = useCallback(async () => {
    if (rfbRef.current || !containerRef.current) return;
    setState('connecting');
    setErrorMsg('');

    try {
      // Dynamic import — noVNC is a heavy browser-only lib, load on demand.
      const { default: RFB } = await import('@novnc/novnc');

      const token = localStorage.getItem('snowluma_token') ?? '';
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/api/vnc/ws?token=${encodeURIComponent(token)}`;

      const rfb = new RFB(containerRef.current, url, {
        credentials: { password: '' },
        shared: true,
      });
      rfb.scaleViewport = true;
      rfb.resizeSession = true;

      rfb.addEventListener('connect', () => {
        setState('connected');
      });
      rfb.addEventListener('disconnect', (ev) => {
        const detail = ev.detail as { clean: boolean };
        if (detail.clean) {
          setState('idle');
        } else {
          setState('error');
          setErrorMsg('连接已断开，可能是 VNC 服务未运行');
        }
        rfbRef.current = null;
      });
      rfb.addEventListener('securityfailure', () => {
        setState('error');
        setErrorMsg('认证失败');
        rfbRef.current = null;
      });

      rfbRef.current = rfb;
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : '加载 noVNC 失败');
    }
  }, []);

  const disconnect = useCallback(() => {
    const rfb = rfbRef.current as { disconnect: () => void } | null;
    if (rfb) {
      rfb.disconnect();
      rfbRef.current = null;
    }
    setState('idle');
  }, []);

  useEffect(() => {
    return () => {
      const rfb = rfbRef.current as { disconnect: () => void } | null;
      if (rfb) rfb.disconnect();
      rfbRef.current = null;
    };
  }, []);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col gap-4">
      <motion.header
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="sticky top-0 z-20 flex items-center justify-between rounded-2xl bg-background/60 px-4 py-3 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Monitor className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold leading-tight">远程桌面</h1>
            <p className="text-sm text-muted-foreground">
              通过 noVNC 远程连接容器内 QQ 桌面客户端
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge state={state} vncReady={vncReady} />
          {state === 'connected' || state === 'connecting' ? (
            <button
              onClick={disconnect}
              disabled={state === 'connecting'}
              className="inline-flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20 disabled:opacity-50"
            >
              <PlugZap className="h-4 w-4" />
              断开
            </button>
          ) : (
            <button
              onClick={connect}
              disabled={!vncReady && state !== 'error'}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Plug className="h-4 w-4" />
              连接
            </button>
          )}
        </div>
      </motion.header>

      <div className="relative flex-1 overflow-hidden rounded-2xl border bg-card/50">
        {/* noVNC renders into this container */}
        <div ref={containerRef} className="h-full w-full" />

        {state === 'idle' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Monitor className="h-12 w-12 opacity-40" />
            <p className="text-sm">点击「连接」开始远程桌面会话</p>
            {!vncReady && (
              <p className="text-xs text-amber-500/80">VNC 服务未就绪，请稍候…</p>
            )}
          </div>
        )}

        {state === 'connecting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin opacity-60" />
            <p className="text-sm">正在连接…</p>
          </div>
        )}

        {state === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
            <MonitorOff className="h-12 w-12 text-destructive/50" />
            <p className="text-sm text-destructive">{errorMsg || '连接失败'}</p>
            <button
              onClick={connect}
              className="rounded-lg bg-primary/10 px-3 py-1.5 text-sm text-primary transition-colors hover:bg-primary/20"
            >
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ state, vncReady }: { state: ConnState; vncReady: boolean }) {
  const config = {
    idle: { label: vncReady ? 'VNC 就绪' : 'VNC 未就绪', className: vncReady ? 'bg-emerald-500/10 text-emerald-600' : 'bg-amber-500/10 text-amber-600' },
    connecting: { label: '连接中', className: 'bg-blue-500/10 text-blue-600' },
    connected: { label: '已连接', className: 'bg-emerald-500/10 text-emerald-600' },
    error: { label: '错误', className: 'bg-destructive/10 text-destructive' },
  };
  const { label, className } = config[state];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', className)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  );
}
