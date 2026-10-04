import type { ReactNode } from "react";
import { parseMarkdown, type Block, type Inline } from "@/lib/markdown";

/** Renders model output as React elements (never as HTML), so record text can't inject markup. */
function renderInline(nodes: Inline[], key = "i"): ReactNode[] {
  return nodes.map((node, index) => {
    const k = `${key}-${index}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return <br key={k} />;
      case "code":
        return <code key={k}>{node.text}</code>;
      case "strong":
        return <strong key={k}>{renderInline(node.children, k)}</strong>;
      case "em":
        return <em key={k}>{renderInline(node.children, k)}</em>;
      case "link":
        return (
          <a key={k} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children, k)}
          </a>
        );
    }
  });
}

function renderBlock(block: Block, index: number): ReactNode {
  const k = `b-${index}`;
  switch (block.type) {
    case "heading": {
      const children = renderInline(block.children, k);
      if (block.level <= 2) return <h3 key={k}>{children}</h3>;
      return block.level === 3 ? <h4 key={k}>{children}</h4> : <h5 key={k}>{children}</h5>;
    }
    case "paragraph":
      return <p key={k}>{renderInline(block.children, k)}</p>;
    case "code":
      return (
        <pre key={k}>
          <code>{block.text}</code>
        </pre>
      );
    case "list": {
      const items = block.items.map((item, i) => <li key={`${k}-${i}`}>{renderInline(item, `${k}-${i}`)}</li>);
      return block.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>;
    }
    case "table":
      return (
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>
                {block.header.map((cell, i) => (
                  <th key={i}>{renderInline(cell, `${k}-h${i}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>{renderInline(cell, `${k}-${r}-${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

export default function Markdown({ text }: { text: string }) {
  return <div className="md">{parseMarkdown(text).map(renderBlock)}</div>;
}
