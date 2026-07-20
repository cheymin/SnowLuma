declare const __APP_VERSION__: string;

declare module '@novnc/novnc' {
  interface RFBOptions {
    shared?: boolean;
    credentials?: { password: string };
    repeaterID?: string;
  }
  interface RFBAutoUpdateEvent {
    detail: { x: number; y: number; width: number; height: number };
  }
  interface RFBConnectEvent {
    detail: { securitycontext?: unknown };
  }
  interface RFBDisconnectEvent {
    detail: { clean: boolean };
  }
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: RFBOptions);
    disconnect(): void;
    sendCtrlAltDel(): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;
    getCapabilities(): Record<string, unknown>;
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;
    qualityLevel: number;
    compressionLevel: number;
    addEventListener(type: string, listener: (e: { detail: unknown }) => void): void;
    removeEventListener(type: string, listener: (e: { detail: unknown }) => void): void;
    static readonly messages: Record<string, string>;
  }
}

