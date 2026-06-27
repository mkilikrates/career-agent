// Shared component library (@ui/design-system) — task 29.1, 29.3 (R58.1, R58.4, R58.10).
//
// Every interactive/display element type is rendered by ONE component here, so
// it is styled identically on every phase screen (R58.1) and carries the baked-in
// accessibility guarantees (R58.4, R58.10):
//   - native, keyboard-operable controls in logical source order;
//   - a screen-reader text label for every interactive control (an associated
//     <label> or an explicit aria-label);
//   - the visible :focus-visible indicator from global.css;
//   - token colour pairings that meet ≥4.5:1 contrast.
//
// Screens compose these instead of raw <button>/<input>/<select>/<textarea> and
// never hardcode typography, colour, or spacing.

import {
  useId,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { tokens } from './tokens';

/** Visual variants of the shared button, each a distinct token style. */
export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
}

const buttonStyleFor = (variant: ButtonVariant): CSSProperties => {
  switch (variant) {
    case 'secondary':
      return tokens.component.buttonSecondary;
    case 'danger':
      return tokens.component.buttonDanger;
    default:
      return tokens.component.button;
  }
};

/**
 * The single button element type (R58.1). Defaults to `type="button"` so it
 * never submits a form by accident, is keyboard-operable as a native control,
 * and shows the shared focus ring (R58.10). Callers supply an accessible label
 * via `children` (visible text) or `aria-label`.
 */
export function Button({
  variant = 'primary',
  type,
  style,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const base = buttonStyleFor(variant);
  return (
    <button
      type={type ?? 'button'}
      className={['ca-button', className].filter(Boolean).join(' ')}
      data-variant={variant}
      disabled={disabled}
      style={disabled ? { ...base, opacity: 0.6, cursor: 'not-allowed', ...style } : { ...base, ...style }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Shared field label, associated to its control for screen readers (R58.4). */
function FieldLabel({
  htmlFor,
  hidden,
  children,
}: {
  readonly htmlFor: string;
  readonly hidden?: boolean;
  readonly children: ReactNode;
}) {
  if (hidden) {
    // Still associated to the control (announced to screen readers) but visually
    // hidden, for inline controls whose purpose is clear from surrounding text.
    return (
      <label htmlFor={htmlFor} className="ca-visually-hidden">
        {children}
      </label>
    );
  }
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        fontFamily: tokens.typography.fontFamily.base,
        fontSize: tokens.typography.scale.sm,
        fontWeight: tokens.typography.weight.medium,
        color: tokens.colour.text,
        marginBottom: tokens.spacing.xs,
      }}
    >
      {children}
    </label>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  /** Visible label text. Always associated to the input for screen readers (R58.4). */
  readonly label: ReactNode;
  /** Render the label visually hidden (still announced) for inline controls. */
  readonly hideLabel?: boolean;
  /** Optional explicit id; one is generated when omitted. */
  readonly id?: string;
  /** Style for the wrapping field container. */
  readonly fieldStyle?: CSSProperties;
}

/**
 * The single text-input element type (R58.1) with an always-associated label so
 * it is announced to screen readers (R58.4). Constrains width so it never causes
 * horizontal overflow on mobile (R58.9).
 */
export function TextField({ label, hideLabel, id, style, fieldStyle, ...rest }: TextFieldProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="ca-field" style={fieldStyle}>
      <FieldLabel htmlFor={inputId} hidden={hideLabel}>
        {label}
      </FieldLabel>
      <input
        id={inputId}
        className="ca-input"
        style={{ width: '100%', ...tokens.component.input, ...style }}
        {...rest}
      />
    </div>
  );
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> {
  readonly label: ReactNode;
  readonly hideLabel?: boolean;
  readonly id?: string;
  readonly fieldStyle?: CSSProperties;
}

/** The single multi-line text element type (R58.1) with an associated label. */
export function TextArea({ label, hideLabel, id, style, fieldStyle, ...rest }: TextAreaProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="ca-field" style={fieldStyle}>
      <FieldLabel htmlFor={inputId} hidden={hideLabel}>
        {label}
      </FieldLabel>
      <textarea
        id={inputId}
        className="ca-textarea"
        style={{ width: '100%', ...tokens.component.input, ...style }}
        {...rest}
      />
    </div>
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'id'> {
  readonly label: ReactNode;
  readonly hideLabel?: boolean;
  readonly id?: string;
  readonly children: ReactNode;
  readonly fieldStyle?: CSSProperties;
}

/** The single dropdown element type (R58.1) with an associated label (R58.4). */
export function Select({ label, hideLabel, id, style, fieldStyle, children, ...rest }: SelectProps) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="ca-field" style={hideLabel ? { display: 'inline-block', ...fieldStyle } : fieldStyle}>
      <FieldLabel htmlFor={inputId} hidden={hideLabel}>
        {label}
      </FieldLabel>
      <select id={inputId} className="ca-select" style={{ ...tokens.component.input, ...style }} {...rest}>
        {children}
      </select>
    </div>
  );
}

export interface CardProps {
  readonly children: ReactNode;
  readonly style?: CSSProperties;
  readonly 'aria-label'?: string;
  readonly 'data-testid'?: string;
}

/** The single surface/card element type (R58.1). */
export function Card({ children, style, ...rest }: CardProps) {
  return (
    <div className="ca-card" style={{ ...tokens.component.card, ...style }} {...rest}>
      {children}
    </div>
  );
}

export interface BadgeProps {
  readonly children: ReactNode;
  readonly style?: CSSProperties;
}

/** The single inline badge element type (R58.1). */
export function Badge({ children, style }: BadgeProps) {
  return (
    <span className="ca-badge" style={{ ...tokens.component.badge, ...style }}>
      {children}
    </span>
  );
}

/** The tone of a banner; danger uses the danger token pairing. */
export type BannerTone = 'info' | 'danger';

export interface BannerProps {
  readonly children: ReactNode;
  readonly tone?: BannerTone;
  /** ARIA live behaviour for status/error banners (R58.7, R58.8). */
  readonly role?: 'status' | 'alert';
  readonly style?: CSSProperties;
  readonly 'data-testid'?: string;
}

/** The single banner element type (R58.1), used for status/error surfaces. */
export function Banner({ children, tone = 'info', role, style, ...rest }: BannerProps) {
  const toneStyle: CSSProperties =
    tone === 'danger'
      ? { borderColor: tokens.colour.danger, color: tokens.colour.danger, background: tokens.colour.bg }
      : {};
  return (
    <div
      className="ca-banner"
      data-tone={tone}
      role={role}
      aria-live={role === 'alert' ? 'assertive' : role === 'status' ? 'polite' : undefined}
      style={{ ...tokens.component.banner, ...toneStyle, ...style }}
      {...rest}
    >
      {children}
    </div>
  );
}
