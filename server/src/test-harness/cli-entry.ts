import { createHarnessStore } from "./config.js";
import { runCli } from "./cli.js";
import { createTestHarnessService } from "./service.js";

/** Entrada ejecutable (`node server/dist/test-harness/cli-entry.js …`). Sin agente, sin servidor HTTP. */
const harness = createTestHarnessService({ store: createHarnessStore() });
runCli(process.argv.slice(2), harness, { log: (l) => console.log(l), error: (l) => console.error(l) })
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  });
