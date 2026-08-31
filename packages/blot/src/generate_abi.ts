import {
  blot_abi_contract_source,
  blot_host_declarations_source,
} from "./abi.ts";

if (import.meta.main) {
  await Promise.all([
    Deno.writeTextFile(
      new URL("../abi.blot", import.meta.url),
      blot_host_declarations_source(),
    ),
    Deno.writeTextFile(
      new URL("../testdata/abi_registry_contract.blot", import.meta.url),
      blot_abi_contract_source(),
    ),
  ]);
}
