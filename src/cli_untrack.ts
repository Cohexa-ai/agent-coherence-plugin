/** Entry: node dist/cli_untrack.js [paths…] [--root <path>] (zero-Python Unit 4). */
import { pathToFileURL } from "node:url";
import { runUntrack } from "./cli.js";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runUntrack(process.argv.slice(2)).then((code) => process.exit(code));
}
