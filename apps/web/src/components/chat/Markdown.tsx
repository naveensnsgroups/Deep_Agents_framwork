import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, CopyCheck } from "lucide-react";
import { copyText } from "../../lib/browser";

interface Props {
  content: string;
}

/** react-markdown hands `pre` its rendered `<code>` element as `children`, not the raw
 * text — walk it back down to a plain string so the copy button has something to copy. */
function nodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = nodeText(children);

  function copy() {
    copyText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="group/code relative mb-2 last:mb-0">
      <pre className="max-w-full overflow-x-auto rounded-md bg-neutral-950 p-2.5">{children}</pre>
      <button
        onClick={copy}
        title="Copy code"
        className="absolute right-1.5 top-1.5 cursor-pointer rounded bg-neutral-800/80 p-1 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-200 group-hover/code:opacity-100"
      >
        {copied ? <CopyCheck className="h-3.5 w-3.5 text-green-400" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

/** Shared prose styling for agent chat messages, since Tailwind utility classes don't cascade into react-markdown's generated elements. */
export function Markdown({ content }: Props) {
  return (
    <div className="max-w-none text-[13px] leading-relaxed text-neutral-100">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-bold first:mt-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-[15px] font-bold first:mt-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-sm font-bold first:mt-0">{children}</h3>,
          ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-0.5">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
          em: ({ children }) => <em className="italic">{children}</em>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer" className="break-words text-blue-400 underline hover:text-blue-300">
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="mb-2 border-l-2 border-neutral-600 pl-2.5 text-neutral-400 last:mb-0">{children}</blockquote>
          ),
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? "");
            if (isBlock) {
              return <code className={`font-mono text-xs ${className ?? ""}`}>{children}</code>;
            }
            return <code className="break-words rounded bg-neutral-700/60 px-1 py-0.5 font-mono text-[12px] text-amber-200">{children}</code>;
          },
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="mb-2 overflow-x-auto last:mb-0">
              <table className="border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => <th className="border border-neutral-700 px-2 py-1 text-left font-semibold">{children}</th>,
          td: ({ children }) => <td className="border border-neutral-700 px-2 py-1">{children}</td>,
          hr: () => <hr className="my-2 border-neutral-700" />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
