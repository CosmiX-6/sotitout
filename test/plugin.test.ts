import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import { tools } from "../src/mcp/tools.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const toolNames = new Set(tools.map((t) => t.name));
/** Argument names that appear anywhere in a tool schema (skills may mention these too). */
const fieldNames = new Set<string>();
const walk = (o: unknown): void => {
  if (Array.isArray(o)) o.forEach(walk);
  else if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o)) {
      if (k === "properties" && v && typeof v === "object") Object.keys(v).forEach((f) => fieldNames.add(f));
      walk(v);
    }
  }
};
tools.forEach((t) => walk(t.inputSchema));

test("plugin manifests are valid and point at files that exist", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const market = JSON.parse(read(".claude-plugin/marketplace.json"));
  const mcp = JSON.parse(read(".mcp.json"));
  assert.equal(plugin.name, "sotitout");
  assert.equal(market.plugins[0].name, plugin.name);
  assert.equal(plugin.version, JSON.parse(read("package.json")).version);
  const arg: string = mcp.mcpServers.sotitout.args[0];
  assert.ok(arg.startsWith("${CLAUDE_PLUGIN_ROOT}/"));
  assert.ok(existsSync(new URL(`../${arg.replace("${CLAUDE_PLUGIN_ROOT}/", "")}`, import.meta.url)), "server entry is committed");
});

test("every skill has frontmatter and only mentions tools that exist", () => {
  const dirs = readdirSync(new URL("../skills", import.meta.url));
  assert.deepEqual(dirs.sort(), ["day", "eod", "projects", "setup"]);
  for (const d of dirs) {
    const md = read(`skills/${d}/SKILL.md`);
    const fm = md.match(/^---\nname: (\S+)\ndescription: (.+)\n---\n/);
    assert.ok(fm, `${d} frontmatter`);
    assert.equal(fm![1], d);
    const mentioned = [...md.matchAll(/`([a-z]+_[a-z_]+|settings)`/g)].map((m) => m[1]);
    for (const name of mentioned) assert.ok(toolNames.has(name) || fieldNames.has(name), `skills/${d} mentions unknown tool ${name}`);
  }
});

test("committed mcp-dist matches the source (run `npm run build:mcp` if this fails)", async () => {
  const child = spawn(process.execPath, ["--no-experimental-strip-types", "mcp-dist/mcp/server.js"], { stdio: ["pipe", "pipe", "ignore"] });
  try {
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d));
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    for (let i = 0; i < 100 && !out.includes("\n"); i++) await new Promise((r) => setTimeout(r, 50));
    const listed = JSON.parse(out.split("\n")[0]).result.tools as { name: string; description: string; inputSchema: unknown }[];
    const src = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    assert.deepEqual(listed, src);
  } finally {
    child.kill();
  }
});
