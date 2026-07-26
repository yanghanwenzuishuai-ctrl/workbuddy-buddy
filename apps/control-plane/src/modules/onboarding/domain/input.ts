import { OnboardingProblem } from "./problem.js";
import { ONBOARDING_PET_IDS } from "./pet-catalog.js";

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9+/]{43}=$/;
const SEMVER_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const OFFICE_KEYS = [
  "alias",
  "office_name",
  "pet_id",
  "poster_opt_in",
  "presence_visible",
  "stats_opt_in",
] as const;
const CLAIM_KEYS = [
  "client_version",
  "pairing_code",
  "public_key",
] as const;

export interface CreateOfficeOnboardingInput {
  office_name: string;
  alias: string;
  pet_id: string;
  presence_visible: boolean;
  stats_opt_in: boolean;
  poster_opt_in: boolean;
}

export interface ClaimPairingInput {
  pairingCode: string;
  publicKey: Buffer;
  clientVersion: string;
}

export function parseCreateOfficeOnboardingInput(
  input: unknown,
): CreateOfficeOnboardingInput {
  const object = exactObject(input, OFFICE_KEYS);
  const officeName = boundedString(object.office_name, 1, 80);
  const alias = boundedString(object.alias, 1, 32);
  const petId = boundedString(object.pet_id, 1, 64);
  if (
    officeName !== officeName.trim() ||
    /[\u0000-\u001f\u007f]/u.test(officeName)
  ) {
    invalidRequest();
  }
  if (
    alias !== alias.trim() ||
    /[@\u0000-\u001f\u007f]/u.test(alias)
  ) {
    invalidRequest();
  }
  if (!ONBOARDING_PET_IDS.has(petId)) invalidRequest();

  return {
    office_name: officeName,
    alias,
    pet_id: petId,
    presence_visible: booleanValue(object.presence_visible),
    stats_opt_in: booleanValue(object.stats_opt_in),
    poster_opt_in: booleanValue(object.poster_opt_in),
  };
}

export function parseClaimPairingInput(input: unknown): ClaimPairingInput {
  const object = exactObject(input, CLAIM_KEYS);
  const pairingCode = parseCapability(object.pairing_code);
  const encodedPublicKey = boundedString(object.public_key, 44, 44);
  if (!PUBLIC_KEY_PATTERN.test(encodedPublicKey)) invalidRequest();
  const publicKey = Buffer.from(encodedPublicKey, "base64");
  if (
    publicKey.length !== 32 ||
    publicKey.toString("base64") !== encodedPublicKey
  ) {
    invalidRequest();
  }
  const clientVersion = boundedString(object.client_version, 5, 64);
  if (!SEMVER_PATTERN.test(clientVersion)) invalidRequest();
  return { pairingCode, publicKey, clientVersion };
}

export function parseStatusCapability(input: unknown): string {
  return parseCapability(input);
}

function parseCapability(input: unknown): string {
  const value = boundedString(input, 43, 43);
  if (!CAPABILITY_PATTERN.test(value)) invalidRequest();
  return value;
}

function exactObject<const Keys extends readonly string[]>(
  input: unknown,
  expectedKeys: Keys,
): Record<Keys[number], unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    invalidRequest();
  }
  const actual = Object.keys(input).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidRequest();
  }
  return input as Record<Keys[number], unknown>;
}

function boundedString(
  input: unknown,
  minimum: number,
  maximum: number,
): string {
  if (typeof input !== "string") invalidRequest();
  const length = [...input].length;
  if (length < minimum || length > maximum) invalidRequest();
  return input;
}

function booleanValue(input: unknown): boolean {
  if (typeof input !== "boolean") invalidRequest();
  return input;
}

function invalidRequest(): never {
  throw new OnboardingProblem(
    "invalid_request",
    400,
    "The onboarding request is invalid.",
  );
}
