/**
 * Continuous harvester - runs forever, visiting each site max once per day.
 * The per-site limit is enforced via visitedDomains in the harvestKnowledge object.
 */

import { RoolClient } from "@rool-dev/sdk";
import { NodeAuthProvider } from "@rool-dev/sdk/node";
import { JOB_FILTER_SYSTEM_INSTRUCTION } from "../src/prompt.js";
import {
  HARVEST_KNOWLEDGE_ID,
  INITIAL_FILTER_RULES,
  COMPANY_BLACKLIST_ID,
  COMPANY_WHITELIST_ID,
  HARVEST_PROMPT_CONFIG_ID,
  DEFAULT_HARVEST_PROMPT,
} from "../src/constants.js";

const SPACE_NAME = "Remote Job Harvest";
const INITIAL_VISITED_DOMAINS = "{}";

/** Minutes between harvest runs */
const INTERVAL_MINUTES = 10;

async function runHarvest(space: Awaited<ReturnType<RoolClient["openSpace"]>>) {
  const knowledge = await space.getObject(HARVEST_KNOWLEDGE_ID);
  if (!knowledge) {
    await space.createObject({
      data: {
        id: HARVEST_KNOWLEDGE_ID,
        type: "harvestKnowledge",
        rules: INITIAL_FILTER_RULES,
        feedbackLog: "",
        visitedDomains: INITIAL_VISITED_DOMAINS,
      },
    });
  } else if (knowledge.visitedDomains == null || knowledge.visitedDomains === undefined) {
    await space.updateObject(HARVEST_KNOWLEDGE_ID, {
      data: { visitedDomains: INITIAL_VISITED_DOMAINS },
      ephemeral: true,
    });
  }

  for (const [id, type, data] of [
    [COMPANY_BLACKLIST_ID, "companyBlacklist", { companies: [] }],
    [COMPANY_WHITELIST_ID, "companyWhitelist", { companies: [] }],
    [
      HARVEST_PROMPT_CONFIG_ID,
      "harvestPromptConfig",
      { currentText: DEFAULT_HARVEST_PROMPT, currentVersion: 1, versionHistory: [] },
    ],
  ] as const) {
    const obj = await space.getObject(id);
    if (!obj) await space.createObject({ data: { id, type, ...data } });
  }

  const promptCfg = await space.getObject(HARVEST_PROMPT_CONFIG_ID);
  const promptText = String(promptCfg?.currentText ?? DEFAULT_HARVEST_PROMPT);

  const { message, objects } = await space.prompt(promptText, {
    effort: "REASONING",
  });
  return { message, objects };
}

async function main() {
  const client = new RoolClient({
    authProvider: new NodeAuthProvider(),
    logger: console,
  });

  const authenticated = await client.initialize();
  if (!authenticated) {
    console.log("Opening browser for Rool login...");
    await client.login("Rool Job Harvester");
    return;
  }

  const spaces = await client.listSpaces();
  const existing = spaces.find((s) => s.name === SPACE_NAME);
  const space = existing
    ? await client.openSpace(existing.id)
    : await client.createSpace(SPACE_NAME);

  await space.setSystemInstruction(JOB_FILTER_SYSTEM_INSTRUCTION);

  console.log(`Harvester running continuously. Interval: ${INTERVAL_MINUTES} min. Each site visited max once per day.`);
  console.log("Press Ctrl+C to stop.\n");

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    space.close();
    client.destroy();
    process.exit(0);
  });

  let runCount = 0;
  while (true) {
    runCount++;
    const start = Date.now();
    try {
      console.log(`[Run ${runCount}] Starting harvest at ${new Date().toISOString()}`);
      const { message, objects } = await runHarvest(space);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`[Run ${runCount}] Done in ${elapsed}s. Modified ${objects.length} objects.`);
      if (message) {
        const preview = message.length > 200 ? message.slice(0, 200) + "..." : message;
        console.log(`  ${preview}`);
      }
    } catch (err) {
      console.error(`[Run ${runCount}] Error:`, err);
    }

    const sleepMs = INTERVAL_MINUTES * 60 * 1000;
    console.log(`[Run ${runCount}] Sleeping ${INTERVAL_MINUTES} min...\n`);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
