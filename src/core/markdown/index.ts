// @core/markdown — Markdown-as-database serialization & stable-ID anchors.
//
// The Memory Store persists everything as human-readable Markdown with stable
// identifiers embedded as HTML anchor comments and mirrored in frontmatter
// (R34.1, R34.2). Consumers import from this single stable path:
//
//   import { parseMarkdown, serializeMarkdown, renderPrintable } from '@core/markdown';

export {
  ANCHOR_KEY,
  ID_TOKEN,
  isIdToken,
  anchorComment,
  anchorPattern,
  parseAnchorIds,
  hasAnchor,
  stripAnchorsFromText,
} from './anchor';

export {
  parseMarkdown,
  serializeMarkdown,
  renderPrintable,
  extractIds,
} from './markdown-document';

export type { MarkdownDocument } from './markdown-document';
