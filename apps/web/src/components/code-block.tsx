import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";
import ignore from "react-syntax-highlighter/dist/esm/languages/prism/ignore";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import php from "react-syntax-highlighter/dist/esm/languages/prism/php";
import properties from "react-syntax-highlighter/dist/esm/languages/prism/properties";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import toml from "react-syntax-highlighter/dist/esm/languages/prism/toml";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";

import { cn } from "../lib/utils";

for (const [name, language] of Object.entries({ bash, docker, ignore, json, markdown, php, properties, python, toml, typescript, yaml })) SyntaxHighlighter.registerLanguage(name, language);

const EXTENSIONS: Record<string, string> = { json: "json", md: "markdown", php: "php", py: "python", toml: "toml", ts: "typescript", tsx: "typescript", yaml: "yaml", yml: "yaml" };

/** Files that a name identifies better than an extension. */
const NAMES: Record<string, string> = { ".dockerignore": "ignore", ".gitignore": "ignore", Dockerfile: "docker", artisan: "php" };

export function languageOf(file: string): string {
  const name = file.split("/").pop()!;
  if (name.startsWith(".env")) return "properties";
  return NAMES[name] ?? EXTENSIONS[name.split(".").pop()!] ?? "bash";
}

/** Colors come from `code-block` in styles.css, so they follow the theme. */
export function CodeBlock({ language, className = "scrollbar-soft h-full min-h-80 overflow-auto p-4 md:px-5", children }: { language: string; className?: string; children: string }) {
  return (
    <SyntaxHighlighter language={language} useInlineStyles={false} wrapLongLines className={cn("code-block font-mono text-xs leading-relaxed", className)}>
      {children}
    </SyntaxHighlighter>
  );
}
