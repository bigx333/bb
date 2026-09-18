import { z } from "zod";

export const featureFlagsSchema = z.object({
  placeholder: z.boolean(),
  durableMessageDelivery: z.boolean().optional(),
  timelineWindowEventBudget: z.number().int().positive(),
});
export type FeatureFlags = z.infer<typeof featureFlagsSchema>;

export const defaultFeatureFlags: FeatureFlags = {
  placeholder: false,
  timelineWindowEventBudget: 1_500,
};
