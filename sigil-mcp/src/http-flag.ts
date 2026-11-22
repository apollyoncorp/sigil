// Kept apart from http.ts so stdio mode does not load the HTTP code.

/** True when the process was asked to serve HTTP (flag or env). */
export const wantsHttp = (
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
) => argv.includes("--http") || /^(1|true|yes)$/i.test(env.SIGIL_MCP_HTTP ?? "");
