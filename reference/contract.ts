import type { Json, ToolDefinition } from "../src/contracts/types.js";

const closed = (properties: Record<string, Json>, required = Object.keys(properties)): Record<string, Json> => ({ type: "object", properties, required, additionalProperties: false });
const text = { type: "string", minLength: 1, maxLength: 128 };
const count = { type: "integer", minimum: 0, maximum: 1000 };
export const reservationSchema = closed({ id: text, key: text, quantity: { type: "integer", minimum: 1, maximum: 1000 } });
export const fixtureSchema = closed({ available: count, reservations: { type: "array", items: reservationSchema, maxItems: 1000 } });
export const agentSettingsSchema = closed({ variant: { type: "string", enum: ["normal", "duplicate", "false-claim", "crash", "candidate-error", "hang"] } });
export const environmentSettingsSchema = closed({ prepareFailure: { type: "boolean" }, missingSnapshot: { type: "boolean" }, cleanupFailure: { type: "boolean" } });
export const tools: ToolDefinition[] = [
  { name: "stock", input: closed({}), output: closed({ available: count }) },
  { name: "reserve", input: closed({ key: text, quantity: { type: "integer", minimum: 1, maximum: 1000 } }), output: reservationSchema },
  { name: "reservations", input: closed({}), output: closed({ reservations: { type: "array", items: reservationSchema, maxItems: 1000 }, available: count }) },
];
export interface Inventory { available: number; reservations: { id: string; key: string; quantity: number }[]; }
