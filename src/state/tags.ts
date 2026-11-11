// Tags and color labels: the tag list and a version that bumps on every change,
// so lists showing tags reload them.
import { createResource, createRoot, createSignal } from "solid-js";
import { allTags, setTag as setTagIpc } from "../lib/ipc";

export const tags = createRoot(() => {
  const [version, setVersion] = createSignal(0);
  const [all] = createResource(version, () => allTags().catch(() => [] as [string, number][]));
  return {
    version,
    /** Every tag with its item count. */
    all: () => all() ?? [],
    async set(paths: readonly string[], tag: string, on: boolean) {
      await setTagIpc([...paths], tag, on);
      setVersion((v) => v + 1);
    },
    refresh: () => setVersion((v) => v + 1),
  };
});
