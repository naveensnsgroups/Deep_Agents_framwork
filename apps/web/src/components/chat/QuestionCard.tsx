import { useId, useState } from "react";
import { MessageCircleQuestion, SendHorizontal } from "lucide-react";

/** Matches the server's limit (apps/server/src/agent/askUser.ts), so the box can't send what it refuses. */
const MAX_ANSWER_CHARS = 4000;

interface Props {
  question: string;
  options: string[];
  /** Set once answered; the card then collapses to the question and the answer. */
  answer?: string;
  /** While the connection is down, an answer could not be sent. */
  disabled: boolean;
  onAnswer: (answer: string) => void;
}

/** The agent — or a subagent — called `ask_user` and its run is waiting on this. */
export function QuestionCard({ question, options, answer, disabled, onAnswer }: Props) {
  const [draft, setDraft] = useState("");
  const inputId = useId();

  if (answer !== undefined) {
    return (
      <div className="rounded-md border border-neutral-800 light:border-neutral-200 bg-neutral-900 light:bg-neutral-50 px-2.5 py-1.5 text-xs">
        <div className="flex items-start gap-1.5 text-neutral-400 light:text-neutral-600">
          <MessageCircleQuestion className="mt-px h-3.5 w-3.5 flex-none" />
          <span className="whitespace-pre-wrap">{question}</span>
        </div>
        <div className="mt-1 whitespace-pre-wrap pl-5 text-neutral-200 light:text-neutral-800">{answer}</div>
      </div>
    );
  }

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onAnswer(trimmed);
  }

  return (
    <div className="rounded-lg border border-sky-900 light:border-sky-300 bg-sky-950/40 light:bg-sky-50 p-2.5">
      <div className="mb-2 flex items-start gap-1.5 text-sky-100 light:text-sky-900">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 flex-none" />
        <span className="whitespace-pre-wrap">{question}</span>
      </div>

      {options.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {options.map((option) => (
            <button
              key={option}
              disabled={disabled}
              onClick={() => send(option)}
              className="cursor-pointer rounded-md border border-sky-800 light:border-sky-300 bg-transparent px-2.5 py-1 text-left text-xs text-sky-100 light:text-sky-900 hover:bg-sky-900/60 light:hover:bg-sky-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      )}

      <form
        className="flex items-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <label htmlFor={inputId} className="sr-only">
          Your answer
        </label>
        <textarea
          id={inputId}
          rows={1}
          maxLength={MAX_ANSWER_CHARS}
          value={draft}
          disabled={disabled}
          placeholder={options.length > 0 ? "Or type your own answer…" : "Type your answer…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
          className="min-h-[30px] flex-1 resize-y rounded border border-sky-800 light:border-sky-300 bg-neutral-950 light:bg-white p-1.5 text-xs text-neutral-100 light:text-neutral-900 outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          aria-label="Send answer"
          disabled={disabled || !draft.trim()}
          className="flex h-[30px] w-[30px] flex-none cursor-pointer items-center justify-center rounded-md border-none bg-sky-700 text-white hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
        </button>
      </form>
    </div>
  );
}
