export const application_updated_event = "ink:application-updated";

export type ApplicationUpdate =
  | { readonly type: "game" }
  | { readonly type: "resources" }
  | { readonly type: "resource_error"; readonly message: string }
  | { readonly type: "compilation_error"; readonly message: string };

export interface ApplicationUpdateChannel {
  on(
    event: typeof application_updated_event,
    callback: (update: ApplicationUpdate) => void,
  ): void;
  off(
    event: typeof application_updated_event,
    callback: (update: ApplicationUpdate) => void,
  ): void;
}

export function subscribe_to_application_updates(
  channel: ApplicationUpdateChannel,
  callback: (update: ApplicationUpdate) => void,
): () => void {
  if (typeof channel?.on !== "function" || typeof channel?.off !== "function") {
    throw new Error("application update channel needs on and off functions");
  }
  if (typeof callback !== "function") {
    throw new Error("application update callback must be a function");
  }
  channel.on(application_updated_event, callback);
  return () => channel.off(application_updated_event, callback);
}
