import { useEffect, useRef } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor, IDisposable } from "monaco-editor";

interface Props {
  original: string;
  modified: string;
  language: string;
  onChange: (modified: string) => void;
}

/**
 * A real code diff view for editing a pending write_file/edit_file action before approving
 * it — replaces a raw JSON textarea with syntax highlighting and inline diff coloring, and
 * lets you fix just the changed lines instead of retyping the whole args object.
 */
export function DiffMergeEditor({ original, modified, language, onChange }: Props) {
  // Approving immediately unmounts this component (the parent card collapses to its
  // resolved view in the same render), which can race Monaco's own diff-widget teardown
  // and throw "TextModel got disposed before DiffEditorWidget model got reset" — a known
  // upstream quirk, harmless (the approved content is already captured via onChange by
  // then) but worth not compounding: dispose our own listener first so nothing on our side
  // touches the model after Monaco starts tearing it down.
  const listenerRef = useRef<IDisposable | null>(null);

  function handleMount(editorInstance: editor.IStandaloneDiffEditor) {
    const modifiedEditor = editorInstance.getModifiedEditor();
    listenerRef.current = modifiedEditor.onDidChangeModelContent(() => {
      onChange(modifiedEditor.getValue());
    });
  }

  useEffect(() => () => listenerRef.current?.dispose(), []);

  return (
    <div className="h-56 overflow-hidden rounded border border-amber-800">
      <DiffEditor
        height="100%"
        theme="vs-dark"
        language={language}
        original={original}
        modified={modified}
        onMount={handleMount}
        options={{
          renderSideBySide: false,
          originalEditable: false,
          minimap: { enabled: false },
          fontSize: 12,
          scrollBeyondLastLine: false,
          automaticLayout: true,
        }}
      />
    </div>
  );
}
