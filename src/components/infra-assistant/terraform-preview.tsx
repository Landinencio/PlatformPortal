"use client";

import { FileCode2, DollarSign, Pencil, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { TerraformPreview } from "@/lib/infra-agent";

// ─── Props ────────────────────────────────────────────────────────────────────

interface TerraformPreviewProps {
  preview: TerraformPreview;
  onApprove: () => void;
  onEdit: () => void;
  readOnly?: boolean;
}

// ─── HCL syntax token colours (no external deps) ─────────────────────────────

function tokeniseHcl(line: string): React.ReactNode {
  // Keyword: resource, module, variable, output, locals, provider, terraform
  const keywordRe = /\b(resource|module|variable|output|locals|provider|terraform|count|source|for_each)\b/g;
  // String literals
  const stringRe = /"[^"]*"/g;
  // Comments
  if (/^\s*#/.test(line)) {
    return <span className="text-slate-500 italic">{line}</span>;
  }
  // Attribute keys (word before =)
  const attrRe = /^(\s*)(\w+)(\s*=)/;

  // Build coloured spans by splitting on tokens
  const parts: React.ReactNode[] = [];
  let remaining = line;
  let key = 0;

  // Highlight attribute key at start of line
  const attrMatch = attrRe.exec(remaining);
  if (attrMatch) {
    parts.push(<span key={key++}>{attrMatch[1]}</span>);
    parts.push(<span key={key++} className="text-sky-300">{attrMatch[2]}</span>);
    remaining = remaining.slice(attrMatch[1].length + attrMatch[2].length);
  }

  // Tokenise the rest: strings, keywords, rest
  const tokenRe = /"[^"]*"|\b(resource|module|variable|output|locals|provider|terraform|count|source|for_each)\b/g;
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(remaining)) !== null) {
    if (m.index > lastIndex) {
      parts.push(<span key={key++}>{remaining.slice(lastIndex, m.index)}</span>);
    }
    if (m[0].startsWith('"')) {
      parts.push(<span key={key++} className="text-amber-300">{m[0]}</span>);
    } else {
      parts.push(<span key={key++} className="text-purple-400 font-semibold">{m[0]}</span>);
    }
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex < remaining.length) {
    parts.push(<span key={key++}>{remaining.slice(lastIndex)}</span>);
  }

  return <>{parts}</>;
}

// ─── HclBlock ─────────────────────────────────────────────────────────────────

function HclBlock({ content }: { content: string }) {
  const lines = content.split("\n");
  return (
    <pre className="overflow-x-auto rounded-md bg-[#0d1117] p-4 text-xs leading-5 font-mono text-slate-200 max-h-[420px]">
      <code>
        {lines.map((line, i) => (
          <div key={i}>{tokeniseHcl(line) || "\u00a0"}</div>
        ))}
      </code>
    </pre>
  );
}

// ─── TerraformPreview ─────────────────────────────────────────────────────────

export function TerraformPreviewPanel({
  preview,
  onApprove,
  onEdit,
  readOnly = false,
}: TerraformPreviewProps) {
  const { filePath, resourceType, resourceName, targetEnvironments, estimatedCostMonthly, content } = preview;

  return (
    <Card className="flex flex-col h-full overflow-hidden">
      <CardHeader className="pb-3 space-y-2 shrink-0">
        {/* File path badge */}
        <div className="flex items-center gap-2 flex-wrap">
          <FileCode2 className="w-4 h-4 text-muted-foreground shrink-0" />
          <Badge variant="secondary" className="font-mono text-xs truncate max-w-full">
            {filePath}
          </Badge>
        </div>

        {/* Resource type / name */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">
            {resourceType}
            <span className="text-muted-foreground"> / </span>
            {resourceName}
          </span>
        </div>

        {/* Environments + cost */}
        <div className="flex items-center gap-2 flex-wrap">
          {targetEnvironments.map((env) => (
            <Badge key={env} variant="outline" className="text-xs capitalize">
              {env}
            </Badge>
          ))}
          {estimatedCostMonthly !== null && (
            <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-300 gap-1">
              <DollarSign className="w-3 h-3" />
              {estimatedCostMonthly.toFixed(2)}/mo
            </Badge>
          )}
        </div>
      </CardHeader>

      {/* HCL content */}
      <CardContent className="flex-1 overflow-hidden p-0 px-4 pb-4">
        <HclBlock content={content} />
      </CardContent>

      {/* Action buttons */}
      {!readOnly && (
        <div className="flex gap-2 px-4 pb-4 shrink-0 border-t border-border pt-3">
          <Button
            size="sm"
            className="flex-1 gap-1.5"
            onClick={onApprove}
          >
            <CheckCircle2 className="w-4 h-4" />
            Submit for approval
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1 gap-1.5"
            onClick={onEdit}
          >
            <Pencil className="w-4 h-4" />
            Ask to change...
          </Button>
        </div>
      )}
    </Card>
  );
}
