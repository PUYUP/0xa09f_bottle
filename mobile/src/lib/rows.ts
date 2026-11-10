import type { ThreadNode } from "@shared/store";

export interface Row {
  node: ThreadNode;
  depth: number;
}

export function flatten(node: ThreadNode, depth: number, out: Row[]) {
  out.push({ node, depth });
  for (const c of node.children) flatten(c, depth + 1, out);
}
