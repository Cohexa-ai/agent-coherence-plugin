/** Entry: node dist/cli_track.js [paths…] [--root <path>] (zero-Python Unit 4). */
import { pathToFileURL } from "node:url";
import { runTrack } from "./cli.js";

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runTrack(process.argv.slice(2)).then((code) => process.exit(code));
}
