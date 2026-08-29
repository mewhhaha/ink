import { mount_application } from "./application.tsx";

const application = document.getElementById("application");
if (!(application instanceof HTMLElement)) {
  throw new Error("roleplaying-dev index is missing the application element");
}
mount_application(application);
