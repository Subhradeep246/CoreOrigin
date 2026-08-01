import { z } from "zod";

export const specialties = [
  "Primary care",
  "Neurology",
  "Pulmonology",
  "Cardiology",
  "Mental health",
  "Speech-language pathology",
  "Ear, nose and throat",
] as const;

export const providerSearchSchema = z.object({
  location: z.string().trim().min(2).max(120),
  specialty: z.enum(specialties),
  insurance: z.string().trim().min(2).max(120).optional(),
});

export const providerSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(200),
  facilityName: z.string().max(200).optional(),
  address: z.string().max(300).optional(),
  phone: z.string().max(40).optional(),
  website: z.string().url().max(500).optional(),
  rating: z.number().min(0).max(5).optional(),
  reviewCount: z.number().int().min(0).optional(),
  categories: z.array(z.string().max(100)).max(10).default([]),
});

export const issueKinds = ["new", "continuation"] as const;

export const appointmentRequestSchema = z.object({
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, for example +12125551234"),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  location: z.string().trim().min(2).max(120),
  specialty: z.enum(specialties),
  reason: z.string().trim().min(3).max(1000),
  reasonCategory: z.string().trim().min(2).max(80).default("General consultation"),
  issueKind: z.enum(issueKinds),
  insurance: z.string().trim().min(2).max(120),
  modality: z.enum(["in_person", "telehealth", "either"]),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timeWindow: z.enum(["morning", "afternoon", "evening", "anytime"]),
  timezone: z.string().trim().min(3).max(80),
  provider: providerSchema.optional(),
  consent: z.object({
    careData: z.literal(true),
    screening: z.boolean().default(false),
    sms: z.boolean().default(false),
  }),
  source: z.enum(["web", "voice", "sms", "agent_tool"]).default("web"),
});

export const followUpMessageSchema = z.object({
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, for example +12125551234"),
  issueKind: z.enum(issueKinds),
  conversationId: z.string().trim().max(120).optional(),
  consent: z.object({
    sms: z.literal(true),
  }),
  source: z.enum(["web", "voice", "sms", "agent_tool", "post_call"]).default("agent_tool"),
});

export const registerStartSchema = z.object({
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, for example +12125551234"),
  email: z.string().trim().email().max(200).optional().or(z.literal("")),
  consent: z.object({
    careData: z.literal(true),
    screening: z.boolean().default(false),
    sms: z.boolean().default(true),
  }),
});

export const registerVerifySchema = z.object({
  phone: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, for example +12125551234"),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export type AppointmentRequestInput = z.infer<typeof appointmentRequestSchema>;
export type FollowUpMessageInput = z.infer<typeof followUpMessageSchema>;
export type ProviderResult = z.infer<typeof providerSchema> & {
  sourceUrl?: string;
  availability: "unknown";
};
