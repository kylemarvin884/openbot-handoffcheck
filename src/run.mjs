import { spawnSync } from "node:child_process";

/** Build the runner for `check --run`. Commands come from the handoff file, so
 *  this only ever runs when the caller passed --run explicitly. */
export function makeExecutor({ cwd, timeoutSeconds }) {
  return (command) => {
    const onWindows = process.platform === "win32";
    const result = spawnSync(
      onWindows ? "cmd.exe" : "sh",
      onWindows ? ["/d", "/s", "/c", command] : ["-c", command],
      {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        timeout: timeoutSeconds * 1000,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          CI: "1",
          GIT_TERMINAL_PROMPT: "0",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
      },
    );

    const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const tail = combined
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !/^>/.test(line))
      .pop();

    return {
      status: result.status,
      timedOut,
      timeoutSeconds,
      output: tail ? tail.slice(0, 200) : "",
    };
  };
}
