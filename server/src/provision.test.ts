import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PROVISION_TIMEOUT_MS, provisionWorktree, readProvisionState, writeProvisionState } from "./provision.js";

function conCiclo(fn: (cycle: string) => Promise<void> | void): Promise<void> | void {
  const cycle = mkdtempSync(join(tmpdir(), "ronin-prov-"));
  const cerrar = () => rmSync(cycle, { recursive: true, force: true });
  try {
    const out = fn(cycle);
    return out instanceof Promise ? out.finally(cerrar) : void cerrar();
  } catch (error) {
    cerrar();
    throw error;
  }
}

test("readProvisionState: sin archivo devuelve null y nunca lanza", () => {
  conCiclo((cycle) => {
    assert.equal(readProvisionState(cycle), null);
    assert.equal(readProvisionState("/no/existe/en/ningun/sitio"), null);
  });
});

test("el estado va y vuelve del cycle dir", () => {
  conCiclo((cycle) => {
    writeProvisionState(cycle, { status: "ok", startedAt: 10, finishedAt: 20, output: "listo" });
    assert.deepEqual(readProvisionState(cycle), { status: "ok", startedAt: 10, finishedAt: 20, output: "listo" });
  });
});

test("provisionWorktree deja `running` ANTES de ejecutar y `ok` al salir bien", async () => {
  await conCiclo(async (cycle) => {
    const vistos: string[] = [];
    const estado = await provisionWorktree(cycle, "/wt", "instalar", {
      run: async () => {
        // El estado ya debe estar en disco mientras el comando corre: si el server se reinicia
        // a media instalación, al volver se sabe que había una provisión en vuelo.
        vistos.push(readProvisionState(cycle)?.status ?? "ninguno");
        return { ok: true, code: 0, output: "instalado" };
      },
    });

    assert.deepEqual(vistos, ["running"]);
    assert.equal(estado.status, "ok");
    assert.equal(estado.output, "instalado");
    assert.equal(readProvisionState(cycle)?.status, "ok");
  });
});

test("provisionWorktree recibe el comando y el worktree tal cual", async () => {
  await conCiclo(async (cycle) => {
    const llamadas: { cmd: string; cwd: string; timeout: number }[] = [];
    await provisionWorktree(cycle, "/wt", "python3 -m venv .venv", {
      run: async (cmd, cwd, timeout) => {
        llamadas.push({ cmd, cwd, timeout });
        return { ok: true, code: 0, output: "" };
      },
    });
    assert.deepEqual(llamadas, [{ cmd: "python3 -m venv .venv", cwd: "/wt", timeout: PROVISION_TIMEOUT_MS }]);
  });
});

test("un comando que sale ≠0 deja `failed` con su salida", async () => {
  await conCiclo(async (cycle) => {
    const estado = await provisionWorktree(cycle, "/wt", "falla", {
      run: async () => ({ ok: false, code: 1, output: "no such file: requirements.txt" }),
    });
    assert.equal(estado.status, "failed");
    assert.match(estado.output ?? "", /requirements/);
    assert.equal(readProvisionState(cycle)?.status, "failed");
  });
});

test("un ejecutor que lanza deja `failed` y no propaga: una provisión rota no puede tumbar el lanzamiento", async () => {
  await conCiclo(async (cycle) => {
    const estado = await provisionWorktree(cycle, "/wt", "explota", {
      run: async () => { throw new Error("spawn EACCES"); },
    });
    assert.equal(estado.status, "failed");
    assert.match(estado.output ?? "", /EACCES/);
    assert.equal(readProvisionState(cycle)?.status, "failed");
  });
});

test("un cycle dir inexistente no hace fallar la provisión", async () => {
  const estado = await provisionWorktree("/no/existe/tampoco", "/wt", "cmd", {
    run: async () => ({ ok: true, code: 0, output: "" }),
  });
  assert.equal(estado.status, "ok");
});
