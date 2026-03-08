import { spawn } from "node:child_process";

export async function killProcessTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });

      killer.once("error", reject);
      killer.once("exit", (code) => {
        if (code === 0 || code === 128 || code === 255) {
          resolve();
          return;
        }

        reject(new Error(`taskkill exited with code ${code}`));
      });
    });

    return;
  }

  process.kill(pid, "SIGTERM");
}
