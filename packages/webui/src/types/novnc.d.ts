/**
 * Minimal type declarations for @novnc/novnc (the library ships no .d.ts).
 * Only the surface used by VncPage is typed; extend as needed.
 */
declare module '@novnc/novnc' {
  export type RFBEvent<T = unknown> = {
    type: string;
    detail: T;
  };

  export interface RFBOptions {
    credentials?: { password?: string; username?: string; target?: string } | Record<string, string>;
    shared?: boolean;
    repeaterID?: string;
    wsProtocols?: string[];
  }

  export default class RFB {
    constructor(target: HTMLElement, urlOrChannel: string, options?: RFBOptions);

    readonly readyState: number;
    static readonly CONNECTING: number;
    static readonly OPEN: number;
    static readonly CLOSING: number;
    static readonly CLOSED: number;

    // Properties used by VncPage.
    scaleViewport: boolean;
    resizeSession: boolean;
    showDotCursor: boolean;

    // Common event listeners. noVNC dispatches CustomEvents whose `detail`
    // carries the payload.
    addEventListener(type: string, listener: (event: RFBEvent) => void): void;
    removeEventListener(type: string, listener: (event: RFBEvent) => void): void;

    // Lifecycle.
    disconnect(): void;
    sendCredentials(credentials: { password?: string }): void;
    sendKey(keysym: number, code: string, down?: boolean): void;
    focus(): void;
    blur(): void;
    getCapabilities(): Record<string, unknown>;
    sendCtrlAltDel(): void;
    machineShutdown(): void;
    machineReboot(): void;
    machineReset(): void;
    clipViewport(): void;
    requestDesktopSize(width: number, height: number): void;
  }
}
