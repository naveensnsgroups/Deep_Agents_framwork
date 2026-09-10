import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { Todo } from "@deepagents-ide/shared";

interface Props {
  todos: Todo[];
}

const STATUS_ICON: Record<string, typeof Circle> = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
};

const STATUS_ICON_CLASS: Record<string, string> = {
  completed: "text-green-400",
  in_progress: "text-blue-300 animate-spin",
  pending: "text-neutral-500",
};

const STATUS_TEXT_CLASS: Record<string, string> = {
  completed: "text-neutral-500 line-through",
  in_progress: "text-blue-200",
  pending: "text-neutral-300",
};

export function TodoPanel({ todos }: Props) {
  if (todos.length === 0) return null;
  const completed = todos.filter((t) => t.status === "completed").length;

  return (
    <div className="flex-none border-b border-neutral-800 px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-neutral-500">Plan</span>
        <span className="text-[11px] text-neutral-600">
          {completed}/{todos.length}
        </span>
      </div>
      {todos.map((todo, i) => {
        const Icon = STATUS_ICON[todo.status] ?? Circle;
        return (
          <div key={i} className={`flex items-start gap-1.5 py-0.5 text-xs ${STATUS_TEXT_CLASS[todo.status] ?? "text-neutral-300"}`}>
            <Icon className={`mt-0.5 h-3 w-3 flex-none ${STATUS_ICON_CLASS[todo.status] ?? "text-neutral-500"}`} />
            <span className="min-w-0 flex-1 break-words">{todo.content}</span>
          </div>
        );
      })}
    </div>
  );
}
