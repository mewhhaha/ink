/**
 * Comment mode: pins in the world that follow the entity they are on, a
 * composer that captures the view, and a list panel. Comments persist to
 * `.ink/comments.json`, where agents read and answer them.
 */
import { useEffect, useRef, useState } from "react";
import type { Comment } from "@ink/core";
import { mat4, type Vec3 } from "@ink/geometry";
import { useInk, useSession, useSessionValue } from "./context.tsx";
import { Icon } from "./icons.tsx";

export interface ComposerState {
  x: number;
  y: number;
  anchor: Comment["anchor"];
}

/** Where a comment's pin is now: on its entity if it still exists. */
export function pinPoint(
  comment: Comment,
  matrices: Map<number, Float32Array>,
): Vec3 | null {
  const { entity, local, point } = comment.anchor;
  const m = entity ? matrices.get(entity) : undefined;
  if (m && local) return mat4.transformPoint(m, local);
  return point ?? null;
}

export function CommentPins(
  { viewId, register }: { viewId: string; register(update: () => void): void },
) {
  const ink = useInk();
  const comments = useSessionValue((s) => s.comments);
  const showResolved = useSessionValue(() => false);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const [open, setOpen] = useState<string | null>(null);
  const visible = comments.filter((c) =>
    c.status === "open" || showResolved || c.id === open
  );

  useEffect(() => {
    const update = () => {
      const view = ink.views.get(viewId);
      const matrices = ink.scene().matrices;
      for (const comment of visible) {
        const element = refs.current.get(comment.id);
        if (!element) continue;
        const point = pinPoint(comment, matrices);
        const at = point && view?.project(point);
        if (!at) {
          element.style.display = "none";
          continue;
        }
        element.style.display = "";
        element.style.left = `${at[0]}px`;
        element.style.top = `${at[1]}px`;
      }
    };
    register(update);
    update();
  }, [visible, viewId]);

  return (
    <>
      {visible.map((comment) => (
        <div
          key={comment.id}
          ref={(element) => {
            if (element) refs.current.set(comment.id, element);
            else refs.current.delete(comment.id);
          }}
          className="ink-pin"
          data-resolved={comment.status === "resolved"}
          style={{ display: "none" }}
          onClick={() => setOpen(open === comment.id ? null : comment.id)}
        >
          {open === comment.id && (
            <CommentCard
              comment={comment}
              onClose={() => setOpen(null)}
            />
          )}
          <div className="ink-pin-bubble" title={comment.text}>
            <span>{comments.indexOf(comment) + 1}</span>
          </div>
        </div>
      ))}
    </>
  );
}

export function CommentCard(
  { comment, onClose }: { comment: Comment; onClose?(): void },
) {
  const session = useSession();
  const [reply, setReply] = useState("");
  return (
    <div
      className="ink-pin-card"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header>
        <Icon name="comment" size={12} />
        <span>{comment.author}</span>
        <span>·</span>
        <span>
          {comment.anchor.entityName ??
            (comment.anchor.entity ? `#${comment.anchor.entity}` : "point")}
        </span>
        <span className="ink-bar-spacer" />
        {onClose && (
          <button
            type="button"
            className="ink-button"
            data-icon-only="true"
            onClick={onClose}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </header>
      <p>{comment.text}</p>
      {comment.replies?.map((r, i) => (
        <p key={i} style={{ color: "var(--ink-muted)" }}>
          <b>{r.author}:</b> {r.text}
        </p>
      ))}
      <input
        className="ink-input"
        placeholder="Reply"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && reply.trim()) {
            session.updateComment(comment.id, {
              replies: [...(comment.replies ?? []), {
                author: "you",
                text: reply.trim(),
                created: new Date().toISOString(),
              }],
            });
            setReply("");
          }
        }}
      />
      <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
        <button
          type="button"
          className="ink-button"
          data-variant="outline"
          onClick={() =>
            session.updateComment(comment.id, {
              status: comment.status === "open" ? "resolved" : "open",
            })}
        >
          <Icon name="check" size={12} />{" "}
          {comment.status === "open" ? "Resolve" : "Reopen"}
        </button>
        <span className="ink-bar-spacer" />
        <button
          type="button"
          className="ink-button"
          data-variant="danger"
          onClick={() => session.removeComment(comment.id)}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
    </div>
  );
}

export function CommentComposer(
  { state, viewId, onClose }: {
    state: ComposerState;
    viewId: string;
    onClose(): void;
  },
) {
  const ink = useInk();
  const session = useSession();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const anchor = { ...state.anchor };
    if (anchor.entity && anchor.point) {
      const m = ink.scene().matrices.get(anchor.entity);
      if (m) anchor.local = mat4.transformPoint(mat4.invert(m), anchor.point);
    }
    let screenshot: string | undefined;
    try {
      const png = await ink.views.get(viewId)?.capture();
      if (png && ink.dev) {
        const saved = await ink.dev.client.postCapture([{
          name: "view.png",
          base64: png.split(",")[1],
        }]);
        screenshot = `${saved.dir}/view.png`;
      }
    } catch (error) {
      session.warn(`comment screenshot failed: ${error}`);
    }
    session.addComment({
      author: "you",
      text: text.trim(),
      anchor,
      screenshot,
    });
    onClose();
  };
  return (
    <div
      className="ink-composer"
      style={{
        left: Math.max(8, state.x - 140),
        top: Math.max(8, state.y + 12),
      }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        className="ink-input"
        autoFocus
        rows={3}
        placeholder={state.anchor.entityName
          ? `Comment on ${state.anchor.entityName}`
          : "Comment on this spot"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <footer>
        <span>
          {busy ? "Saving…" : "Enter to pin · Shift+Enter for a new line"}
        </span>
        <button
          type="button"
          className="ink-button"
          data-variant="primary"
          disabled={!text.trim() || busy}
          onClick={submit}
        >
          Pin
        </button>
      </footer>
    </div>
  );
}

/** All comments, newest last; click to select what a comment is about. */
export function CommentList() {
  const session = useSession();
  const comments = useSessionValue((s) => s.comments);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const shown = comments.filter((c) => filter === "all" || c.status === "open");
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 2, padding: 6 }}>
        <button
          type="button"
          className="ink-button"
          aria-pressed={filter === "open"}
          onClick={() =>
            setFilter("open")}
        >
          Open
        </button>
        <button
          type="button"
          className="ink-button"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          All
        </button>
      </div>
      {shown.length === 0 && (
        <div className="ink-empty">
          No comments. Press C and click in a view to pin one.
        </div>
      )}
      <div style={{ overflow: "auto", flex: 1 }}>
        {shown.map((c) => (
          <div
            key={c.id}
            className="ink-row"
            style={{
              height: "auto",
              alignItems: "flex-start",
              padding: "6px 10px",
              flexDirection: "column",
              gap: 2,
            }}
            onClick={() => c.anchor.entity && session.select([c.anchor.entity])}
          >
            <div
              style={{
                display: "flex",
                gap: 6,
                width: "100%",
                color: "var(--ink-muted)",
                fontSize: 11,
              }}
            >
              <span
                style={{
                  color: c.status === "open"
                    ? "var(--ink-comment)"
                    : "var(--ink-faint)",
                }}
              >
                #{comments.indexOf(c) + 1}
              </span>
              <span>
                {c.anchor.entityName ??
                  (c.anchor.entity ? `#${c.anchor.entity}` : "point")}
              </span>
              <span className="ink-bar-spacer" />
              <span>{c.author}</span>
            </div>
            <div style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>
              {c.text}
            </div>
            {c.replies?.map((r, i) => (
              <div key={i} style={{ color: "var(--ink-muted)" }}>
                ↳ {r.author}: {r.text}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
