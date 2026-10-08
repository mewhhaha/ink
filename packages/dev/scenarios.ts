/** Scenario files live beside a game; recorded input paths stay in its project. */
import { join } from "@std/path";
import type { Scenario } from "@ink/core";
import type { InputModel } from "@ink/schema";
import { checkName, resolveInside } from "./paths.ts";
import type { ResolvedProject } from "./node.ts";

export async function listScenarios(
  project: ResolvedProject,
): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(join(project.dir, "scenarios"))) {
      if (e.isFile && e.name.endsWith(".scenario.json")) {
        out.push(e.name.slice(0, -".scenario.json".length));
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return out.sort();
}

export async function loadScenario(
  project: ResolvedProject,
  name: string,
): Promise<Scenario> {
  const path = join(
    project.dir,
    "scenarios",
    `${checkName(name)}.scenario.json`,
  );
  const raw = JSON.parse(await Deno.readTextFile(path)) as
    & Omit<Scenario, "inputs">
    & { inputs?: InputModel[] | string };
  const inputs = typeof raw.inputs === "string"
    ? JSON.parse(
      await Deno.readTextFile(resolveInside(project.dir, raw.inputs)),
    ) as InputModel[]
    : raw.inputs;
  return { ...raw, inputs };
}
