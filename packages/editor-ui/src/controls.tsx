import {
  Button as Comp0Button,
  Checkbox as Comp0Checkbox,
  Switch as Comp0Switch,
} from "@comp0/react";
import {
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";

export type Interaction = "enabled" | "disabled";
export type ButtonTone = "default" | "primary" | "danger" | "ghost";

export interface EditorButtonProps {
  readonly children: ReactNode;
  readonly onPress?: () => void;
  readonly tone?: ButtonTone;
  readonly interaction?: Interaction;
  readonly button_type?: "button" | "submit" | "reset";
  readonly className?: string;
}

export function EditorButton({
  children,
  onPress,
  tone = "default",
  interaction = "enabled",
  button_type = "button",
  className,
}: EditorButtonProps) {
  return (
    <Comp0Button
      type={button_type}
      className={classes("ink-button", className)}
      data-tone={tone}
      disabled={interaction === "disabled"}
      onClick={onPress}
    >
      {children}
    </Comp0Button>
  );
}

export interface IconButtonProps extends Omit<EditorButtonProps, "children"> {
  readonly label: string;
  readonly icon: ReactNode;
}

export function IconButton({ label, icon, ...button }: IconButtonProps) {
  return (
    <Comp0Button
      type={button.button_type ?? "button"}
      aria-label={label}
      title={label}
      className={classes("ink-button ink-icon-button", button.className)}
      data-tone={button.tone ?? "default"}
      disabled={button.interaction === "disabled"}
      onClick={button.onPress}
    >
      {icon}
    </Comp0Button>
  );
}

interface FieldFrameProps {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly error?: string;
  readonly children: ReactNode;
}

function FieldFrame(
  { id, label, description, error, children }: FieldFrameProps,
) {
  const description_id = description === undefined ? undefined : `${id}-hint`;
  const error_id = error === undefined ? undefined : `${id}-error`;
  return (
    <div
      className="ink-field"
      data-invalid={error === undefined ? undefined : "true"}
    >
      <label className="ink-field-label" htmlFor={id}>{label}</label>
      {children}
      {description && (
        <span className="ink-field-hint" id={description_id}>
          {description}
        </span>
      )}
      {error && <span className="ink-field-error" id={error_id}>{error}</span>}
    </div>
  );
}

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly id?: string;
  readonly description?: string;
  readonly error?: string;
  readonly placeholder?: string;
  readonly interaction?: Interaction;
}

export function TextField({
  label,
  value,
  onValueChange,
  id: supplied_id,
  description,
  error,
  placeholder,
  interaction = "enabled",
}: TextFieldProps) {
  const generated_id = useId();
  const id = supplied_id ?? generated_id;
  return (
    <FieldFrame id={id} label={label} description={description} error={error}>
      <input
        id={id}
        className="ink-input"
        value={value}
        placeholder={placeholder}
        disabled={interaction === "disabled"}
        aria-invalid={error === undefined ? undefined : "true"}
        aria-describedby={described_by(id, description, error)}
        onChange={(event) =>
          onValueChange(event.currentTarget.value)}
      />
    </FieldFrame>
  );
}

export interface NumberFieldProps {
  readonly label: string;
  readonly value: number;
  readonly onValueChange: (value: number) => void;
  readonly id?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly step?: number;
  readonly suffix?: string;
  readonly interaction?: Interaction;
}

export function NumberField({
  label,
  value,
  onValueChange,
  id: supplied_id,
  minimum,
  maximum,
  step,
  suffix,
  interaction = "enabled",
}: NumberFieldProps) {
  const generated_id = useId();
  const id = supplied_id ?? generated_id;
  const update = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.currentTarget.valueAsNumber;
    if (Number.isFinite(next)) onValueChange(next);
  };
  return (
    <FieldFrame id={id} label={label}>
      <span className="ink-input-affix">
        <input
          id={id}
          className="ink-input"
          type="number"
          value={value}
          min={minimum}
          max={maximum}
          step={step}
          disabled={interaction === "disabled"}
          onChange={update}
        />
        {suffix && <span aria-hidden="true">{suffix}</span>}
      </span>
    </FieldFrame>
  );
}

export interface VectorValue {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface VectorFieldProps {
  readonly label: string;
  readonly value: VectorValue;
  readonly onValueChange: (value: VectorValue) => void;
  readonly id?: string;
  readonly step?: number;
  readonly interaction?: Interaction;
}

export function VectorField({
  label,
  value,
  onValueChange,
  id: supplied_id,
  step = 0.1,
  interaction = "enabled",
}: VectorFieldProps) {
  const generated_id = useId();
  const id = supplied_id ?? generated_id;
  return (
    <fieldset
      className="ink-field ink-vector-field"
      disabled={interaction === "disabled"}
    >
      <legend className="ink-field-label">{label}</legend>
      {(["x", "y", "z"] as const).map((axis) => (
        <label key={axis} className="ink-axis-field">
          <span>{axis.toUpperCase()}</span>
          <input
            id={`${id}-${axis}`}
            className="ink-input"
            type="number"
            value={value[axis]}
            step={step}
            onChange={(event) => {
              const next = event.currentTarget.valueAsNumber;
              if (Number.isFinite(next)) {
                onValueChange({ ...value, [axis]: next });
              }
            }}
          />
        </label>
      ))}
    </fieldset>
  );
}

export interface ColorFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly id?: string;
  readonly interaction?: Interaction;
}

export function ColorField({
  label,
  value,
  onValueChange,
  id: supplied_id,
  interaction = "enabled",
}: ColorFieldProps) {
  const generated_id = useId();
  const id = supplied_id ?? generated_id;
  return (
    <FieldFrame id={id} label={label}>
      <span className="ink-color-field">
        <input
          id={id}
          className="ink-color-swatch"
          type="color"
          value={value}
          disabled={interaction === "disabled"}
          onChange={(event) => onValueChange(event.currentTarget.value)}
        />
        <output htmlFor={id}>{value.toUpperCase()}</output>
      </span>
    </FieldFrame>
  );
}

export interface ChoiceControlProps {
  readonly label: string;
  readonly selected: boolean;
  readonly onSelectedChange: (selected: boolean) => void;
  readonly interaction?: Interaction;
}

export function CheckboxControl({
  label,
  selected,
  onSelectedChange,
  interaction = "enabled",
}: ChoiceControlProps) {
  return (
    <Comp0Checkbox
      className="ink-choice"
      checked={selected}
      disabled={interaction === "disabled"}
      onChange={onSelectedChange}
    >
      <span className="ink-choice-indicator" aria-hidden="true" />
      <span>{label}</span>
    </Comp0Checkbox>
  );
}

export function SwitchControl({
  label,
  selected,
  onSelectedChange,
  interaction = "enabled",
}: ChoiceControlProps) {
  return (
    <Comp0Switch
      className="ink-switch"
      checked={selected}
      disabled={interaction === "disabled"}
      onChange={onSelectedChange}
    >
      <span className="ink-switch-track" aria-hidden="true">
        <span />
      </span>
      <span>{label}</span>
    </Comp0Switch>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onValueChange: (value: string) => void;
  readonly id?: string;
  readonly interaction?: Interaction;
}

export function SelectField({
  label,
  value,
  options,
  onValueChange,
  id: supplied_id,
  interaction = "enabled",
}: SelectFieldProps) {
  const generated_id = useId();
  const id = supplied_id ?? generated_id;
  return (
    <FieldFrame id={id} label={label}>
      <select
        id={id}
        className="ink-input ink-select"
        value={value}
        disabled={interaction === "disabled"}
        onChange={(event) => onValueChange(event.currentTarget.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldFrame>
  );
}

export interface RangeFieldProps {
  readonly label: string;
  readonly value: number;
  readonly minimum: number;
  readonly maximum: number;
  readonly onValueChange: (value: number) => void;
  readonly id?: string;
  readonly step?: number;
  readonly interaction?: Interaction;
}

export function RangeField({
  label,
  value,
  minimum,
  maximum,
  onValueChange,
  id: supplied_id,
  step = 1,
  interaction = "enabled",
}: RangeFieldProps) {
  const generated_id = useId();
  const id = supplied_id ?? generated_id;
  return (
    <FieldFrame id={id} label={label}>
      <span className="ink-range-field">
        <input
          id={id}
          type="range"
          min={minimum}
          max={maximum}
          step={step}
          value={value}
          disabled={interaction === "disabled"}
          onChange={(event) => onValueChange(event.currentTarget.valueAsNumber)}
        />
        <output htmlFor={id}>{value}</output>
      </span>
    </FieldFrame>
  );
}

export interface TooltipProps {
  readonly label: string;
  readonly children: ReactNode;
}

export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className="ink-tooltip-anchor">
      {children}
      <span className="ink-tooltip" role="tooltip">{label}</span>
    </span>
  );
}

export interface MenuAction {
  readonly id: string;
  readonly label: string;
  readonly interaction?: Interaction;
}

export interface MenuProps {
  readonly label: string;
  readonly actions: readonly MenuAction[];
  readonly onAction: (id: string) => void;
}

export function Menu({ label, actions, onAction }: MenuProps) {
  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    const actions = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]:not(:disabled)',
    )];
    const focused = actions.indexOf(
      document.activeElement as HTMLButtonElement,
    );
    const requested = event.key === "ArrowDown"
      ? Math.min(actions.length - 1, focused + 1)
      : event.key === "ArrowUp"
      ? Math.max(0, focused - 1)
      : event.key === "Home"
      ? 0
      : event.key === "End"
      ? actions.length - 1
      : -1;
    if (requested >= 0) {
      event.preventDefault();
      actions[requested]?.focus();
    }
    if (event.key === "Escape") {
      const disclosure = event.currentTarget.closest("details");
      if (disclosure === null) return;
      disclosure.open = false;
      disclosure.querySelector("summary")?.focus();
    }
  };
  return (
    <details className="ink-overlay-anchor">
      <summary className="ink-button">{label}</summary>
      <div
        className="ink-overlay ink-menu"
        role="menu"
        aria-label={label}
        onKeyDown={navigate}
      >
        {actions.map((action) => (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            disabled={action.interaction === "disabled"}
            onClick={() => onAction(action.id)}
          >
            {action.label}
          </button>
        ))}
      </div>
    </details>
  );
}

export interface PopoverProps {
  readonly label: string;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
}

export function Popover({ label, trigger, children }: PopoverProps) {
  return (
    <details className="ink-overlay-anchor">
      <summary className="ink-button">{trigger}</summary>
      <section className="ink-overlay ink-popover" aria-label={label}>
        {children}
      </section>
    </details>
  );
}

export interface DialogProps {
  readonly title: string;
  readonly visibility: "open" | "closed";
  readonly onDismiss: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export function Dialog({
  title,
  visibility,
  onDismiss,
  children,
  footer,
}: DialogProps) {
  const title_id = useId();
  const dialog_reference = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialog_reference.current;
    if (dialog === null) return;
    if (visibility === "open" && !dialog.open) dialog.showModal();
    if (visibility === "closed" && dialog.open) dialog.close();
  }, [visibility]);
  return (
    <dialog
      ref={dialog_reference}
      className="ink-dialog"
      aria-labelledby={title_id}
      aria-modal="true"
      onClose={onDismiss}
      onCancel={onDismiss}
    >
      <header>
        <h2 id={title_id}>{title}</h2>
        <IconButton
          label="Close dialog"
          icon="×"
          tone="ghost"
          onPress={onDismiss}
        />
      </header>
      <div className="ink-dialog-body">{children}</div>
      {footer && <footer>{footer}</footer>}
    </dialog>
  );
}

function described_by(
  id: string,
  description: string | undefined,
  error: string | undefined,
): string | undefined {
  const references = [
    description === undefined ? undefined : `${id}-hint`,
    error === undefined ? undefined : `${id}-error`,
  ].filter((reference): reference is string => reference !== undefined);
  return references.length === 0 ? undefined : references.join(" ");
}

function classes(...values: readonly (string | undefined)[]): string {
  return values.filter((value): value is string => value !== undefined).join(
    " ",
  );
}

export type EditorStyle =
  & CSSProperties
  & Record<`--ink-${string}`, string | number>;
