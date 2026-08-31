import { join } from "node:path";
import { pathToFileURL } from "node:url";

const repository = Deno.args[0];
if (repository === undefined || repository.trim() === "") {
  throw new Error("Blot repository path is required");
}

const compilerModule = await import(
  pathToFileURL(join(repository, "src/compiler.ts")).href
);
const artifactModule = await import(
  pathToFileURL(join(repository, "src/compiler/artifact.ts")).href
);
const compilerInputsModule = await import(
  pathToFileURL(join(repository, "scripts/compiler_inputs.ts")).href
);
const hostAbiModule = await import(
  pathToFileURL(join(repository, "src/compiler/host_abi.ts")).href
);

const inputIdentity = await compilerInputsModule.compilerInputIdentity();
const production = await readDistribution({
  directory: join(repository, "generated/compiler"),
  profile: "production",
});
const development = await readDistribution({
  directory: join(repository, "compiler/target/development-profile"),
  profile: "development-profile",
});
const finalInputIdentity = await compilerInputsModule.compilerInputIdentity();
if (finalInputIdentity !== inputIdentity) {
  throw new Error(
    `Blot compiler inputs changed during distribution validation: ${inputIdentity} became ${finalInputIdentity}`,
  );
}

await verifyIncrementalActivation(development);
console.log(
  `validated Blot production ${
    production.manifest.sha256.slice(0, 12)
  } and development ${development.manifest.sha256.slice(0, 12)}`,
);

async function readDistribution({ directory, profile }) {
  const [wasm, manifestSource, preludeSnapshot] = await Promise.all([
    Deno.readFile(join(directory, "compiler.wasm")),
    Deno.readTextFile(join(directory, "compiler-artifact.json")),
    Deno.readFile(join(directory, "prelude.snapshot")),
  ]);
  const manifest = artifactModule.decodeCompilerArtifactManifest(
    manifestSource,
  );
  await artifactModule.validateCompilerArtifact(wasm, manifest, {
    hostAbi: hostAbiModule.COMPILER_HOST_ABI_VERSION,
    preludeSha256: await artifactModule.sha256(preludeSnapshot),
    compilerInputsSha256: inputIdentity,
    profile,
  });
  return { manifest, preludeSnapshot, wasm };
}

async function verifyIncrementalActivation(distribution) {
  const directory = await Deno.makeTempDir({ prefix: "ink-blot-toolchain-" });
  const manifestPath = join(directory, "blot.json");
  const entryPath = join(directory, "main.blot");
  const providerPath = join(directory, "provider.blot");
  let project;
  let pendingActivation;
  let pendingBuild;
  const runtime = new compilerModule.DevelopmentRuntime(() => ({
    "blot:host/Source": { value: () => 10n },
  }));
  try {
    project = await createProject();
    const initial = await project.prepareBuild();
    pendingBuild = initial;
    requireUnitNames(initial.changedUnits, ["game", "provider"], "initial");
    const initialActivation = await runtime.prepareActivation(initial);
    pendingActivation = initialActivation;
    project.commitBuild(initial);
    pendingBuild = undefined;
    runtime.commitActivation(initialActivation);
    pendingActivation = undefined;
    requireResult(runtime.entryInstance, 141n, "initial");

    await Deno.writeTextFile(providerPath, providerSource(", request.seed"));
    await project.markChanged(providerPath);
    const edited = await project.prepareBuild();
    pendingBuild = edited;
    requireUnitNames(edited.changedUnits, ["provider"], "edited changed");
    requireUnitNames(edited.retainedUnits, ["game"], "edited retained");

    const provider = edited.changedUnits[0];
    if (provider === undefined) {
      throw new Error("edited Blot build omitted its provider unit");
    }
    const invalid = {
      ...edited,
      changedUnits: [{ ...provider, wasm: Uint8Array.of(0) }],
    };
    let rejected = false;
    try {
      await runtime.prepareActivation(invalid);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      throw new Error(
        "Blot development runtime accepted invalid replacement Wasm",
      );
    }
    requireResult(runtime.entryInstance, 141n, "rejected replacement");

    const editedActivation = await runtime.prepareActivation(edited);
    pendingActivation = editedActivation;
    requireResult(runtime.entryInstance, 141n, "prepared replacement");
    project.commitBuild(edited);
    pendingBuild = undefined;
    runtime.commitActivation(editedActivation);
    pendingActivation = undefined;
    requireResult(runtime.entryInstance, 142n, "committed replacement");
  } finally {
    if (pendingActivation !== undefined) {
      runtime.abortActivation(pendingActivation);
    }
    if (pendingBuild !== undefined) project?.abortBuild(pendingBuild);
    project?.destroy();
    await Deno.remove(directory, { recursive: true });
  }

  async function createProject() {
    await Promise.all([
      Deno.writeTextFile(entryPath, entrySource()),
      Deno.writeTextFile(providerPath, providerSource("")),
      Deno.writeTextFile(
        manifestPath,
        JSON.stringify({
          schema: "blot-project",
          version: 1,
          entryUnit: "game",
          units: {
            game: "./main.blot",
            provider: "./provider.blot",
          },
        }),
      ),
    ]);
    return await compilerModule.DevelopmentProject.create(manifestPath, {
      wasm: distribution.wasm,
      preludeSnapshot: distribution.preludeSnapshot,
    });
  }
}

function entrySource() {
  return `open import "blot:prelude"
const codec = import "./provider.blot"
const Source = @effect.host { .value = Unit -> Int; }
use value <- Source.value ()
let values = [value, value + 1]
let response = codec.expand {
  .choice = #Some (value + 2);
  .label = "oak";
  .seed = value + 3;
  .values = values;
}
let first = case Array.get (response.values, 0) of
  #Some found => found
  #None => 0
let third = case Array.get (response.values, 2) of
  #Some found => found
  #None => 0
let chosen = case response.choice of
  #Some found => found
  #None => 0
let unchanged = case Array.get (values, 2) of
  #Some _ => 0
  #None => 100
return
  first + third + chosen + @text.len response.label + unchanged +
  Array.length response.values
`;
}

function providerSource(extraSeed) {
  return `open import "blot:prelude"
let expand = fn request => {
  .choice = request.choice;
  .label = request.label;
  .values = [...request.values, request.seed${extraSeed}];
}
return { .expand = expand; }
`;
}

function requireUnitNames(units, expected, phase) {
  const actual = units.map((unit) => unit.name).sort();
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  const evidence = units.map((unit) => ({
    name: unit.name,
    root: unit.root,
    artifactSource: unit.artifactSource,
    interfaceDigest: unit.interfaceDigest,
    implementationDigest: unit.implementationDigest,
  }));
  throw new Error(
    `${phase} Blot units were ${JSON.stringify(evidence)}, expected names ${
      JSON.stringify(expected)
    }`,
  );
}

function requireResult(instance, expected, phase) {
  const run = instance.exports["blot:default"];
  if (typeof run !== "function") {
    throw new Error(`${phase} Blot entry unit omitted blot:default`);
  }
  const actual = run();
  if (actual === expected) return;
  throw new Error(
    `${phase} Blot entry returned ${String(actual)}, expected ${
      String(expected)
    }`,
  );
}
