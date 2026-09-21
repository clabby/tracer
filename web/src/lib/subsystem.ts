import type { SpanNode } from './model'

/** Ownership must be explicit; never infer it from an event or a parent span. */
export function spanSubsystem(span: Pick<SpanNode, 'name' | 'attributes'>): string | null {
  for (const key of ['subsystem', 'code.namespace', 'code.namespace.name', 'target']) {
    const value = span.attributes[key]
    if (typeof value === 'string') {
      const path = normalize(value)
      if (path !== '') return path
    }
  }
  // A qualified span name is useful without metadata; a bare operation name isn't.
  return span.name.includes('::') ? normalize(span.name) || null : null
}

function normalize(value: string): string {
  const [root, ...modules] = value.trim().split(/::|[./]/).map((part) => part.trim()).filter(Boolean)
  // Crate/package naming convention, not a vendor lookup. Only the root is
  // split: acme_storage::read_block groups under acme, preserving read_block.
  return root === undefined ? '' : [...root.split(/[_-]/).filter(Boolean), ...modules].join('::')
}

/**
 * Color a prefix tree of normalized target paths, including implicit ancestors.
 * Roots are evenly spaced around the hue circle. Each owns a band no wider than
 * a third of the root spacing (and capped by the theme's spread). At a fork,
 * divide the band's width equally among the immediate children; give each child
 * the center third of its slot. This leaves gaps between sibling subtrees and
 * bounds all descendants inside their ancestor's band. Leaf counts/frequencies
 * never weight the allocation. Unary chains keep their hue and band: nesting
 * without a choice doesn't consume the color budget.
 *
 * Sorting makes the result independent of span order. Build from the WHOLE
 * trace so filtering never recolors it. A different tree can change the palette;
 * very wide/deep trees necessarily approach visually indistinguishable shades.
 * Iterative traversal avoids a call-stack limit on target depth.
 */
export function subsystemPalette(
  paths: Iterable<string>,
  startHue: number,
  spread: number,
): Map<string, number> {
  const children = new Map<string, Set<string>>([['', new Set()]])
  for (const path of new Set(paths)) {
    let parent = ''
    for (const part of path.split('::').filter(Boolean)) {
      const node = parent === '' ? part : `${parent}::${part}`
      children.get(parent)!.add(node)
      if (!children.has(node)) children.set(node, new Set())
      parent = node
    }
  }
  const roots = [...children.get('')!].sort()
  const spacing = 360 / Math.max(roots.length, 1)
  const pending = roots.map((path, index) => ({
    path,
    hue: startHue - index * spacing,
    width: Math.min(spread, spacing / 3),
  })).reverse()
  const palette = new Map<string, number>()
  // Depth-first order also serves the legend; plain string sorting can put a
  // sibling such as a-leaf between a and its descendants a::child.
  while (pending.length > 0) {
    const { path, hue, width } = pending.pop()!
    palette.set(path, (hue % 360 + 360) % 360)
    const branches = [...children.get(path)!].sort()
    const slot = width / Math.max(branches.length, 1)
    for (let index = branches.length - 1; index >= 0; index--) {
      pending.push({
        path: branches[index],
        hue: branches.length === 1 ? hue : hue - width / 2 + slot * (index + 0.5),
        width: branches.length === 1 ? width : slot / 3,
      })
    }
  }
  return palette
}
