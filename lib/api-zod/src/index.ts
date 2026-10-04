export * from "./generated/api";
export * from "./generated/types";
// Orval gives mixed path/query operations the same Params name for the
// generated path schema and query type. Prefer the runtime Zod schema and
// retain the query-shape type under a distinct name.
export { ListAcademyConsoleRegistrationsParams } from "./generated/api";
export type {
  ListAcademyConsoleRegistrationsParams as ListAcademyConsoleRegistrationsQuery,
} from "./generated/types";
export * from "./recordingSchedule";
export * from "./videoTitle";
export * from "./statsRanking";

import * as z from "zod";
import { updateProfileBodyAgeMin, updateProfileBodyAgeMax } from "./generated/api";

// Override: enforce integer age (Orval generates zod.number() for OpenAPI integer,
// which accepts floats; this shadow export adds .int() to match the spec intent)
export const UpdateProfileBody = z.object({
  name: z.string(),
  phone: z.string(),
  position: z.enum(["goalkeeper", "defender", "midfielder", "forward"]),
  age: z
    .number()
    .int()
    .min(updateProfileBodyAgeMin)
    .max(updateProfileBodyAgeMax),
  gender: z.enum(["male", "female", "prefer_not_to_say"]),
});
