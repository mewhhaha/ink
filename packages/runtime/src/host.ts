import type { RuntimeSession, RuntimeSessionOptions } from "./session.ts";
import { create_runtime_session } from "./session.ts";

export function create_headless_session<input, observation>(
  options: RuntimeSessionOptions<input, observation>,
): Promise<RuntimeSession<input, observation>> {
  options.observer.event("runtime.host.created", { host: "headless" });
  return create_runtime_session(options);
}

export function create_browser_session<input, observation>(
  options: RuntimeSessionOptions<input, observation>,
): Promise<RuntimeSession<input, observation>> {
  options.observer.event("runtime.host.created", { host: "browser" });
  return create_runtime_session(options);
}
