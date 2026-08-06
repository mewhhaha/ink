export interface AuthoringRevision<Document> {
  readonly sequence: number;
  readonly label: string;
  readonly document: Document;
}

export interface AuthoringHistory<Document> {
  readonly previous: readonly AuthoringRevision<Document>[];
  readonly current: AuthoringRevision<Document>;
  readonly next: readonly AuthoringRevision<Document>[];
}

export type HistoryChange<Document> =
  | { readonly type: "changed"; readonly history: AuthoringHistory<Document> }
  | {
    readonly type: "unavailable";
    readonly history: AuthoringHistory<Document>;
  };

export function create_authoring_history<Document>(
  document: Document,
): AuthoringHistory<Document> {
  return Object.freeze({
    previous: Object.freeze([]),
    current: revision(0, "Initial project", document),
    next: Object.freeze([]),
  });
}

export function commit_authoring_revision<Document>(
  history: AuthoringHistory<Document>,
  label: string,
  document: Document,
  maximum_revisions = 100,
): AuthoringHistory<Document> {
  const limit = positive_integer(maximum_revisions, "authoring history limit");
  const previous = [...history.previous, history.current].slice(-limit);
  return Object.freeze({
    previous: Object.freeze(previous),
    current: revision(history.current.sequence + 1, label, document),
    next: Object.freeze([]),
  });
}

export function undo_authoring_revision<Document>(
  history: AuthoringHistory<Document>,
): HistoryChange<Document> {
  const restored = history.previous.at(-1);
  if (restored === undefined) return { type: "unavailable", history };
  return {
    type: "changed",
    history: Object.freeze({
      previous: Object.freeze(history.previous.slice(0, -1)),
      current: restored,
      next: Object.freeze([history.current, ...history.next]),
    }),
  };
}

export function redo_authoring_revision<Document>(
  history: AuthoringHistory<Document>,
): HistoryChange<Document> {
  const restored = history.next[0];
  if (restored === undefined) return { type: "unavailable", history };
  return {
    type: "changed",
    history: Object.freeze({
      previous: Object.freeze([...history.previous, history.current]),
      current: restored,
      next: Object.freeze(history.next.slice(1)),
    }),
  };
}

function revision<Document>(
  sequence: number,
  label: string,
  document: Document,
): AuthoringRevision<Document> {
  const parsed_label = label.trim();
  if (parsed_label.length === 0) {
    throw new Error(`authoring revision ${sequence} label cannot be empty`);
  }
  return Object.freeze({ sequence, label: parsed_label, document });
}

function positive_integer(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} ${value} must be a positive safe integer`);
  }
  return value;
}
