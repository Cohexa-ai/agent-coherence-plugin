/** Entry: node dist/cli_status.js [paths…] [--root <path>] (zero-Python Unit 4). */
import { pathToFileURL } from "node:url";
import { runStatus } from "./cli.js";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runStatus(process.argv.slice(2)).then((code) => process.exit(code));
}
