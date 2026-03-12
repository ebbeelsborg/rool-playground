/**
 * CLI harvest script - runs the job harvester via Node.js.
 * For the web app, use the React frontend instead.
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

const INITIAL_VISITED_DOMAINS = "{}";

const SPACE_NAME = "Remote Job Harvest";

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

  console.log("Authenticated. Creating or opening space...");

  const spaces = await client.listSpaces();
  const existing = spaces.find((s) => s.name === SPACE_NAME);
  const space = existing
    ? await client.openSpace(existing.id)
    : await client.createSpace(SPACE_NAME);
  console.log(`Opened space: ${space.name} (${space.id})`);

  const channel = await space.openChannel("main");
  await channel.setSystemInstruction(JOB_FILTER_SYSTEM_INSTRUCTION);

  let knowledge = await channel.getObject(HARVEST_KNOWLEDGE_ID);
  if (!knowledge) {
    await channel.createObject({
      data: {
        id: HARVEST_KNOWLEDGE_ID,
        type: "harvestKnowledge",
        rules: INITIAL_FILTER_RULES,
        feedbackLog: "",
        visitedDomains: INITIAL_VISITED_DOMAINS,
      },
    });
    console.log("Created harvest knowledge object.");
  } else if (knowledge.visitedDomains == null || knowledge.visitedDomains === undefined) {
    await channel.updateObject(HARVEST_KNOWLEDGE_ID, {
      data: { visitedDomains: INITIAL_VISITED_DOMAINS },
      ephemeral: true,
    });
    console.log("Added visitedDomains to existing harvest knowledge object.");
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
    const obj = await channel.getObject(id);
    if (!obj) {
      await channel.createObject({ data: { id, type, ...data } });
      console.log(`Created ${type} object.`);
    }
  }
  console.log("System instruction set.");

  const promptCfg = await channel.getObject(HARVEST_PROMPT_CONFIG_ID);
  const promptText = String(promptCfg?.currentText ?? DEFAULT_HARVEST_PROMPT);

  console.log("Starting harvest (AI will search and crawl company careers pages)...");
  const { message, objects } = await channel.prompt(promptText, {
    effort: "REASONING",
  });

  console.log("\n--- AI Response ---");
  console.log(message);
  console.log(`\nModified ${objects.length} objects`);

  channel.close();
  client.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
