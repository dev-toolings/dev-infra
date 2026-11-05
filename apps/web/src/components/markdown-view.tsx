import * as React from "react";
import Markdown from "react-markdown";

import { CodeBlock } from "./code-block";

/** Data for tools: rendered, it would read as a rule and a heading. */
const FRONT_MATTER = /^---\n[\s\S]*?\n---\n/;

/** A fenced block arrives as `<pre><code>`: it gets the same colors as a file. */
function Fence({ children }: { children?: React.ReactNode }) {
  const { className = "", children: code } = (children as React.ReactElement<{ className?: string; children: string }>).props;
  return <CodeBlock language={className.replace("language-", "") || "text"} className="rounded-lg bg-muted p-3">{code.trimEnd()}</CodeBlock>;
}

/** Raw HTML stays text: react-markdown does not render it. Spacing comes from `markdown-view` in styles.css. */
export function MarkdownView({ children }: { children: string }) {
  return (
    <div className="markdown-view scrollbar-soft h-full min-h-80 overflow-auto p-4 text-sm leading-relaxed md:px-5">
      <Markdown components={{ pre: Fence }}>{children.replace(FRONT_MATTER, "")}</Markdown>
    </div>
  );
}
