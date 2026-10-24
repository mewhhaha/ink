import { instantiateGuest } from "@mewhhaha/blot";
import { assert, assertEquals } from "@std/assert";
import { compile } from "../support.ts";

const fixture = await compile(
  new URL("./ui-text.blot", import.meta.url),
);
const { guest } = fixture;
const call = (entry: string, values: number[]) =>
  Array.from(guest.call(entry, new Uint32Array(values)) as Uint32Array);
const pack = (parts: number[][]) =>
  parts.flatMap((part) => [part.length, ...part]);

Deno.test("text: Unicode split and join preserve empty chunks and snapshots", () => {
  for (
    const points of [
      [],
      [32],
      [10],
      [32, 32, 10, 10, 32],
      [0, 65, 32, 128578, 32, 32, 66615, 10, 10],
      Array.from({ length: 4096 }, (_, i) => [128578, 32, 10, 66615][i % 4]),
    ]
  ) {
    const text = String.fromCodePoint(...points);
    const codePoints = (value: string) =>
      Array.from(value, (point) => point.codePointAt(0)!);
    assertEquals(
      call("words", points),
      pack(text.split(" ").filter((word) => word.length > 0).map(codePoints)),
    );
    assertEquals(call("lines", points), pack(text.split("\n").map(codePoints)));
    assertEquals(
      call("text_snapshots", points),
      pack([
        [...points, 32, ...points],
        codePoints(text.split(" ").filter((word) => word.length > 0).join(" ")),
        points,
        points.map(() => 0),
      ]),
    );
    for (const separator of [[], [32], [128578, 10, 66615]]) {
      for (const parts of [[], [[]], [[], [], []], [points, [], points]]) {
        const input = [separator.length, ...separator, ...pack(parts)];
        const expected: number[] = [];
        for (let i = 0; i < parts.length; i++) {
          if (i > 0) expected.push(...separator);
          expected.push(...parts[i]);
        }
        assertEquals(call("joined", input), expected);
        assertEquals(call("joined", input), expected);
      }
    }
  }
});

type Node = [number, number, number, number, number, number, number, number];
const button = 3;
const tab = 14;
const make = (id: number, parent = 0): Node => [
  id,
  parent,
  1,
  0,
  0,
  0,
  0,
  button,
];
function expectedFocus(nodes: Node[], focus: number) {
  const available = (node: Node) => {
    let at = node;
    for (let i = 0; i < 64; i++) {
      if (at[3] || at[4]) return false;
      if (at[1] === 0) return true;
      const parent = nodes.find((node) => node[0] === at[1]);
      if (!parent) return false;
      at = parent;
    }
    return false;
  };
  const hidden = (node: Node) => {
    let at = node;
    for (let i = 0; i < 64; i++) {
      if (at[3]) return true;
      if (at[1] === 0) return false;
      const parent = nodes.find((node) => node[0] === at[1]);
      if (!parent) return true;
      at = parent;
    }
    return true;
  };
  const within = (node: Node, scope: number) => {
    let at = node;
    for (let i = 0; i < 64; i++) {
      if (at[0] === scope) return true;
      const parent = nodes.find((node) => node[0] === at[1]);
      if (!parent) return false;
      at = parent;
    }
    return false;
  };
  let modal = 0;
  for (const node of nodes) if (node[5] && available(node)) modal = node[0];
  const reached = nodes.filter((node) =>
    node[0] !== 0 && node[2] !== 0 && available(node) &&
    (modal === 0 || within(node, modal))
  ).map((node) => node[0]);
  const order = nodes.filter((node) =>
    reached.includes(node[0]) && node[0] !== 0 && node[2] !== 0 &&
    available(node) &&
    (modal === 0 || within(node, modal)) &&
    (node[7] !== tab || node[6] !== 1)
  ).map((node) => node[0]);
  let current = 0;
  if (reached.includes(focus)) current = focus;
  else if (modal !== 0 && order.length > 0) current = order[0];
  return [
    current,
    modal,
    ...pack([order, reached]),
    ...nodes.map((node) =>
      Number(hidden(node) || modal !== 0 && !within(node, modal))
    ),
    ...nodes.map((node) => Number(current !== 0 && node[0] === current)),
    ...nodes.map((node) => Number(node[3] !== 0)),
  ];
}
Deno.test("ui tree: indexed settling matches bounded ancestor semantics and retains old worlds", () => {
  const cases: Node[][] = [[], [make(0)], [make(0xffffffff)]];
  for (const depth of [1, 2, 16, 17, 63, 64, 65, 128]) {
    const nodes = Array.from(
      { length: depth },
      (_, i) => make(0xffffffff - i, 0),
    );
    for (let i = 1; i < nodes.length; i++) nodes[i][1] = nodes[i - 1][0];
    cases.push(nodes);
    const modal = nodes.map((node) => node.slice() as Node);
    modal[0][5] = 1;
    cases.push(modal);
  }
  const inherited = [make(1), make(2, 1), make(3), make(4, 3), make(5, 99)];
  inherited[0][3] = 1;
  inherited[2][4] = 1;
  cases.push(inherited, [make(2, 1), make(1)], [make(1, 2), make(2, 1)]);
  const duplicates = [make(1), make(1), make(2, 1), make(3), make(4, 3)];
  duplicates[0][4] = 1;
  duplicates[3][5] = 1;
  cases.push(duplicates);
  const manyDuplicates = Array.from(
    { length: 48 },
    (_, i) => make(0xffffffff - i % 8),
  );
  manyDuplicates[0][3] = 1;
  for (let i = 16; i < manyDuplicates.length; i++) {
    manyDuplicates[i][1] = 0xffffffff;
  }
  cases.push(manyDuplicates);
  // Availability stops at parent 0, while modal containment can follow a
  // declared node with id 0. Keep those two ancestor rules distinct.
  const zero = [make(0, 2), make(1), make(2)];
  zero[2][5] = 1;
  cases.push(zero);
  const tabs = [make(1), make(2, 1), make(3, 1)];
  tabs[0][5] = 1;
  tabs[1][7] = tab;
  tabs[1][6] = 1;
  tabs[2][7] = tab;
  tabs[2][6] = 2;
  cases.push(tabs);
  let random = 813;
  for (let round = 0; round < 12; round++) {
    const nodes: Node[] = [];
    for (let i = 0; i < 96; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const node = make(0xffffffff - i, 0);
      if (i > 0 && random % 3 !== 0) node[1] = nodes[random % i][0];
      node[2] = Number(random % 7 !== 0);
      node[3] = Number(random % 19 === 0);
      node[4] = Number(random % 23 === 0);
      node[5] = Number(random % 29 === 0);
      nodes.push(node);
    }
    cases.push(nodes, nodes.slice().reverse());
  }
  for (const nodes of cases) {
    for (const focus of [0, nodes.at(-1)?.[0] ?? 1, 16777217]) {
      const input = [focus, ...nodes.flat()];
      assertEquals(call("focus", input), expectedFocus(nodes, focus));
    }
  }
});
Deno.test("ui/text: adversarial batches retain witnesses within bounded guest memory", async () => {
  const built = await fixture.compiler.build();
  assert(built.success);
  let sum = 0;
  for (let i = 0; i < 4096; i++) sum += 128578 + 97 + i % 26;
  const cases = [
    {
      entry: "ui_deep_tree",
      size: 2048,
      expected: [2048, 32, 32, 0xffffffff - 2016, 0xffffffff - 2016, 2016],
      limit: 4 * 1024 * 1024,
    },
    {
      entry: "text_join_many",
      size: 4096,
      expected: [4096, 16382, sum + 4095 * 66625],
      limit: 512 * 1024,
    },
    {
      entry: "text_words_long",
      size: 4096,
      expected: [4096, 4096, 8192, sum],
      limit: 1024 * 1024,
    },
    {
      entry: "text_lines_long",
      size: 4096,
      expected: [4096, 4097, 8192, sum],
      limit: 1024 * 1024,
    },
  ];
  for (const { entry, size, expected, limit } of cases) {
    const isolated = await instantiateGuest(built.bytes);
    try {
      let committed = 0;
      for (let replay = 0; replay < 3; replay++) {
        assertEquals(
          Array.from(isolated.call(entry, size) as Uint32Array),
          expected,
        );
        const bytes = isolated.memoryBytes();
        assert(bytes <= limit, `${entry}: ${bytes} committed bytes`);
        if (replay > 0) assertEquals(bytes, committed);
        committed = bytes;
      }
    } finally {
      isolated.dispose();
    }
  }
});
Deno.test.afterAll(() => fixture.dispose());
