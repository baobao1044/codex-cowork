import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { ValidateFunction } from "ajv";

import type { ExecutorOutput, SynthesizerOutput } from "./types.js";

type SchemaName = "synthesizer" | "executor";

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020").default as new (options: Record<string, unknown>) => {
  compile: (schema: object) => ValidateFunction;
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
});

function loadSchema(schemaName: SchemaName): object {
  const schemaPath = getSchemaPath(schemaName);
  const raw = readFileSync(schemaPath, "utf8");
  return JSON.parse(raw) as object;
}

const validators: Record<SchemaName, ValidateFunction> = {
  synthesizer: ajv.compile(loadSchema("synthesizer")),
  executor: ajv.compile(loadSchema("executor")),
};

export function getSchemaPath(schemaName: SchemaName): string {
  const fileName =
    schemaName === "synthesizer"
      ? "synthesizer.output.schema.json"
      : "executor.output.schema.json";

  return path.resolve(process.cwd(), "schemas", fileName);
}

function stripMarkdownFences(text: string): string {
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const match = fenced.exec(text.trim());
  return match ? match[1]! : text;
}

function parseStructuredOutput<T>(schemaName: SchemaName, text: string): T {
  let parsed: unknown;
  const normalizedText = stripMarkdownFences(text);

  try {
    parsed = JSON.parse(normalizedText);
  } catch (error) {
    throw new Error(`${schemaName} output was not valid JSON: ${(error as Error).message}`);
  }

  const validate = validators[schemaName];

  if (!validate(parsed)) {
    const messages = (validate.errors ?? [])
      .map((item) => `${item.instancePath || "/"} ${item.message ?? "validation error"}`)
      .join("; ");
    throw new Error(`${schemaName} output failed schema validation: ${messages}`);
  }

  return parsed as T;
}

export function parseSynthesizerOutput(text: string): SynthesizerOutput {
  return parseStructuredOutput<SynthesizerOutput>("synthesizer", text);
}

export function parseExecutorOutput(text: string): ExecutorOutput {
  return parseStructuredOutput<ExecutorOutput>("executor", text);
}
