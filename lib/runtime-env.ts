export function getEnv(name: string): string | undefined {
  const value = process.env[name];
  return value?.trim() || undefined;
}

export function envFlag(name: string, fallback = false): boolean {
  const value = getEnv(name);
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export const ELEVENLABS_AGENT_ID =
  getEnv("ELEVENLABS_AGENT_ID") ?? "agent_5501kx8wda1pendvh6xvme7fxn78";
