import { ChevronRight, File, FileCode, FileCog, FileJson, FileText, Folder, type LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";

type Node = { name: string; path: string; children: Node[] };

/** Same colors as the code panel: the type of a file reads at a glance. */
function fileStyle(name: string): { icon: LucideIcon; tone: string } {
  if (/\.(?:ts|tsx|js|jsx|php|py)$/.test(name)) return { icon: FileCode, tone: "text-status-info" };
  if (/\.(?:json|lock)$/.test(name)) return { icon: FileJson, tone: "text-status-degraded" };
  if (/\.(?:toml|ya?ml)$|^(?:Dockerfile|artisan)$/.test(name)) return { icon: FileCog, tone: "text-status-up" };
  if (name.startsWith(".")) return { icon: FileCog, tone: "text-muted-foreground" };
  if (/\.(?:md|txt)$/.test(name)) return { icon: FileText, tone: "text-muted-foreground" };
  return { icon: File, tone: "text-muted-foreground" };
}

function build(files: string[]): Node[] {
  const root: Node[] = [];
  for (const file of files) {
    let level = root, path = "";
    for (const name of file.split("/")) {
      path = path ? `${path}/${name}` : name;
      let node = level.find((item) => item.name === name);
      if (!node) { node = { name, path, children: [] }; level.push(node); }
      level = node.children;
    }
  }
  return root;
}

type Selection = { selected?: string; onSelect: (path: string) => void };

function Leaf({ node, selected, onSelect }: { node: Node } & Selection) {
  const { icon: Icon, tone } = fileStyle(node.name);
  return (
    <button
      type="button"
      aria-current={selected === node.path ? "true" : undefined}
      onClick={() => onSelect(node.path)}
      className="flex w-full min-w-0 items-center gap-1.5 rounded-sm py-0.5 pl-[18px] text-left hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-muted"
    >
      <Icon aria-hidden="true" className={cn("size-3.5 shrink-0", tone)} />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

/** Folders first, as in a file explorer. */
function Branch({ nodes, selected, onSelect }: { nodes: Node[] } & Selection) {
  const sorted = [...nodes].sort((a, b) => Number(b.children.length > 0) - Number(a.children.length > 0) || a.name.localeCompare(b.name));
  return (
    <ul className="space-y-0.5">
      {sorted.map((node) => (
        <li key={node.path}>
          {node.children.length > 0 ? (
            <details>
              <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm py-0.5 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground transition-transform [details[open]>summary>&]:rotate-90" />
                <Folder aria-hidden="true" className="size-3.5 shrink-0 fill-current text-status-degraded" />
                {node.name}
              </summary>
              <div className="ml-1.5 border-l pl-3"><Branch nodes={node.children} selected={selected} onSelect={onSelect} /></div>
            </details>
          ) : <Leaf node={node} selected={selected} onSelect={onSelect} />}
        </li>
      ))}
    </ul>
  );
}

export function FileTree({ files, selected, onSelect }: { files: string[] } & Selection) {
  return <div className="font-mono text-xs"><Branch nodes={build(files)} selected={selected} onSelect={onSelect} /></div>;
}
