// Checkbox element adapted from CafeTako Site Builder (data-ui="checkbox").
import { createEffect, type JSX } from "solid-js";

export interface CheckboxProps {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  class?: string;
  children?: JSX.Element;
  onChange: (checked: boolean) => void;
}

export function Checkbox(props: CheckboxProps) {
  let inputEl!: HTMLInputElement;

  createEffect(() => {
    inputEl.indeterminate = !!props.indeterminate;
  });

  const control = () => (
    <>
      <input
        ref={inputEl}
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span data-ui-part="indicator" aria-hidden="true">
        <svg
          class="ui-icon"
          data-ui-part="icon"
          viewBox="0 0 24 24"
          width="24"
          height="24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d={props.indeterminate ? "M5 12h14" : "m4 12 5 5 11-11"} />
        </svg>
      </span>
    </>
  );

  // Avoid nesting <label> inside an outer <label> (e.g. .dupe-file, .sc-row).
  if (!props.children) {
    return (
      <span class={`ct-check${props.class ? ` ${props.class}` : ""}`} data-ui="checkbox">
        {control()}
      </span>
    );
  }

  return (
    <label class={`ct-check${props.class ? ` ${props.class}` : ""}`} data-ui="checkbox">
      {control()}
      {props.children}
    </label>
  );
}
