import {
  FileText,
  FilePlus,
  Pencil,
  Trash2,
  Folder,
  Search,
  FileSearch,
  Terminal,
  Bot,
  Wrench,
  ListTodo,
  ClipboardCheck,
  MessageCircleQuestion,
  type LucideIcon,
} from "lucide-react";

const TOOL_ICON_COMPONENTS: Record<string, LucideIcon> = {
  read_file: FileText,
  write_file: FilePlus,
  edit_file: Pencil,
  delete: Trash2,
  ls: Folder,
  glob: FileSearch,
  grep: Search,
  execute: Terminal,
  task: Bot,
  write_todos: ListTodo,
  record_migration: ClipboardCheck,
  ask_user: MessageCircleQuestion,
};

export function ToolIcon({ name, className }: { name: string; className?: string }) {
  const Icon = TOOL_ICON_COMPONENTS[name] ?? Wrench;
  return <Icon className={className ?? "h-3.5 w-3.5"} />;
}
