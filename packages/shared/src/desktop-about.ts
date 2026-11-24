import { z } from "zod";

export const desktopAboutDialogPayloadSchema = z
  .object({
    appVersion: z.string().trim().min(1).max(128),
    optimizedForAppleSilicon: z.boolean(),
  })
  .strict();

export type DesktopAboutDialogPayload = z.infer<typeof desktopAboutDialogPayloadSchema>;
