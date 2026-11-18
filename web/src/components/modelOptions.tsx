import type { ReactNode } from "react";
import { groupByUpstream } from "../lib/modelCatalog";
import { piFlag, sameModelFlag, type ModelChoice, type Provider } from "../lib/agentProviders";

/** The `<option>`s of a model `<select>`: a Pi model sits under its upstream
 *  (who bills it: Claude through the API, the ChatGPT login), since the same
 *  name means a different bill under each. A model already chosen that the
 *  list does not carry stays selectable, so opening a form never rewrites it. */
export function modelOptions(
  provider: Provider,
  current: string,
  models: readonly ModelChoice[],
  empty = "",
): ReactNode {
  const missing = current !== "" && !models.some((m) => sameModelFlag(provider, m.flag, current));
  const kept = missing ? <option value={current}>{current}</option> : null;
  const none = !current && empty ? <option value="">{empty}</option> : null;
  const option = (m: ModelChoice) => <option key={m.id} value={m.flag}>{m.model}</option>;
  if (provider !== "pi") return <>{none}{kept}{models.map(option)}</>;
  return (
    <>
      {none}
      {kept}
      {groupByUpstream(models).map((group) => (
        <optgroup key={group.upstream} label={group.heading}>{group.models.map(option)}</optgroup>
      ))}
    </>
  );
}

/** A select's value for a Pi model: a bare saved id meets its named form. */
export function selectedModel(provider: Provider, current: string, models: readonly ModelChoice[]): string {
  if (provider !== "pi") return current;
  return models.find((m) => piFlag(m.flag) === piFlag(current))?.flag ?? current;
}
