// Generic "nothing here yet" placeholder used across the feed/articles/shared
// views. Icon + title + optional description + optional action button, all
// centered in the available space. Purely presentational — callers decide
// when to render it (empty list, initial load, etc).
import type { ComponentChildren, ComponentType, JSX } from "preact";

export function EmptyState(props: {
  icon: ComponentType<{ size?: number | string }>;
  title: string;
  description?: string;
  action?: ComponentChildren;
}): JSX.Element {
  const Icon = props.icon;
  return (
    <div class="empty-state">
      <div class="empty-state-icon">
        <Icon size={28} />
      </div>
      <p class="empty-state-title">{props.title}</p>
      {props.description ? <p class="empty-state-description">{props.description}</p> : null}
      {props.action ? <div class="empty-state-action">{props.action}</div> : null}
    </div>
  );
}
