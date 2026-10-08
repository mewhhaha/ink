const { app, BrowserWindow, protocol, net, session } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([{
  scheme: "ink-game",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}]);
app.commandLine.appendSwitch("enable-unsafe-webgpu");
if (process.platform === "linux") {
  const features = app.commandLine.getSwitchValue("enable-features");
  app.commandLine.appendSwitch(
    "enable-features",
    [features, "Vulkan"].filter(Boolean).join(","),
  );
  if (!app.commandLine.hasSwitch("use-angle")) {
    app.commandLine.appendSwitch("use-angle", "vulkan");
  }
  app.commandLine.appendSwitch("disable-vulkan-surface");
}
app.whenReady().then(async () => {
  const root = path.resolve(__dirname, "web");
  protocol.handle("ink-game", (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "game") {
        return new Response("Not found", { status: 404 });
      }
      const file = path.resolve(root, "." + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + path.sep)) {
        return new Response("Not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(file).href);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler((
    _contents,
    permission,
    callback,
  ) => callback(permission === "pointerLock"));
  const createWindow = async () => {
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      title: app.getName(),
      autoHideMenuBar: true,
      show: !app.commandLine.hasSwitch("headless"),
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("ink-game://game/")) event.preventDefault();
    });
    await window.loadURL(
      "ink-game://game/index.html" +
        (app.commandLine.hasSwitch("ink-automation") ? "?ink-automation" : ""),
    );
  };
  await createWindow();
  app.on("activate", () => {
    if (!BrowserWindow.getAllWindows().length) createWindow();
  });
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
