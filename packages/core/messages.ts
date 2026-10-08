import type { EventModel, Schema } from "@ink/schema";

/** Fill a message's `{0}` and `{1}` slots. */
export function formatMessage(
  schema: Schema,
  id: number,
  args: number[],
): string {
  const message = schema.messages.find((m) => m.id === id);
  if (!message) return `message ${id} ${args.join(" ")}`.trim();
  return message.text.replace(/\{(\d+)\}/g, (_, n) => {
    const value = args[Number(n)];
    return value === undefined ? "" : formatNumber(value);
  });
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

/** The text of an event that carries a message field, if it has one. Numeric
 * fields after the message fill its slots in order. */
export function eventText(
  schema: Schema,
  event: EventModel,
): string | undefined {
  const record = schema.event(event.name);
  if (!record) return undefined;
  const messageField = record.fields.find((f) => f.node.kind === "message");
  if (!messageField) return undefined;
  const args = record.fields.filter((f) =>
    f.node.kind === "f32" || f.node.kind === "u32"
  )
    .map((f) => event.value[f.name] as number);
  return formatMessage(schema, event.value[messageField.name] as number, args);
}
