import {
  createCompiler,
  type Guest,
  instantiateGuest,
  type ZigProjectCompiler,
} from "@mewhhaha/blot";
import { libraryUrl } from "../mod.ts";
import { blotRoot } from "../tools/setup.ts";

export interface Fixture {
  guest: Guest;
  compiler: ZigProjectCompiler;
  dispose(): Promise<void>;
}

/** Tests use the upstream compiler and guest directly. */
export async function compile(entry: URL): Promise<Fixture> {
  const compiler = await createCompiler({
    entry,
    imports: { "ink/": libraryUrl },
    executable: new URL("zig-native/zig-out/bin/blotc", blotRoot),
    stdRoot: new URL("std/", blotRoot),
    prelude: new URL("std/prelude.blot", blotRoot),
  });
  try {
    const result = await compiler.build();
    if (!result.success) {
      throw new Error(JSON.stringify(result.diagnostics, null, 2));
    }
    const guest = await instantiateGuest(result.bytes);
    return {
      guest,
      compiler,
      async dispose() {
        try {
          guest.dispose();
        } finally {
          await compiler.dispose();
        }
      },
    };
  } catch (error) {
    await compiler.dispose();
    throw error;
  }
}
