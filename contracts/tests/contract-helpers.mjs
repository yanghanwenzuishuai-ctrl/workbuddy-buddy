import assert from "node:assert/strict";
import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function jsonFilesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return jsonFilesBelow(target);
      return entry.isFile() && entry.name.endsWith(".json") ? [target] : [];
    }),
  );
  return nested.flat().sort();
}

export function resolveJsonPointer(document, fragment, context) {
  if (fragment === "" || fragment === "#") return document;
  assert.ok(
    fragment.startsWith("#/"),
    `${context}: unsupported JSON Pointer fragment ${fragment}`,
  );
  return fragment
    .slice(2)
    .split("/")
    .map((token) => decodeURIComponent(token).replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, token) => {
      assert.ok(
        value !== null &&
          typeof value === "object" &&
          Object.hasOwn(value, token),
        `${context}: JSON Pointer does not exist at token ${JSON.stringify(token)}`,
      );
      return value[token];
    }, document);
}

export async function assertAllLocalRefsResolve(entryFile) {
  const contractRoot = await realpath(CONTRACTS_DIR);
  const documents = new Map();
  const visitedDocuments = new Set();

  async function loadDocument(file) {
    const canonical = await realpath(file);
    assert.ok(
      canonical === contractRoot || canonical.startsWith(`${contractRoot}${path.sep}`),
      `${file}: $ref escapes the contracts directory`,
    );
    if (!documents.has(canonical)) documents.set(canonical, await readJson(canonical));
    return [canonical, documents.get(canonical)];
  }

  async function walkDocument(file) {
    const [canonical, document] = await loadDocument(file);
    if (visitedDocuments.has(canonical)) return;
    visitedDocuments.add(canonical);

    const stack = [{ value: document, pointer: "#" }];
    while (stack.length > 0) {
      const { value, pointer } = stack.pop();
      if (value === null || typeof value !== "object") continue;

      if (!Array.isArray(value) && typeof value.$ref === "string") {
        const ref = value.$ref;
        assert.ok(
          !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(ref),
          `${canonical}${pointer}: remote or absolute $ref is forbidden: ${ref}`,
        );
        const hash = ref.indexOf("#");
        const relativeFile = hash === -1 ? ref : ref.slice(0, hash);
        const fragment = hash === -1 ? "" : ref.slice(hash);
        const targetFile = relativeFile
          ? path.resolve(path.dirname(canonical), relativeFile)
          : canonical;
        const [targetCanonical, targetDocument] = await loadDocument(targetFile);
        resolveJsonPointer(
          targetDocument,
          fragment,
          `${canonical}${pointer} -> ${ref}`,
        );
        await walkDocument(targetCanonical);
      }

      if (Array.isArray(value)) {
        value.forEach((child, index) =>
          stack.push({ value: child, pointer: `${pointer}/${index}` }),
        );
      } else {
        Object.entries(value).forEach(([key, child]) =>
          stack.push({ value: child, pointer: `${pointer}/${key}` }),
        );
      }
    }
  }

  await walkDocument(entryFile);
  return [...documents.keys()].sort();
}

export function collectPayloadKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item) => collectPayloadKeys(item, keys));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectPayloadKeys(child, keys);
    }
  }
  return keys;
}

export function collectDeclaredPropertyNames(schema, names = new Set()) {
  if (Array.isArray(schema)) {
    schema.forEach((item) => collectDeclaredPropertyNames(item, names));
  } else if (schema !== null && typeof schema === "object") {
    if (
      schema.properties !== null &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
    ) {
      Object.keys(schema.properties).forEach((name) => names.add(name));
    }
    Object.values(schema).forEach((child) =>
      collectDeclaredPropertyNames(child, names),
    );
  }
  return names;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function resolveManifestPath(value, baseDirectory = CONTRACTS_DIR) {
  assert.equal(typeof value, "string");
  if (value.startsWith("contracts/")) {
    return path.resolve(CONTRACTS_DIR, value.slice("contracts/".length));
  }
  return path.resolve(baseDirectory, value);
}
