import { fileURLToPath } from "node:url";

const required_blot_revision = "f5041e2a5cef4efec79a899fb29794482ca41ebd";
const blot_repository = fileURLToPath(
  new URL("../../../blot", import.meta.url),
);

const revision_check = await new Deno.Command("git", {
  args: ["-C", blot_repository, "rev-parse", "HEAD"],
}).output();

if (!revision_check.success) {
  const failure = new TextDecoder().decode(revision_check.stderr).trim();
  throw new Error(
    `cannot read Blot revision from ${blot_repository}: ${failure}`,
  );
}

const actual_blot_revision = new TextDecoder()
  .decode(revision_check.stdout)
  .trim();

if (actual_blot_revision !== required_blot_revision) {
  throw new Error(
    `Blot checkout ${blot_repository} is at ${actual_blot_revision}; expected ${required_blot_revision}`,
  );
}

console.log(`Blot toolchain revision ${actual_blot_revision}`);
