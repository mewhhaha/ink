import type { ActionDescription, GameAction } from "@ink/blot/protocol.ts";
import type { BlotPresentation } from "@ink/blot/runtime.ts";
import { type Microseconds, microseconds } from "@ink/runtime/session.ts";
import type { LocalizationResolver } from "@ink/ui/localization.ts";
import { require_ui_text } from "@ink/ui/localization.ts";
import {
  flatten_semantic_tree,
  type SemanticNode,
  type UiId,
} from "@ink/ui/semantic.ts";
import { narrative_timeline_step_us } from "./contract.ts";

export interface NarrativeDialoguePresentation {
  readonly speaker: string;
  readonly text: string;
  readonly width: number;
  readonly height: number;
}

export interface NarrativeChoicePresentation {
  readonly id: string;
  readonly label: string;
  readonly action: GameAction;
}

export interface NarrativeTimelinePresentation {
  readonly elapsed_us: number;
  readonly duration_us: number;
}

export interface NarrativeRestartPresentation {
  readonly label: string;
  readonly action: GameAction;
}

export interface NarrativePresentation {
  readonly dialogue: NarrativeDialoguePresentation;
  readonly evidence: string | undefined;
  readonly timeline: NarrativeTimelinePresentation | undefined;
  readonly choices: readonly NarrativeChoicePresentation[];
  readonly restart: NarrativeRestartPresentation;
}

const choice_prefix = "narrative.choice.";
const literal_resolver: LocalizationResolver = {
  resolve(id) {
    throw new Error(
      `narrative UI unexpectedly requested localization message ${
        JSON.stringify(id)
      }`,
    );
  },
};

export function narrative_presentation(
  presentation: BlotPresentation,
): NarrativePresentation {
  const nodes = flatten_semantic_tree(presentation.observation.ui.root);
  const dialogue = required_node(nodes, "narrative.dialogue", "text");
  const speaker = required_node(nodes, "narrative.speaker", "text");
  const timeline = optional_node(nodes, "narrative.timeline", "progress");
  const evidence = optional_node(nodes, "narrative.evidence", "text");
  const choices = nodes.flatMap((node) => {
    if (node.role !== "button" || !node.id.startsWith(choice_prefix)) {
      return [];
    }
    return [choice_presentation(node, presentation.observation.actions)];
  });
  const restart = required_node(nodes, "narrative.restart", "button");
  if (
    dialogue.size?.width === undefined || dialogue.size.height === undefined
  ) {
    throw new Error("narrative dialogue has no authored presentation size");
  }
  return Object.freeze({
    dialogue: Object.freeze({
      speaker: require_ui_text(speaker.label, literal_resolver),
      text: require_ui_text(dialogue.label, literal_resolver),
      width: dialogue.size.width,
      height: dialogue.size.height,
    }),
    evidence: evidence === undefined
      ? undefined
      : require_ui_text(evidence.label, literal_resolver),
    timeline: timeline === undefined ? undefined : Object.freeze({
      elapsed_us: timeline.value,
      duration_us: timeline.maximum,
    }),
    choices: Object.freeze(choices),
    restart: Object.freeze({
      label: require_ui_text(restart.label, literal_resolver),
      action: activation(restart.id, presentation.observation.actions),
    }),
  });
}

export function next_narrative_timeline_step(
  presentation: BlotPresentation,
): Microseconds | undefined {
  const timeline = narrative_presentation(presentation).timeline;
  if (timeline === undefined || timeline.elapsed_us >= timeline.duration_us) {
    return undefined;
  }
  return microseconds(
    Math.min(
      narrative_timeline_step_us,
      timeline.duration_us - timeline.elapsed_us,
    ),
  );
}

function choice_presentation(
  node: Extract<SemanticNode, { readonly role: "button" }>,
  actions: readonly ActionDescription[],
): NarrativeChoicePresentation {
  return Object.freeze({
    id: node.id.slice(choice_prefix.length),
    label: require_ui_text(node.label, literal_resolver),
    action: activation(node.id, actions),
  });
}

function activation(
  node: UiId,
  actions: readonly ActionDescription[],
): GameAction {
  const description = actions.find(({ trigger }) =>
    trigger.type === "activate" && trigger.target === node
  );
  if (description === undefined) {
    throw new Error(`narrative button ${node} has no activation action`);
  }
  return description.action;
}

function required_node(
  nodes: readonly SemanticNode[],
  id: string,
  role: "button",
): Extract<SemanticNode, { readonly role: "button" }>;
function required_node(
  nodes: readonly SemanticNode[],
  id: string,
  role: "progress",
): Extract<SemanticNode, { readonly role: "progress" }>;
function required_node(
  nodes: readonly SemanticNode[],
  id: string,
  role: "text",
): Extract<SemanticNode, { readonly role: "text" }>;
function required_node(
  nodes: readonly SemanticNode[],
  id: string,
  role: SemanticNode["role"],
): SemanticNode {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) {
    throw new Error(`narrative presentation has no UI node ${id}`);
  }
  if (node.role !== role) {
    throw new Error(
      `narrative UI node ${id} has role ${node.role}, expected ${role}`,
    );
  }
  return node;
}

function optional_node(
  nodes: readonly SemanticNode[],
  id: string,
  role: "progress",
): Extract<SemanticNode, { readonly role: "progress" }> | undefined;
function optional_node(
  nodes: readonly SemanticNode[],
  id: string,
  role: "text",
): Extract<SemanticNode, { readonly role: "text" }> | undefined;
function optional_node(
  nodes: readonly SemanticNode[],
  id: string,
  role: SemanticNode["role"],
): SemanticNode | undefined {
  const node = nodes.find((candidate) => candidate.id === id);
  if (node === undefined) return undefined;
  if (node.role !== role) {
    throw new Error(
      `narrative UI node ${id} has role ${node.role}, expected ${role}`,
    );
  }
  return node;
}
