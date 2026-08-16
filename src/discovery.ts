import dns from "node:dns/promises";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { parse } from "acorn";
import ipaddr from "ipaddr.js";
import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";
import { configPath, parseConfig, type TeamConfig } from "./config.js";
import { CliError } from "./errors.js";

const maxHtmlBytes = 2 * 1024 * 1024;
const maxScriptBytes = 10 * 1024 * 1024;
const maxAggregateScriptBytes = 20 * 1024 * 1024;
const maxScripts = 20;

type TextFetcher = (url: URL, maxBytes: number) => Promise<string>;

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) return ipv6.toIPv4Address().range() === "unicast";
  }
  return parsed.range() === "unicast";
}

async function fetchPublicHttps(url: URL, maxBytes: number): Promise<string> {
  const deadline = Date.now() + 15_000;
  const addresses = await Promise.race([
    dns.lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new CliError("TEAM discovery DNS lookup timed out", "discovery_timeout")), 15_000),
    ),
  ]);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new CliError("TEAM discovery URL must resolve only to public addresses", "discovery_private_address");
  }
  const selected = addresses[0];
  if (!selected) throw new CliError("TEAM discovery hostname did not resolve", "discovery_dns_failed");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new CliError("TEAM discovery request timed out", "discovery_timeout");
  const signal = AbortSignal.timeout(remaining);

  return new Promise<string>((resolve, reject) => {
    const request = https.get(
      url,
      {
        family: selected.family,
        lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family),
        signal,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new CliError(`TEAM discovery request failed with HTTP ${response.statusCode}`, "discovery_http_error"));
          return;
        }
        const declaredLength = Number(response.headers["content-length"]);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          response.destroy();
          reject(new CliError("TEAM discovery response exceeded the size limit", "discovery_response_too_large"));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes > maxBytes) {
            response.destroy(new CliError("TEAM discovery response exceeded the size limit", "discovery_response_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      },
    );
    request.on("error", (error) => {
      if (signal.aborted) reject(new CliError("TEAM discovery request timed out", "discovery_timeout"));
      else reject(error);
    });
  });
}

async function readResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.ok) {
    throw new CliError(`TEAM discovery request failed with HTTP ${response.status}`, "discovery_http_error");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CliError("TEAM discovery response exceeded the size limit", "discovery_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new CliError("TEAM discovery response exceeded the size limit", "discovery_response_too_large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type AstNode = {
  type: string;
  [key: string]: unknown;
};

type AstProperty = AstNode & {
  type: "Property";
  computed: boolean;
  kind: string;
  key: AstNode;
  value: AstNode;
};

function isNode(value: unknown): value is AstNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}

function propertyName(property: AstProperty): string | null {
  if (property.computed || property.kind !== "init") return null;
  if (property.key.type === "Identifier" && typeof property.key.name === "string") return property.key.name;
  if (property.key.type === "Literal" && typeof property.key.value === "string") return property.key.value;
  return null;
}

function objectProperties(node: AstNode): Map<string, AstNode> {
  if (node.type !== "ObjectExpression" || !Array.isArray(node.properties)) {
    throw new CliError("TEAM Amplify configuration is malformed", "discovery_value_missing");
  }
  const result = new Map<string, AstNode>();
  for (const candidate of node.properties) {
    if (!isNode(candidate) || candidate.type !== "Property") {
      throw new CliError("TEAM Amplify configuration uses unsupported object semantics", "discovery_object_unsupported");
    }
    const property = candidate as AstProperty;
    if (property.computed || property.kind !== "init" || property.method === true || property.shorthand === true) {
      throw new CliError("TEAM Amplify configuration uses unsupported object semantics", "discovery_object_unsupported");
    }
    const name = propertyName(property);
    if (!name) continue;
    if (result.has(name)) throw new CliError(`TEAM bundle contains duplicate ${name}`, "discovery_duplicate_value");
    result.set(name, property.value);
  }
  return result;
}

function stringLiteral(properties: Map<string, AstNode>, key: string): string {
  const node = properties.get(key);
  if (node?.type !== "Literal" || typeof node.value !== "string") {
    throw new CliError(`TEAM bundle is missing ${key}`, "discovery_value_missing");
  }
  return node.value;
}

function parseConfigObject(configObject: AstNode, sourceAppUrl: string): TeamConfig {
  const source = new URL(sourceAppUrl);
  const properties = objectProperties(configObject);
  if (!properties.has("aws_project_region")) {
    throw new CliError("TEAM bundle is missing aws_project_region", "discovery_value_missing");
  }
  const oauthNode = properties.get("oauth");
  if (!oauthNode) throw new CliError("TEAM bundle is missing OAuth configuration", "discovery_value_missing");
  const oauth = objectProperties(oauthNode);
  const rawDomain = stringLiteral(oauth, "domain");
  const domain = rawDomain.startsWith("https://") ? rawDomain : `https://${rawDomain}`;
  return parseConfig({
    appUrl: `${source.origin}/`,
    graphQlEndpoint: stringLiteral(properties, "aws_appsync_graphqlEndpoint"),
    cognitoDomain: domain,
    clientId: stringLiteral(properties, "aws_user_pools_web_client_id"),
    userPoolId: stringLiteral(properties, "aws_user_pools_id"),
  });
}

export function parseAmplifyConfig(bundle: string, sourceAppUrl: string): TeamConfig {
  let root: AstNode;
  try {
    root = parse(bundle, { ecmaVersion: "latest", sourceType: "script" }) as unknown as AstNode;
  } catch {
    throw new CliError("TEAM JavaScript bundle could not be parsed", "discovery_bundle_invalid");
  }
  const candidates: TeamConfig[] = [];
  const stack: AstNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.type === "ObjectExpression") {
      try {
        candidates.push(parseConfigObject(node, sourceAppUrl));
      } catch {
        // Most object literals are unrelated to Amplify configuration.
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (isNode(value)) stack.push(value);
      else if (Array.isArray(value)) {
        for (const child of value) if (isNode(child)) stack.push(child);
      }
    }
  }
  if (candidates.length === 0) {
    throw new CliError("TEAM bundle contains no Amplify configuration object", "discovery_config_missing");
  }
  const unique = new Map(candidates.map((candidate) => [JSON.stringify(candidate), candidate]));
  if (candidates.length !== 1 || unique.size !== 1) {
    throw new CliError("TEAM bundle contains multiple Amplify configurations", "discovery_config_ambiguous");
  }
  const result = candidates[0];
  if (!result) throw new CliError("TEAM bundle contains no Amplify configuration object", "discovery_config_missing");
  return result;
}

function scriptSources(html: string): string[] {
  const document = parseHtml(html);
  const result: string[] = [];
  const stack: DefaultTreeAdapterMap["node"][] = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if ("tagName" in node && node.tagName === "script" && "attrs" in node) {
      const source = node.attrs.find((attribute) => attribute.name.toLowerCase() === "src")?.value;
      if (source) result.push(source);
    }
    if ("childNodes" in node) stack.push(...node.childNodes);
  }
  return result;
}

export function appUrlValidationError(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "--app-url must be a valid HTTPS URL";
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return "--app-url must be an HTTPS URL without credentials";
  }
  return null;
}

export async function discoverTeamConfig(
  appUrl: string,
  fetcher?: typeof fetch,
): Promise<TeamConfig> {
  const problem = appUrlValidationError(appUrl);
  if (problem) throw new CliError(problem, "invalid_app_url");
  const source = new URL(appUrl);

  const textFetcher: TextFetcher = fetcher
    ? async (url, maxBytes) => readResponse(await fetcher(url, { redirect: "error" }), maxBytes)
    : fetchPublicHttps;
  const appRoot = new URL("/", source);
  const html = await textFetcher(appRoot, maxHtmlBytes);
  const scripts = scriptSources(html);
  if (scripts.length === 0) throw new CliError("TEAM app contains no discoverable scripts", "discovery_script_missing");
  if (scripts.length > maxScripts) throw new CliError("TEAM app contains too many scripts", "discovery_script_limit");

  let aggregateBytes = 0;
  let lastError: unknown;
  const discovered: TeamConfig[] = [];
  for (const scriptPath of scripts) {
    const scriptUrl = new URL(scriptPath, appRoot);
    if (scriptUrl.origin !== appRoot.origin) continue;
    const remainingBytes = maxAggregateScriptBytes - aggregateBytes;
    if (remainingBytes <= 0) throw new CliError("TEAM scripts exceeded the aggregate size limit", "discovery_response_too_large");
    const bundle = await textFetcher(scriptUrl, Math.min(maxScriptBytes, remainingBytes));
    aggregateBytes += Buffer.byteLength(bundle);
    if (!bundle.includes("aws_appsync_graphqlEndpoint") || !bundle.includes("aws_user_pools_id")) continue;
    try {
      discovered.push(parseAmplifyConfig(bundle, appRoot.toString()));
    } catch (error) {
      if (
        error instanceof CliError &&
        ["discovery_config_ambiguous", "discovery_duplicate_value", "discovery_object_unsupported"].includes(error.code)
      ) {
        throw error;
      }
      lastError = error;
    }
  }
  if (discovered.length > 0) {
    const unique = new Map(discovered.map((candidate) => [JSON.stringify(candidate), candidate]));
    if (unique.size !== 1) {
      throw new CliError("TEAM page contains multiple Amplify configurations", "discovery_config_ambiguous");
    }
    const result = unique.values().next().value;
    if (result) return result;
  }
  if (lastError) throw lastError;
  throw new CliError("TEAM Amplify configuration was not found in same-origin scripts", "discovery_config_missing");
}

export function writeTeamConfig(config: TeamConfig, destination = configPath, force = false): void {
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporary = path.join(directory, `.config.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (force) fs.renameSync(temporary, destination);
    else {
      try {
        fs.linkSync(temporary, destination);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
          throw new CliError(`TEAM config already exists at ${destination}; pass --force to replace it`, "config_exists");
        }
        throw error;
      }
    }
    fs.chmodSync(destination, 0o600);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
