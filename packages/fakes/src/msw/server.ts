// @lims/fakes/msw (C0-0C, T0C-08, AC-0C-4.2) — MSW node server for Vitest (02-TRD §5.5). No setupWorker: the browser never calls the API (04 S4).
import { setupServer } from "msw/node";
import { handlers } from "./handlers.generated.ts";

export { handlers };
export const server = setupServer(...handlers);
