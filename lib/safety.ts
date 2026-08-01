export type EmergencyAssessment = {
  emergency: boolean;
  category?: "stroke" | "cardiac" | "breathing" | "neurologic" | "self_harm";
  message?: string;
};

const emergencyPatterns: Array<{
  category: NonNullable<EmergencyAssessment["category"]>;
  pattern: RegExp;
}> = [
  {
    category: "stroke",
    pattern:
      /\b(sudden(ly)?\s+(slurred speech|trouble speaking|can'?t speak|confusion|facial droop|face droop|one[- ]sided weakness)|face droop(ping)?|one[- ]sided (weakness|numbness))\b/i,
  },
  {
    category: "cardiac",
    pattern:
      /\b(severe chest (pain|pressure)|crushing chest (pain|pressure)|chest pain (radiating|spreading) to (my )?(arm|jaw|back))\b/i,
  },
  {
    category: "breathing",
    pattern:
      /\b(can'?t breathe|cannot breathe|gasping for air|severe (shortness of breath|difficulty breathing)|turning blue)\b/i,
  },
  {
    category: "neurologic",
    pattern: /\b(seizure|loss of consciousness|unconscious|sudden severe confusion)\b/i,
  },
  {
    category: "self_harm",
    pattern:
      /\b(kill myself|end my life|suicid(e|al)|hurt myself|self[- ]harm|don'?t want to live)\b/i,
  },
];

export function assessEmergency(input: string): EmergencyAssessment {
  const text = input
    .replace(/\b(no|not having|without)\s+(severe\s+)?(chest pain|shortness of breath|trouble breathing)\b/gi, "")
    .slice(0, 4000);

  const match = emergencyPatterns.find(({ pattern }) => pattern.test(text));
  if (!match) return { emergency: false };

  const selfHarm = match.category === "self_harm";
  return {
    emergency: true,
    category: match.category,
    message: selfHarm
      ? "You may be in immediate danger. Call your local emergency number now. In the U.S. or Canada, call or text 988. If you can, stay with someone you trust."
      : "These symptoms could be an emergency. Call your local emergency number now or go to the nearest emergency department. Do not wait for a routine appointment.",
  };
}
