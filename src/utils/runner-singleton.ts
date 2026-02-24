import net, { type Server as NetServer } from "net";
import { existsSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const RUNNER_SINGLETON_ENDPOINT =
  process.platform === "win32"
    ? "\\\\.\\pipe\\ralph-runner"
    : join(tmpdir(), "ralph-runner.sock");

export type SingletonHandle = {
  endpoint: string;
  server: NetServer;
  release: () => Promise<void>;
};

export function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}

export async function tryConnectSingleton(endpoint: string, timeoutMs: number = 250): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.connect(endpoint);
    let settled = false;

    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function listenSingleton(endpoint: string): Promise<NetServer> {
  return await new Promise<NetServer>((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end();
    });

    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export async function closeServer(server: NetServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

export async function acquireRunnerSingleton(): Promise<SingletonHandle | null> {
  const endpoint = RUNNER_SINGLETON_ENDPOINT;

  if (await tryConnectSingleton(endpoint)) {
    return null;
  }

  try {
    const server = await listenSingleton(endpoint);
    return {
      endpoint,
      server,
      release: async () => {
        try {
          await closeServer(server);
        } catch {
          // Ignore
        }
        if (process.platform !== "win32") {
          try {
            if (existsSync(endpoint)) unlinkSync(endpoint);
          } catch {
            // Ignore
          }
        }
      },
    };
  } catch (error) {
    if (isErrnoException(error) && error.code === "EADDRINUSE") {
      if (await tryConnectSingleton(endpoint)) {
        return null;
      }

      if (process.platform !== "win32") {
        try {
          if (existsSync(endpoint)) unlinkSync(endpoint);
        } catch {
          // Ignore
        }

        const server = await listenSingleton(endpoint);
        return {
          endpoint,
          server,
          release: async () => {
            try {
              await closeServer(server);
            } catch {
              // Ignore
            }
            try {
              if (existsSync(endpoint)) unlinkSync(endpoint);
            } catch {
              // Ignore
            }
          },
        };
      }

      return null;
    }

    throw error;
  }
}

/**
 * Check if a Runner process is already alive by attempting to connect
 * to the singleton endpoint.
 */
export async function isRunnerAlive(): Promise<boolean> {
  return tryConnectSingleton(RUNNER_SINGLETON_ENDPOINT);
}
