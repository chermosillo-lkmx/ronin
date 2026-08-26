export interface SecurityWebContents {
  on(event: "will-navigate", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  setWindowOpenHandler(listener: (details: { url: string }) => { action: "deny" }): unknown;
}

export interface WindowSecurityDependencies {
  openExternal(url: string): Promise<void> | void;
}

function allowedNavigation(url: string, dev: boolean): boolean {
  try {
    const parsed = new URL(url);
    if (!dev) return parsed.protocol === "app:" && parsed.hostname === "ronin" && !parsed.port;
    return parsed.origin === "http://localhost:5180";
  } catch {
    return false;
  }
}

export function installWindowSecurity(webContents: SecurityWebContents, deps: WindowSecurityDependencies, dev: boolean): void {
  webContents.on("will-navigate", (event, url) => {
    if (!allowedNavigation(url, dev)) event.preventDefault();
  });
  webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "http:" || protocol === "https:") void deps.openExternal(url);
    } catch {
      // The popup remains denied; malformed URLs never reach the shell.
    }
    return { action: "deny" };
  });
}
