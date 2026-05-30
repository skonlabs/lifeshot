// deno-lint-ignore-file no-explicit-any
/** Natural-language query → structured ParsedQuery via Structured Outputs. */
import { chatStructured, type CallContext } from "./client.ts";
import { aiConfig } from "./config.ts";
import { PARSER_SYSTEM } from "./prompts.ts";
import { ParsedQueryZ, PARSER_JSON_SCHEMA, type ParsedQuery } from "./schemas.ts";

export async function parseQuery(query: string, ctx?: CallContext): Promise<ParsedQuery> {
  const messages = [
    { role: "system", content: PARSER_SYSTEM },
    { role: "user", content: query.slice(0, 1000) },
  ];
  const { data } = await chatStructured<ParsedQuery>({
    model: aiConfig.parserModel,
    messages,
    schema: PARSER_JSON_SCHEMA,
    parse: (raw) => ParsedQueryZ.parse(raw),
    temperature: aiConfig.temperatures.parser,
    maxTokens: aiConfig.maxTokens.parser,
    ctx,
  });
  return data;
}