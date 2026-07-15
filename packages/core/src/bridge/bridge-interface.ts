import type { BridgeContext } from './bridge-context';

export interface BridgeInterface extends BridgeContext {
  readonly activePid: number | null;
  /** False only when every attached QQ process is confirmed stale.
   *  An unarmed watchdog remains true for compatibility. */
  readonly receiveHealthy: boolean;
}
