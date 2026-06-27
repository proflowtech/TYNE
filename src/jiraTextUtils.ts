export interface JiraDocNode {
  type?: string;
  text?: string;
  content?: JiraDocNode[];
}

export interface JiraAcceptanceCriteriaParseResult {
  criteria: string[];
  sectionText: string | null;
}

export function jiraDocToPlainText(doc?: JiraDocNode): string {
  if (!doc) { return ''; }
  return normalizeSpacing(renderNode(doc)).trim();
}

export function extractAcceptanceCriteriaFromText(text?: string): JiraAcceptanceCriteriaParseResult {
  if (!text) { return { criteria: [], sectionText: null }; }

  const lines = text.split(/\r?\n/).map(line => line.replace(/\s+$/g, ''));
  let start = -1;
  let inlineRemainder = '';

  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^\s*(?:#{1,6}\s*)?(?:\*\*|__)?Acceptance Criteria(?:\*\*|__)?\s*:?\s*(.*)$/i);
    if (match) {
      start = i;
      inlineRemainder = (match[1] || '').trim();
      break;
    }
  }

  if (start < 0) {
    return { criteria: [], sectionText: null };
  }

  const sectionLines: string[] = [];
  if (inlineRemainder) {
    sectionLines.push(inlineRemainder);
  }

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (sectionLines.length > 0) { sectionLines.push(''); }
      continue;
    }
    if (looksLikeHeading(trimmed) && sectionLines.length > 0) {
      break;
    }
    sectionLines.push(trimmed);
  }

  const sectionText = sectionLines.join('\n').trim();
  if (!sectionText) {
    return { criteria: [], sectionText: null };
  }

  const criteria: string[] = [];
  let current = '';
  const pushCurrent = () => {
    const normalized = current.replace(/\s+/g, ' ').trim();
    if (normalized) { criteria.push(normalized); }
    current = '';
  };

  for (const rawLine of sectionLines) {
    const line = rawLine.trim();
    if (!line) {
      pushCurrent();
      continue;
    }
    const bulletMatch = line.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bulletMatch) {
      pushCurrent();
      current = bulletMatch[1].trim();
      continue;
    }
    current = current ? `${current} ${line}` : line;
  }
  pushCurrent();

  return {
    criteria: criteria.length ? criteria : [sectionText.replace(/\s+/g, ' ').trim()].filter(Boolean),
    sectionText,
  };
}

function renderNode(node?: JiraDocNode): string {
  if (!node) { return ''; }

  if (typeof node.text === 'string' && node.type === 'text') {
    return node.text;
  }

  const children = Array.isArray(node.content) ? node.content : [];
  const renderChildren = () => children.map(child => renderNode(child)).join('');

  switch (node.type) {
    case 'doc':
      return children.map(child => renderNode(child)).join('');
    case 'text':
      return node.text || '';
    case 'hardBreak':
      return '\n';
    case 'paragraph':
      return `${renderChildren()}\n\n`;
    case 'heading':
      return `${renderChildren()}\n`;
    case 'bulletList':
      return `${children.map(child => renderListItem(child, '- ')).join('\n')}\n\n`;
    case 'orderedList':
      return `${children.map((child, index) => renderListItem(child, `${index + 1}. `)).join('\n')}\n\n`;
    case 'listItem':
      return children.map(child => renderNode(child)).join('').trim();
    case 'blockquote':
    case 'panel':
    case 'expand':
      return `${children.map(child => renderNode(child)).join('').trim()}\n\n`;
    case 'codeBlock':
      return `${renderChildren()}\n\n`;
    default:
      if (typeof node.text === 'string') { return node.text; }
      return children.map(child => renderNode(child)).join('');
  }
}

function renderListItem(node: JiraDocNode, prefix: string): string {
  const raw = renderNode(node).trim().replace(/\n{2,}/g, '\n');
  if (!raw) { return prefix.trim(); }
  const [first, ...rest] = raw.split('\n');
  const tail = rest.map(line => `  ${line}`).join('\n');
  return `${prefix}${first}${tail ? `\n${tail}` : ''}`;
}

function normalizeSpacing(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');
}

function looksLikeHeading(line: string): boolean {
  if (/^#{1,6}\s+/.test(line)) { return true; }
  if (/^(?:[-*•]|\d+[.)])\s+/.test(line)) { return false; }
  const plain = line.replace(/[*_`]/g, '').trim();
  if (!plain) { return false; }
  const normalized = plain.replace(/:$/, '').trim().toLowerCase();
  if (normalized === 'acceptance criteria') { return false; }
  return /^[A-Z][A-Za-z0-9 /&()_-]{2,60}:?$/.test(plain);
}
