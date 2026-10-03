import { spawn } from "node:child_process";
const p = spawn(process.execPath, ["durable.mjs", "run"], { stdio: ["ignore", "pipe", "inherit"] });
p.stdout.setEncoding("utf8");
p.stdout.on("data", (d) => { process.stdout.write(`[child] ${d}`); if (d.includes("TOOL_STARTED")) setTimeout(() => { p.kill("SIGKILL"); console.log("[parent] killed child after tool start"); }, 300); });
p.on("exit", (c, s) => console.log("[parent] child exit", c, s));
