/**
 * CLI harvest script - runs the job harvester via Node.js.
 * For the web app, use the React frontend instead.
 */

import { RoolClient } from "@rool-dev/sdk";
import { NodeAuthProvider } from "@rool-dev/sdk/node";
import { JOB_FILTER_SYSTEM_INSTRUCTION, HARVEST_PROMPT } from "../src/prompt.js";

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

  let space;
  const spaces = await client.listSpaces();
  const existing = spaces.find((s) => s.name === SPACE_NAME);
  if (existing) {
    space = await client.openSpace(existing.id);
    console.log(`Opened existing space: ${space.name} (${space.id})`);
  } else {
    space = await client.createSpace(SPACE_NAME);
    console.log(`Created new space: ${space.name} (${space.id})`);
  }

  await space.setSystemInstruction(JOB_FILTER_SYSTEM_INSTRUCTION);
  console.log("System instruction set.");

  console.log("Starting harvest (AI will search and crawl company careers pages)...");
  const { message, objects } = await space.prompt(HARVEST_PROMPT, {
    effort: "REASONING",
  });

  console.log("\n--- AI Response ---");
  console.log(message);
  console.log(`\nModified ${objects.length} objects`);

  space.close();
  client.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
