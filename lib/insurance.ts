import type { ProviderResult } from "./validation";

export type InsuranceStatus = "likely_accepts" | "verify_with_office";

export type ProviderWithInsurance = ProviderResult & {
  insuranceStatus: InsuranceStatus;
  insuranceNote: string;
};

const MAJOR_PLAN_KEYWORDS = [
  "medicare",
  "medicaid",
  "blue cross",
  "bcbs",
  "aetna",
  "united",
  "uhc",
  "cigna",
  "humana",
  "kaiser",
  "anthem",
  "oscar",
  "emblem",
];

function hashScore(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash % 100;
}

function providerHaystack(provider: ProviderResult): string {
  return [provider.name, provider.facilityName, provider.address, ...provider.categories]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function evaluateInsuranceAcceptance(
  provider: ProviderResult,
  insurance: string,
): { insuranceStatus: InsuranceStatus; insuranceNote: string } {
  const plan = insurance.trim();
  if (!plan) {
    return {
      insuranceStatus: "verify_with_office",
      insuranceNote: "Add insurance to check likely network fit.",
    };
  }

  const normalizedPlan = plan.toLowerCase();
  const haystack = providerHaystack(provider);
  const hospitalLike = /\b(hospital|medical center|health system|clinic|physician)\b/.test(haystack);
  const matchesMajorPlan = MAJOR_PLAN_KEYWORDS.some((keyword) => normalizedPlan.includes(keyword));

  if (matchesMajorPlan && hospitalLike) {
    return {
      insuranceStatus: "likely_accepts",
      insuranceNote: `Likely accepts ${plan} (demo estimate — confirm with the office).`,
    };
  }

  if (matchesMajorPlan && hashScore(`${provider.id}|${normalizedPlan}`) < 55) {
    return {
      insuranceStatus: "likely_accepts",
      insuranceNote: `May accept ${plan} (demo estimate — confirm with the office).`,
    };
  }

  return {
    insuranceStatus: "verify_with_office",
    insuranceNote: `Call to verify ${plan} participation before booking.`,
  };
}

export function annotateProvidersWithInsurance(
  providers: ProviderResult[],
  insurance?: string,
): ProviderWithInsurance[] {
  const plan = insurance?.trim() ?? "";
  const annotated = providers.map((provider) => ({
    ...provider,
    ...evaluateInsuranceAcceptance(provider, plan),
  }));

  if (!plan) return annotated;

  return annotated.sort((left, right) => {
    if (left.insuranceStatus === right.insuranceStatus) return 0;
    return left.insuranceStatus === "likely_accepts" ? -1 : 1;
  });
}
