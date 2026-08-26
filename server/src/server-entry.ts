import { startServer, type ServerHandle } from "./index.js";

type UtilityParentPort = { postMessage(message: unknown): void };
const parentPort = (process as NodeJS.Process & { parentPort?: UtilityParentPort }).parentPort;

let handle: ServerHandle | undefined;
let stopping: Promise<void> | undefined;

async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return stopping;
  stopping = (async () => {
    await handle?.close();
    process.exit(exitCode);
  })();
  return stopping;
}

startServer()
  .then((started) => {
    handle = started;
    parentPort?.postMessage({ type: "ronin-backend-listening", version: 1, port: started.port });
  })
  .catch(() => {
    console.error("[ronin] server startup failed");
    void shutdown(1);
  });

process.once("SIGINT", () => { void shutdown(0); });
process.once("SIGTERM", () => { void shutdown(0); });
