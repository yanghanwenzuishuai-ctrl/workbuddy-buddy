export type OnboardingProblemCode =
  | "invalid_request"
  | "pairing_not_found"
  | "pairing_expired"
  | "pairing_conflict"
  | "rate_limited";

export class OnboardingProblem extends Error {
  constructor(
    readonly code: OnboardingProblemCode,
    readonly status: 400 | 404 | 409 | 410 | 429,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "OnboardingProblem";
  }
}
