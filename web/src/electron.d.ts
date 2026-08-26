import type { NativeTerminalBridge } from "./components/native-terminal-controller";

declare global {
  interface Window {
    roninDesktop?: {
      terminal: NativeTerminalBridge;
    };
  }
}

export {};
