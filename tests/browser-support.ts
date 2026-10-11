import { browserPath } from "../tools/browser.ts";
import { sourceServer } from "../tools/source-server.ts";

const pause = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function bounded<T>(
  operation: Promise<T>,
  milliseconds: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Every CDP request settles, including requests sent to an unresponsive page. */
export async function cdp(
  ws: WebSocket,
  milliseconds = 5000,
  opening = milliseconds,
) {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      finish(new Error("CDP connection timed out"));
      ws.close();
    }, opening);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      ws.removeEventListener("open", open);
      ws.removeEventListener("error", failed);
      ws.removeEventListener("close", failed);
      if (error) reject(error);
      else resolve();
    };
    const open = () => finish();
    const failed = () => finish(new Error("CDP connection failed"));
    ws.addEventListener("open", open, { once: true });
    ws.addEventListener("error", failed, { once: true });
    ws.addEventListener("close", failed, { once: true });
  });
  let id = 0;
  const logs: string[] = [];
  const pending = new Map<number, {
    finish(error?: Error, result?: unknown): void;
  }>();
  const record = (message: string) => {
    logs.push(message);
    if (logs.length > 50) logs.shift();
  };
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (
      message.method === "Runtime.exceptionThrown" ||
      message.method === "Runtime.consoleAPICalled" ||
      message.method === "Log.entryAdded"
    ) {
      record(JSON.stringify(message.params));
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    if (message.error) entry.finish(new Error(JSON.stringify(message.error)));
    else entry.finish(undefined, message.result);
  });
  const closed = () => {
    for (const entry of pending.values()) entry.finish(new Error("CDP closed"));
  };
  ws.addEventListener("close", closed);
  ws.addEventListener("error", closed);
  return {
    logs,
    command<T = unknown>(
      method: string,
      params: object = {},
      timeout = milliseconds,
    ): Promise<T> {
      return new Promise((resolve, reject) => {
        const request = ++id;
        const timer = setTimeout(() => {
          finish(new Error(`CDP timed out after ${timeout}ms: ${method}`));
        }, timeout);
        const finish = (error?: Error, result?: unknown) => {
          clearTimeout(timer);
          pending.delete(request);
          if (error) reject(error);
          else resolve(result as T);
        };
        pending.set(request, { finish });
        try {
          ws.send(JSON.stringify({ id: request, method, params }));
        } catch (error) {
          finish(new Error(`${method}: ${error}`));
        }
      });
    },
    close() {
      closed();
      ws.close();
    },
  };
}

/** Dev-only built-in HTTP/CDP harness. Override INK_CHROME for another Chromium. */
export async function browser(
  page: string,
  width = 1100,
  height = 800,
  options: {
    root?: URL;
    importMap?: URL;
    gpu?: "software" | "hardware";
  } = {},
) {
  const executable = await browserPath();
  if (!executable) {
    throw new Error("Run deno task setup:browser or set INK_CHROME.");
  }
  const temporary = await Deno.makeTempDir({ prefix: "ink-browser-" });
  let sources: Awaited<ReturnType<typeof sourceServer>> | undefined;
  let process: Deno.ChildProcess | undefined;
  let connection: Awaited<ReturnType<typeof cdp>> | undefined;
  let exited = false;
  let stderr = "";
  let draining: Promise<void> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let drained = false;
  let disposed = false;
  const cleanup = async () => {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    try {
      connection?.close();
    } catch (error) {
      errors.push(error);
    }
    if (process && !exited) {
      try {
        process.kill("SIGKILL");
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) errors.push(error);
      }
    }
    const resources = await Promise.allSettled([
      bounded<unknown>(
        process?.status ?? Promise.resolve(),
        1000,
        "Chromium exit",
      ),
      bounded(
        (async () => {
          if (!drained) await reader?.cancel();
          await draining;
        })(),
        1000,
        "Chromium stderr close",
      ),
      bounded(
        sources?.dispose() ?? Promise.resolve(),
        2000,
        "Source server disposal",
      ),
    ]);
    for (const result of resources) {
      if (result.status === "rejected") errors.push(result.reason);
    }
    for (let attempt = 0;; attempt++) {
      try {
        await Deno.remove(temporary, { recursive: true });
        break;
      } catch (error) {
        if (attempt === 9) throw error;
        await pause(25);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Browser cleanup failed");
    }
  };
  try {
    sources = await sourceServer(options);
    const args = [
      "--headless=new",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      "--disable-gpu-watchdog",
      "--remote-debugging-port=0",
      `--user-data-dir=${temporary}/profile`,
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
    ];
    if (options.gpu !== "hardware") {
      args.push(
        "--use-angle=vulkan",
        "--use-vulkan=swiftshader",
        "--enable-features=Vulkan",
      );
    }
    args.push("about:blank");
    process = new Deno.Command(executable, {
      args,
      stdout: "null",
      stderr: "piped",
    }).spawn();
    process.status.then(() => {
      exited = true;
    });
    reader = process.stderr.getReader();
    draining = (async () => {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const chunk = await reader!.read();
          if (chunk.done) break;
          stderr = (stderr + decoder.decode(chunk.value, { stream: true }))
            .slice(-16000);
        }
      } finally {
        drained = true;
        reader!.releaseLock();
      }
    })();
    let port = "";
    const deadline = Date.now() + 5000;
    while (!port && !exited && Date.now() < deadline) {
      try {
        port =
          (await Deno.readTextFile(`${temporary}/profile/DevToolsActivePort`))
            .split("\n")[0];
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await pause(25);
      }
    }
    if (!port) throw new Error("Chromium did not start within 5000ms");
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(
        Math.max(1, Math.min(1000, deadline - Date.now())),
      ),
    })).json();
    const tab = targets.find((target: { type: string; url: string }) =>
      target.type === "page" && target.url === "about:blank"
    );
    if (!tab) throw new Error("Chromium has no page target");
    connection = await cdp(
      new WebSocket(tab.webSocketDebuggerUrl),
      5000,
      Math.max(1, deadline - Date.now()),
    );
    const { command } = connection;
    const screenshot = async (path: string, timeout = 5000) => {
      const result = await command<{ data: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        timeout,
      );
      await Deno.writeFile(
        path,
        Uint8Array.from(atob(result.data), (char) => char.charCodeAt(0)),
      );
    };
    const failure = async (error: unknown): Promise<never> => {
      let diagnostic = `\nChromium: ${stderr}\nPage: ${
        connection!.logs.join("\n")
      }`;
      try {
        const directory = new URL(
          "../.cache/browser-failures/",
          import.meta.url,
        );
        await Deno.mkdir(directory, { recursive: true });
        const path = new URL(`${Date.now()}.png`, directory).pathname;
        await screenshot(path, 500);
        diagnostic += `\nScreenshot: ${path}`;
      } catch (captureError) {
        diagnostic += `\nScreenshot unavailable: ${captureError}`;
      }
      throw new Error(`${error}${diagnostic}`, { cause: error });
    };
    const checkedCommand = async <T = unknown>(
      method: string,
      params: object = {},
    ): Promise<T> => {
      try {
        return await command<T>(method, params);
      } catch (error) {
        return await failure(error);
      }
    };
    const evaluate = async <T = unknown>(
      expression: string,
      timeout = 5000,
    ): Promise<T> => {
      try {
        const result = await command<{
          result: { value: T };
          exceptionDetails?: unknown;
        }>("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        }, timeout);
        if (result.exceptionDetails) {
          throw new Error(JSON.stringify(result.exceptionDetails));
        }
        return result.result.value;
      } catch (error) {
        return await failure(error);
      }
    };
    const waitFor = async (expression: string, milliseconds = 10000) => {
      const until = Date.now() + milliseconds;
      while (Date.now() < until) {
        if (await evaluate(expression, Math.min(5000, until - Date.now()))) {
          return;
        }
        await pause(25);
      }
      return await failure(new Error(`Browser timed out: ${expression}`));
    };
    await command("Runtime.enable");
    await command("Log.enable");
    await command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await command("Page.navigate", {
      url: `http://127.0.0.1:${sources.server.addr.port}${page}`,
    });
    await command("Page.bringToFront");
    await command("Emulation.setFocusEmulationEnabled", { enabled: true });
    await waitFor("document.readyState === 'complete'");
    return {
      command: checkedCommand,
      evaluate,
      waitFor,
      screenshot,
      get stderr() {
        return Promise.resolve(stderr);
      },
      async key(key: string, code = key, keyCode = 0) {
        let text = "";
        if (key.length === 1) text = key;
        if (key === "Enter") text = "\r";
        await checkedCommand("Input.dispatchKeyEvent", {
          type: "keyDown",
          key,
          code,
          text,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        });
        await checkedCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key,
          code,
          windowsVirtualKeyCode: keyCode,
          nativeVirtualKeyCode: keyCode,
        });
      },
      dispose: cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Browser failed: ${stderr}`,
      );
    }
    throw new Error(
      `${error}\nChromium: ${stderr}\nPage: ${
        connection?.logs.join("\n") ?? ""
      }`,
      { cause: error },
    );
  }
}
