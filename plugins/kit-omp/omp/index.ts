import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "./hooks";

// resolve() drops the trailing slash `new URL("..")` leaves, which would otherwise show up
// as `kit-omp//code-standards/...` in every path the gate hands an agent.
const PLUGIN_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/**
 * OMP extension entry point, loaded via this plugin's package.json
 * `omp.extensions`. Inert everywhere else — no other harness loads files
 * under omp/.
 */
export default function kitExtension(pi: ExtensionAPI): void {
  registerHooks(pi, PLUGIN_ROOT);
}
