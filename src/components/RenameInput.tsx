// The inline name editor every view uses when a file is being renamed.
import { onCleanup, onMount } from "solid-js";
import { stemLength } from "../lib/paths";

/** Edits a name in place: Enter or leaving the field keeps it, Escape cancels. The name without its extension starts selected. */
export function RenameInput(props: { name: string; isDir: boolean; onDone: (value: string | null, move?: 1 | -1) => void }) {
  let input!: HTMLInputElement;
  let finished = false;
  const finish = (v: string | null, move?: 1 | -1) => {
    if (finished) return;
    finished = true;
    props.onDone(v, move);
  };
  onMount(() => {
    input.focus();
    input.setSelectionRange(0, stemLength(props.name, props.isDir));
    // Empty areas start a selection box and cancel the mouse-down's default, so the field would never lose focus on its own.
    const outside = (e: MouseEvent) => {
      if (e.target !== input) finish(input.value);
    };
    document.addEventListener("mousedown", outside, true);
    onCleanup(() => document.removeEventListener("mousedown", outside, true));
  });
  return (
    <input
      ref={input}
      class="rename"
      aria-label="New name"
      value={props.name}
      spellcheck={false}
      onMouseDown={(e) => e.stopPropagation()}
      onDblClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(input.value);
        if (e.key === "Escape") finish(null);
        if (e.key === "Tab") {
          e.preventDefault();
          finish(input.value, e.shiftKey ? -1 : 1);
        }
      }}
      onBlur={() => finish(input.value)}
    />
  );
}
