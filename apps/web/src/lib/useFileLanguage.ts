import { useEffect, useState } from "react";
import { useMonaco } from "@monaco-editor/react";
import { fileNameOf } from "./fileTypes";

/**
 * Monaco already ships a registry of every language it supports, each
 * declaring its own filenames/extensions (monaco.languages.getLanguages()).
 * We look a path up in that registry instead of hand-maintaining our own
 * extension-to-language table.
 */
export function useFileLanguage(path: string | null): string {
  const monaco = useMonaco();
  const [language, setLanguage] = useState("plaintext");

  useEffect(() => {
    if (!path || !monaco) {
      setLanguage("plaintext");
      return;
    }
    const name = fileNameOf(path).toLowerCase();
    const dotExt = name.includes(".") ? `.${name.split(".").pop()}` : "";
    const match = monaco.languages
      .getLanguages()
      .find(
        (lang) =>
          lang.filenames?.some((f) => f.toLowerCase() === name) ||
          lang.extensions?.some((e) => e.toLowerCase() === dotExt)
      );
    setLanguage(match?.id ?? "plaintext");
  }, [path, monaco]);

  return language;
}
