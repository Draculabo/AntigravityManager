import { z } from "zod";

export const setThemeModeInputSchema = z.enum(["light", "dark", "system"]);
