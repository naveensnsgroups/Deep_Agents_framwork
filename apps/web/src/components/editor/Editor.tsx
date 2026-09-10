import MonacoEditor from "@monaco-editor/react";
import { fileNameOf, iconUrlFor, DEFAULT_ICON_URL } from "../../lib/fileTypes";
import { useFileLanguage } from "../../lib/useFileLanguage";

interface Props {
  path: string | null;
  content: string;
  onClose: () => void;
}

export function Editor({ path, content, onClose }: Props) {
  const language = useFileLanguage(path);

  if (!path) {
    return <div className="p-5 text-neutral-500">Select a file to view its contents.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none border-b border-neutral-800 bg-neutral-900">
        <div className="flex items-center gap-1.5 border-r border-neutral-800 bg-neutral-800/60 px-2.5 py-1.5 text-xs text-neutral-200">
          <img className="h-3.5 w-3.5" src={iconUrlFor(path)} onError={(e) => (e.currentTarget.src = DEFAULT_ICON_URL)} alt="" />
          <span>{fileNameOf(path)}</span>
          <button
            onClick={onClose}
            title="Close file"
            className="cursor-pointer border-none bg-transparent pl-1 text-sm leading-none text-neutral-500 hover:text-white"
          >
            ×
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <MonacoEditor
          height="100%"
          theme="vs-dark"
          path={path}
          language={language}
          value={content}
          options={{ readOnly: true, minimap: { enabled: false }, fontSize: 13, automaticLayout: true }}
        />
      </div>
    </div>
  );
}
