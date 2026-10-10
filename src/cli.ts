import { buildDayBrief, buildEndOfDay, projectStatuses, renderDayBrief, renderEndOfDay, renderProjects, rollover } from "./core/briefing.ts";
import { narrate } from "./core/llm.ts";
import { Store } from "./core/store.ts";
import { demoData, seedDemoStore } from "./demo.ts";

const [cmd = "day", ...flags] = process.argv.slice(2);
const now = new Date();
const demo = flags.includes("--demo");
const store = new Store(demo ? `${process.env.TMPDIR ?? "/tmp"}/sotitout-demo.json` : `${process.env.HOME}/.sotitout/state.json`);
const data = demoData(now);
if (demo) {
  store.state.projects = [];
  store.state.tasks = [];
  seedDemoStore(store, now, data.emails);
}

let out: string;
if (cmd === "day") out = renderDayBrief(buildDayBrief(store.state, data.events, data.emails, now));
else if (cmd === "projects") out = renderProjects(projectStatuses(store.state, data.emails, now), now);
else if (cmd === "eod") {
  out = renderEndOfDay(buildEndOfDay(store.state, data.emails, data.tomorrow, now), now);
  if (!demo && flags.includes("--rollover")) {
    rollover(store.state, now);
    store.save();
  }
} else {
  console.error("usage: node src/cli.ts <day|projects|eod> [--demo] [--narrate] [--rollover]");
  process.exit(2);
}

console.log(out);
if (flags.includes("--narrate")) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) console.error("\n(set ANTHROPIC_API_KEY to use --narrate)");
  else console.log(`\n--- Summary ---\n${await narrate(out, { apiKey })}`);
}
