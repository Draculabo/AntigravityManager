import { z } from "zod";
import { os } from "@orpc/server";
import {
  isProcessRunning,
  closeAntigravity,
  startAntigravity,
} from "./handler";

export const processRouter = os.router({
  isProcessRunning: os.output(z.boolean()).handler(async () => {
    return isProcessRunning();
  }),

  closeAntigravity: os.output(z.void()).handler(async () => {
    await closeAntigravity();
  }),

  startAntigravity: os.output(z.void()).handler(async () => {
    await startAntigravity();
  }),
});
