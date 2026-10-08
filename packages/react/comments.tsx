/**
 * Comment mode: pins in the world that follow the entity they are on, a
 * composer that captures the view, and a list panel. Comments persist to
 * `.ink/comments.json`, where agents read and answer them.
 */
import { useEffect, useRef, useState } from "react";
import { type Comment, type CommentCapture, commentStatuses } from "@ink/core";
import { mat4, type Vec3 } from "@ink/geometry";
import { useInk, useSession, useSessionValue, useUi } from "./context.tsx";
import { Icon } from "./icons.tsx";
import {
  captureLive,
  captureUrl,
  createLiveCommands,
  saveHandoff,
} from "./live.ts";
import { openInEditor } from "./console.tsx";

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
    c.status !== "resolved" || showResolved || c.id === open
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
  { comment, onClose, inline = false }: {
    comment: Comment;
    onClose?(): void;
    inline?: boolean;
  },
) {
  const ink = useInk();
  const session = ink.session;
  const [reply, setReply] = useState("");
  const [captures, setCaptures] = useState<CommentCapture[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const work = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const attach = (label: CommentCapture["label"]) =>
    work(async () => {
      const shot = await captureLive(ink, Promise.resolve());
      setCaptures((
        old,
      ) => [...old, {
        label,
        path: shot.path,
        tick: shot.tick,
        view: shot.view,
      }]);
    });
  const send = () =>
    work(async () => {
      if (!reply.trim()) return;
      session.replyToComment(comment.id, {
        author: "you",
        text: reply.trim(),
        created: new Date().toISOString(),
        captures,
      });
      await ink.dev?.flushComments();
      setReply("");
      setCaptures([]);
    });
  const range = comment.anchor.range;
  const code = comment.anchor.code;
  return (
    <article
      className="ink-pin-card"
      data-inline={inline}
      data-comment-id={comment.id}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <header>
        <Icon name="comment" size={12} />
        <span>{comment.author}</span>
        <span>·</span>
        <span>
          {comment.anchor.entityName ??
            (comment.anchor.entity ? `#${comment.anchor.entity}` : "Session")}
        </span>
        <span className="ink-bar-spacer" />
        {onClose && (
          <button type="button" className="ink-button" onClick={onClose}>
            Close
          </button>
        )}
      </header>
      <p>{comment.text}</p>
      <div className="ink-comment-controls">
        <select
          className="ink-input"
          aria-label="Comment status"
          value={comment.status}
          onChange={(e) =>
            session.updateComment(comment.id, {
              status: e.target.value as Comment["status"],
            })}
        >
          {commentStatuses.map((s) => (
            <option key={s} value={s}>{s.replaceAll("_", " ")}</option>
          ))}
        </select>
        <input
          className="ink-input"
          aria-label="Assignee"
          placeholder="Unassigned"
          key={comment.assignee}
          defaultValue={comment.assignee ?? ""}
          onBlur={(e) =>
            session.updateComment(comment.id, {
              assignee: e.target.value.trim(),
            })}
        />
      </div>
      <div className="ink-comment-controls">
        <button
          type="button"
          className="ink-button"
          disabled={session.mode !== "play"}
          onClick={() => session.seek(range?.from ?? comment.anchor.tick)}
        >
          {range
            ? `Ticks ${range.from}–${range.to}`
            : `Tick ${comment.anchor.tick}`}
        </button>
        {code && (
          <button
            type="button"
            className="ink-button"
            onClick={() => openInEditor(code.file, code.line, code.column)}
          >
            {code.file}:{code.line}
          </button>
        )}
        {comment.handoff && (
          <button
            type="button"
            className="ink-button"
            disabled={busy}
            onClick={() =>
              work(async () => {
                await createLiveCommands(ink, Promise.resolve())("handoff", {
                  action: comment.anchor.mode === "play" ? "replay" : "open",
                  id: comment.handoff,
                });
              })}
          >
            Reproduce
          </button>
        )}
      </div>
      {comment.screenshot && (
        <CaptureEvidence
          captures={[{
            path: comment.screenshot,
            label: "before",
            tick: comment.anchor.tick,
          }]}
        />
      )}
      {comment.replies?.map((r, i) => (
        <div key={i} className="ink-comment-reply">
          <p>
            <b>{r.author}:</b> {r.text}
          </p>
          <CaptureEvidence captures={r.captures ?? []} />
        </div>
      ))}
      <textarea
        className="ink-input"
        placeholder="Reply"
        aria-label="Reply"
        rows={2}
        value={reply}
        onChange={(e) => setReply(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && reply.trim()) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <CaptureEvidence captures={captures} />
      <div className="ink-comment-controls">
        <button
          type="button"
          className="ink-button"
          disabled={busy}
          onClick={() => attach("before")}
        >
          Attach before
        </button>
        <button
          type="button"
          className="ink-button"
          disabled={busy}
          onClick={() => attach("after")}
        >
          Attach after
        </button>
        <button
          type="button"
          className="ink-button"
          data-variant="primary"
          disabled={busy || !reply.trim()}
          onClick={send}
        >
          Reply
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="ink-comment-controls">
        <button
          type="button"
          className="ink-button"
          data-variant="outline"
          onClick={() =>
            session.updateComment(comment.id, {
              status: comment.status === "resolved" ? "open" : "resolved",
            })}
        >
          <Icon name="check" size={12} />{" "}
          {comment.status === "resolved" ? "Reopen" : "Resolve"}
        </button>
        <span className="ink-bar-spacer" />
        <button
          type="button"
          className="ink-button"
          title="Delete comment"
          onClick={() => session.removeComment(comment.id)}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
    </article>
  );
}

function CaptureEvidence({ captures }: { captures: CommentCapture[] }) {
  return (
    <div className="ink-comment-captures">
      {captures.map((c, i) => {
        let url: string;
        try {
          url = captureUrl(c.path);
        } catch {
          return null;
        }
        return (
          <a key={i} href={url} target="_blank" rel="noreferrer">
            <img
              src={url}
              alt={`${c.label} at tick ${c.tick}`}
              loading="lazy"
            />
            <span>{c.label} · tick {c.tick}</span>
          </a>
        );
      })}
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
    const handoff = await saveHandoff(ink, text.trim()).catch((error) => {
      session.warn(`comment replay failed: ${error}`);
      return undefined;
    });
    session.addComment({
      handoff,
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

/** A filterable work queue, shared by people and agents. */
export function CommentList() {
  const comments = useSessionValue((s) => s.comments);
  const [filter, setFilter] = useState("active");
  const [assignee, setAssignee] = useState("");
  const shown = comments.filter((c) =>
    (filter === "all" ||
      (filter === "active" ? c.status !== "resolved" : c.status === filter)) &&
    (!assignee || c.assignee?.toLowerCase().includes(assignee.toLowerCase()))
  );
  return (
    <div className="ink-comment-list">
      <div className="ink-comment-controls">
        <select
          className="ink-input"
          aria-label="Filter comments"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="active">Active</option>
          <option value="all">All</option>
          {commentStatuses.map((s) => (
            <option key={s} value={s}>{s.replaceAll("_", " ")}</option>
          ))}
        </select>
        <input
          className="ink-input"
          aria-label="Filter assignee"
          placeholder="Filter assignee"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
        />
      </div>
      <div style={{ overflow: "auto", flex: 1 }}>
        {shown.length === 0 && (
          <div className="ink-empty">
            No matching comments. Press C and click a view to pin one.
          </div>
        )}
        {shown.map((c) => <CommentCard key={c.id} comment={c} inline />)}
      </div>
    </div>
  );
}

export function CommentQueue() {
  const ink = useInk();
  const open = useUi((u) => u.comments);
  if (!open) return null;
  return (
    <aside
      className="ink-comment-queue"
      role="dialog"
      aria-label="Comment queue"
    >
      <header className="ink-panel-header">
        <b>Comments</b>
        <span className="ink-bar-spacer" />
        <button
          type="button"
          className="ink-button"
          onClick={() => ink.ui.set({ comments: false })}
        >
          Close
        </button>
      </header>
      <CommentList />
    </aside>
  );
}
