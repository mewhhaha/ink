import { defineSchema, f32, standard, vec3 } from "@ink/schema";

/** Many bodies that move, spin and bounce: the load `scripts/world-bench.ts`
 * measures. Static scenery is a transform and a mesh; bodies add `body`. */
const input = {
  components: {
    transform: standard.transform,
    mesh: standard.mesh,
    camera: standard.camera,
    light: standard.light,
    environment: standard.environment,
    body: {
      velocity: vec3(),
      spin: f32({ default: 1 }),
      bounce: f32({ default: 0.8 }),
    },
  },
  events: { ...standard.events },
};

export default defineSchema(input);

/** The same world with one more component, for the migration measurement. */
export const extended = defineSchema({
  ...input,
  components: { ...input.components, extra: { value: f32() } },
});
