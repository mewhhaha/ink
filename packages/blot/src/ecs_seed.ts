import {
  type Effect,
  type Fails,
  from_either,
  Left,
  Program,
  run,
  run_except,
} from "@mewhhaha/typeclasses";

type SeedFailure = readonly ["ecs.seed.parse", string];
type SeedParser<result> = Effect<Fails<SeedFailure>, result>;
type ParsedCell =
  | { readonly type: "parsed"; readonly value: bigint }
  | { readonly type: "invalid"; readonly message: string };

const Parse = Program.scope<Fails<SeedFailure>>();
const minimum_cell = -(1n << 63n);
const maximum_cell = (1n << 63n) - 1n;

export function parse_indexed_seed(
  source: string,
  field_count: number,
  capacity: number,
): readonly (readonly bigint[])[] {
  const outcome = run(run_except(parse_seed(source, field_count, capacity)));
  const [branch, value] = outcome.value();
  if (branch === "Left") throw new Error(value[1]);
  return value;
}

export function parse_resource_seed(
  source: string,
  field_count: number,
): readonly bigint[] {
  const rows = parse_indexed_seed(`${source};`, field_count, 1);
  const values = rows[0];
  if (!values) {
    throw new Error("ECS resource seed must contain one value");
  }
  return values;
}

function parse_seed(
  source: string,
  field_count: number,
  capacity: number,
): SeedParser<readonly (readonly bigint[])[]> {
  return Parse(function* () {
    const encoded_rows = source.trim().split(";");
    if (encoded_rows.at(-1) === "") encoded_rows.pop();
    if (encoded_rows.length > capacity) {
      return yield* reject(
        `ECS seed has ${encoded_rows.length} entities but world capacity is ${capacity}`,
      );
    }

    const rows: bigint[][] = [];
    for (const [entity, encoded_row] of encoded_rows.entries()) {
      const encoded_fields = encoded_row.trim().split(",");
      if (encoded_fields.length !== field_count) {
        return yield* reject(
          `ECS seed entity ${entity} has ${encoded_fields.length} fields; component requires ${field_count}`,
        );
      }
      const fields: bigint[] = [];
      for (const [field, encoded_field] of encoded_fields.entries()) {
        const parsed_cell = parse_cell(encoded_field, entity, field);
        if (parsed_cell.type === "invalid") {
          return yield* reject(parsed_cell.message);
        }
        fields.push(parsed_cell.value);
      }
      rows.push(fields);
    }
    return rows;
  });
}

function parse_cell(
  source: string,
  entity: number,
  field: number,
): ParsedCell {
  const trimmed = source.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    return {
      type: "invalid",
      message: `ECS seed entity ${entity} field ${field} ${
        JSON.stringify(trimmed)
      } must be an integer`,
    };
  }
  const value = BigInt(trimmed);
  if (value < minimum_cell || value > maximum_cell) {
    return {
      type: "invalid",
      message:
        `ECS seed entity ${entity} field ${field} ${value} is outside signed 64-bit range`,
    };
  }
  return { type: "parsed", value };
}

function reject<result = never>(message: string): SeedParser<result> {
  return from_either(Left<SeedFailure, result>(["ecs.seed.parse", message]));
}
