interface ReferenceFile {
  readonly destination: URL;
  readonly digest: string;
  readonly source: URL;
}

const bevy_revision = "227d3a6c661b3bdf3020d3e8290b5a6ffd0226f7";
const source_root = new URL(
  `https://raw.githubusercontent.com/bevyengine/bevy/${bevy_revision}/`,
);
const destination_root = new URL(
  "../apps/lighting-dev/assets/bevy/",
  import.meta.url,
);
const reference_files: readonly ReferenceFile[] = [
  {
    destination: new URL("VolumetricFogExample.glb", destination_root),
    digest: "8db4886743bd0e8a98d964328a1cc58d218cd7d12cdfcd6ed66d266e741cde71",
    source: new URL(
      "assets/models/VolumetricFogExample/VolumetricFogExample.glb",
      source_root,
    ),
  },
  {
    destination: new URL("LICENSE-MIT", destination_root),
    digest: "508a77d2e7b51d98adeed32648ad124b7b30241a8e70b2e72c99f92d8e5874d1",
    source: new URL("LICENSE-MIT", source_root),
  },
  {
    destination: new URL("LICENSE-APACHE", destination_root),
    digest: "a6cba85bc92e0cff7a450b1d873c0eaa2e9fc96bf472df0247a26bec77bf3ff9",
    source: new URL("LICENSE-APACHE", source_root),
  },
];
const source_note = `# Bevy reference scene

\`VolumetricFogExample.glb\` is copied from Bevy revision
\`${bevy_revision}\`:

https://github.com/bevyengine/bevy/blob/${bevy_revision}/assets/models/VolumetricFogExample/VolumetricFogExample.glb

SHA-256: \`8db4886743bd0e8a98d964328a1cc58d218cd7d12cdfcd6ed66d266e741cde71\`

Bevy distributes the asset under either LICENSE-MIT or LICENSE-APACHE. Both
license texts are retained beside the model.
`;

const check = Deno.args.length === 1 && Deno.args[0] === "--check";
if (!check && Deno.args.length !== 0) {
  throw new Error(
    `usage: deno run scripts/sync_bevy_reference_scene.ts [--check], received ${
      JSON.stringify(Deno.args)
    }`,
  );
}

if (!check) await Deno.mkdir(destination_root, { recursive: true });
for (const reference of reference_files) {
  let bytes: Uint8Array;
  if (check) {
    try {
      bytes = await Deno.readFile(reference.destination);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      throw new Error(
        `Bevy reference file ${reference.destination.pathname} is missing; run pnpm sync:bevy-scene`,
      );
    }
  } else {
    const response = await fetch(reference.source);
    if (!response.ok) {
      throw new Error(
        `Bevy reference download ${reference.source} failed with HTTP ${response.status}`,
      );
    }
    bytes = new Uint8Array(await response.arrayBuffer());
  }
  const digest_source = Uint8Array.from(bytes);
  const digest = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", digest_source.buffer),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  if (digest !== reference.digest) {
    throw new Error(
      `Bevy reference file ${reference.source} has SHA-256 ${digest}; expected ${reference.digest}`,
    );
  }
  if (!check) await Deno.writeFile(reference.destination, bytes);
}
const source_note_path = new URL("SOURCE.md", destination_root);
if (check) {
  let current_note: string;
  try {
    current_note = await Deno.readTextFile(source_note_path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    throw new Error(
      `Bevy reference attribution ${source_note_path.pathname} is missing; run pnpm sync:bevy-scene`,
    );
  }
  if (current_note !== source_note) {
    throw new Error(
      `Bevy reference attribution ${source_note_path.pathname} is stale; run pnpm sync:bevy-scene`,
    );
  }
} else {
  await Deno.writeTextFile(source_note_path, source_note);
}

console.log(
  `${
    check ? "verified" : "synchronized"
  } Bevy reference scene ${bevy_revision}`,
);
