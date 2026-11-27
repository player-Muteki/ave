import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import * as contracts from "../src/v1.ts";

// Each entry is independently addressable by Worker and client validators.
// Binary bodies are framed bytes; only their JSON headers belong here.
const registry = z.registry();
for (const [name, schema] of Object.entries(contracts)) {
  if (name.endsWith("Schema") && schema instanceof z.ZodType) {
    registry.add(schema, { id: name.slice(0, -"Schema".length) });
  }
}
const uri = (id) => `urn:video-editor:v1:${id}`;
const { schemas } = z.toJSONSchema(registry, { uri, target: "draft-2020-12", io: "input" });
const doc = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: uri("bundle"),
  $defs: schemas,
};
const generated = JSON.stringify(doc, null, 2) + "\n";
const dest = new URL("../src/v1.schema.json", import.meta.url);
if (process.argv[2] === "--write") await writeFile(dest, generated);
else if (process.argv.length > 2 || (await readFile(dest, "utf8")) !== generated) {
  throw new Error("Schema bundle is stale or invalid option: regenerate with --write");
}
console.log(
  `${Object.keys(schemas).length} video contract definitions · ${process.argv[2] === "--write" ? "generated" : "in sync"}`,
);
