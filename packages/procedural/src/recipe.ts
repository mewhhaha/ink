import {
  generator_revision,
  type GeneratorRevision,
  procedural_seed,
  type ProceduralSeed,
} from "./identity.ts";
import { scatter_recipe, type ScatterRecipe } from "./scatter.ts";

export interface ProceduralRecipeInput {
  readonly seed: bigint;
  readonly revision: string;
  readonly scatter: Omit<ScatterRecipe, "seed" | "revision">;
}

export interface ProceduralRecipe {
  readonly seed: ProceduralSeed;
  readonly revision: GeneratorRevision;
  readonly scatter: ScatterRecipe;
}

export function procedural_recipe(
  source: ProceduralRecipeInput,
): ProceduralRecipe {
  const seed = procedural_seed(source.seed);
  const revision = generator_revision(source.revision);
  return Object.freeze({
    seed,
    revision,
    scatter: scatter_recipe({ ...source.scatter, seed, revision }),
  });
}
