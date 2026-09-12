#!/usr/bin/env node
/**
 * The intent-factory executable.
 *
 * It calls `runCli()` and nothing else. A bin wrapper that parses, validates or
 * decides is a second CLI with no tests. The call has to be explicit because
 * `src/cli.mjs` guards its own dispatch on `process.argv[1]` being itself --
 * which, invoked through here, it is not.
 *
 * Usage, from a repository with a `.runs/` directory:
 *   intent-factory preflight <contract.json>
 *   intent-factory run <contract.json> [--detach]
 *   intent-factory resume <run-dir> [--node <id>] [--detach]
 *   intent-factory status|report|findings <run-dir> [--json]
 *   intent-factory doctor [--cwd <dir>] [--discover] [--json]
 *   intent-factory models [--probe] [--json]
 *   intent-factory campaign <subcommand> ...
 *   intent-factory metrics <campaign-id> [--json]
 *
 * `src/web/server.mjs` is the browser surface and is launched directly, not
 * through here.
 */
import { runCli } from "../src/cli.mjs";

await runCli();
