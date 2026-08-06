import type { ReactNode } from "react";
import { EditorButton } from "./controls.tsx";

interface StateNoticeProps {
  readonly title: string;
  readonly message: string;
  readonly icon: ReactNode;
  readonly tone: "neutral" | "warning" | "error";
  readonly role: "status" | "alert";
  readonly action?: { readonly label: string; readonly onPress: () => void };
}

function StateNotice({
  title,
  message,
  icon,
  tone,
  role,
  action,
}: StateNoticeProps) {
  return (
    <section
      className="ink-state-notice"
      data-tone={tone}
      role={role}
      aria-live={role === "alert" ? "assertive" : "polite"}
    >
      <span className="ink-state-icon" aria-hidden="true">{icon}</span>
      <h3>{title}</h3>
      <p>{message}</p>
      {action && (
        <EditorButton onPress={action.onPress}>{action.label}</EditorButton>
      )}
    </section>
  );
}

export interface LoadingStateProps {
  readonly label: string;
  readonly detail?: string;
}

export function LoadingState(
  { label, detail = "Please wait" }: LoadingStateProps,
) {
  return (
    <StateNotice
      title={label}
      message={detail}
      icon={<span className="ink-spinner" />}
      tone="neutral"
      role="status"
    />
  );
}

export interface EmptyStateProps {
  readonly title: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}

export function EmptyState({ title, message, action }: EmptyStateProps) {
  return (
    <StateNotice
      title={title}
      message={message}
      icon="◇"
      tone="neutral"
      role="status"
      action={action}
    />
  );
}

export interface WarningStateProps {
  readonly title: string;
  readonly message: string;
  readonly action?: { readonly label: string; readonly onPress: () => void };
}

export function WarningState({ title, message, action }: WarningStateProps) {
  return (
    <StateNotice
      title={title}
      message={message}
      icon="△"
      tone="warning"
      role="status"
      action={action}
    />
  );
}

export interface ErrorStateProps {
  readonly title: string;
  readonly message: string;
  readonly retry?: { readonly label: string; readonly onPress: () => void };
}

export function ErrorState({ title, message, retry }: ErrorStateProps) {
  return (
    <StateNotice
      title={title}
      message={message}
      icon="!"
      tone="error"
      role="alert"
      action={retry}
    />
  );
}

export interface CapabilityStateProps {
  readonly capability: string;
  readonly availability: "available" | "unavailable" | "degraded";
  readonly detail: string;
}

export function CapabilityState({
  capability,
  availability,
  detail,
}: CapabilityStateProps) {
  const tone = availability === "unavailable"
    ? "error"
    : availability === "degraded"
    ? "warning"
    : "neutral";
  const role = availability === "unavailable" ? "alert" : "status";
  return (
    <StateNotice
      title={`${capability}: ${availability}`}
      message={detail}
      icon={availability === "available"
        ? "✓"
        : availability === "degraded"
        ? "△"
        : "×"}
      tone={tone}
      role={role}
    />
  );
}
