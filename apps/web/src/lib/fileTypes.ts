import { getIconForFile, getIconForFolder, getIconForOpenFolder, DEFAULT_FILE, DEFAULT_FOLDER } from "vscode-icons-js";

// vscode-icons-js only resolves filenames to the icon *name* used by the
// vscode-icons extension; it doesn't ship the actual SVGs. Serve them from
// the extension's own repo, pinned to a released tag.
const ICON_CDN_BASE = "https://cdn.jsdelivr.net/gh/vscode-icons/vscode-icons@12.19.0/icons/";

export function fileNameOf(path: string): string {
  return path.split("/").pop() ?? path;
}

export function iconUrlFor(path: string): string {
  const icon = getIconForFile(fileNameOf(path)) || DEFAULT_FILE;
  return `${ICON_CDN_BASE}${icon}`;
}

export const DEFAULT_ICON_URL = `${ICON_CDN_BASE}${DEFAULT_FILE}`;

export function folderIconUrlFor(name: string, open: boolean): string {
  const icon = (open ? getIconForOpenFolder(name) : getIconForFolder(name)) || DEFAULT_FOLDER;
  return `${ICON_CDN_BASE}${icon}`;
}

export const DEFAULT_FOLDER_ICON_URL = `${ICON_CDN_BASE}${DEFAULT_FOLDER}`;
