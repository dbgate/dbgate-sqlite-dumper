import { toAsciiLowerCase, toAsciiUpperCase } from '../security/identifiers.js';
import { isIdentifierCharCode } from './complete.js';

interface LeadingToken {
  readonly kind: 'word' | 'quoted' | 'string' | 'punct' | 'number';
  /** For `word`: the text; for `quoted`/`string`: the unquoted value; else the character(s). */
  readonly value: string;
}

/**
 * Reads the first `limit` tokens of a statement, skipping whitespace and
 * comments. Enough to recognize what a statement *is* without parsing it.
 */
function leadingTokens(sql: string, limit: number): LeadingToken[] {
  const tokens: LeadingToken[] = [];
  let index = 0;
  const length = sql.length;
  while (index < length && tokens.length < limit) {
    const character = sql[index] as string;
    const code = sql.charCodeAt(index);
    if (/\s/.test(character) || character === '\uFEFF') {
      index++;
      continue;
    }
    if (character === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? length : end + 1;
      continue;
    }
    if (character === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? length : end + 2;
      continue;
    }
    if (character === '"' || character === '`' || character === "'" || character === '[') {
      const close = character === '[' ? ']' : character;
      let value = '';
      index++;
      while (index < length) {
        if (sql[index] === close) {
          if (close !== ']' && sql[index + 1] === close) {
            value += close;
            index += 2;
            continue;
          }
          index++;
          break;
        }
        value += sql[index];
        index++;
      }
      tokens.push({ kind: character === "'" ? 'string' : 'quoted', value });
      continue;
    }
    if (code >= 0x30 && code <= 0x39) {
      let end = index + 1;
      while (end < length && /[0-9A-Za-z_.+-]/.test(sql[end] as string)) {
        end++;
      }
      tokens.push({ kind: 'number', value: sql.slice(index, end) });
      index = end;
      continue;
    }
    if (isIdentifierCharCode(code)) {
      let end = index + 1;
      while (end < length && isIdentifierCharCode(sql.charCodeAt(end))) {
        end++;
      }
      tokens.push({ kind: 'word', value: sql.slice(index, end) });
      index = end;
      continue;
    }
    tokens.push({ kind: 'punct', value: character });
    index++;
  }
  return tokens;
}

/** What a statement is, as far as restore bookkeeping needs to know. */
export interface StatementInfo {
  /** The statement's first keyword, upper-cased: `CREATE`, `INSERT`, `PRAGMA`, `BEGIN`, ... */
  readonly verb: string;
  /** For `CREATE`: the object kind (`TABLE`, `INDEX`, `VIEW`, `TRIGGER`, `VIRTUAL TABLE`). */
  readonly objectKind?: string;
  /** The object the statement creates, fills or changes, when recognizable. */
  readonly objectName?: string;
  /** For `PRAGMA`: the pragma name, lower-cased, without a schema prefix. */
  readonly pragmaName?: string;
  /** For `PRAGMA x = value` / `PRAGMA x(value)`: the value as written, unquoted. */
  readonly pragmaValue?: string;
  /**
   * `begin`, `commit`, `rollback`, `savepoint`, `release` or
   * `rollback-to-savepoint` for transaction-control statements.
   */
  readonly transactionControl?:
    'begin' | 'commit' | 'rollback' | 'rollback-to-savepoint' | 'savepoint' | 'release';
}

function nameToken(token: LeadingToken | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  return token.kind === 'word' || token.kind === 'quoted' || token.kind === 'string'
    ? token.value
    : undefined;
}

/** Skips an optional `schema.` qualifier, returning the unqualified name and the next position. */
function qualifiedName(
  tokens: readonly LeadingToken[],
  position: number,
): { name?: string; next: number } {
  const first = nameToken(tokens[position]);
  if (first === undefined) {
    return { next: position };
  }
  if (tokens[position + 1]?.kind === 'punct' && tokens[position + 1]?.value === '.') {
    const second = nameToken(tokens[position + 2]);
    return second === undefined
      ? { name: first, next: position + 1 }
      : { name: second, next: position + 3 };
  }
  return { name: first, next: position + 1 };
}

function isWord(token: LeadingToken | undefined, word: string): boolean {
  return token?.kind === 'word' && toAsciiUpperCase(token.value) === word;
}

/**
 * Classifies a statement from its leading tokens.
 *
 * Used for restore progress (`currentObject`), for following the script's
 * own transaction control, and for noticing the session-level pragmas a dump
 * changes (`foreign_keys`, `writable_schema`) so they can be put back if the
 * restore stops early.
 */
export function describeStatement(sql: string): StatementInfo {
  const tokens = leadingTokens(sql, 12);
  const first = tokens[0];
  if (!first || first.kind !== 'word') {
    return { verb: '' };
  }
  const verb = toAsciiUpperCase(first.value);

  switch (verb) {
    case 'BEGIN':
      return { verb, transactionControl: 'begin' };
    case 'COMMIT':
    case 'END':
      return { verb, transactionControl: 'commit' };
    case 'ROLLBACK': {
      // ROLLBACK [TRANSACTION] TO [SAVEPOINT] name only unwinds to a savepoint.
      const toPosition = isWord(tokens[1], 'TRANSACTION') ? 2 : 1;
      return isWord(tokens[toPosition], 'TO')
        ? { verb, transactionControl: 'rollback-to-savepoint' }
        : { verb, transactionControl: 'rollback' };
    }
    case 'SAVEPOINT':
      return { verb, transactionControl: 'savepoint' };
    case 'RELEASE':
      return { verb, transactionControl: 'release' };
    case 'PRAGMA': {
      const { name, next } = qualifiedName(tokens, 1);
      if (name === undefined) {
        return { verb };
      }
      const pragmaName = toAsciiLowerCase(name);
      const operator = tokens[next];
      if (operator?.kind === 'punct' && (operator.value === '=' || operator.value === '(')) {
        const valueToken = tokens[next + 1];
        let value = valueToken?.value;
        if (
          valueToken?.kind === 'punct' &&
          (valueToken.value === '-' || valueToken.value === '+')
        ) {
          value = `${valueToken.value}${tokens[next + 2]?.value ?? ''}`;
        }
        return value === undefined
          ? { verb, pragmaName }
          : { verb, pragmaName, pragmaValue: value };
      }
      return { verb, pragmaName };
    }
    case 'INSERT':
    case 'REPLACE': {
      let position = 1;
      if (verb === 'INSERT' && isWord(tokens[1], 'OR')) {
        position = 3;
      }
      if (isWord(tokens[position], 'INTO')) {
        position++;
      }
      const { name } = qualifiedName(tokens, position);
      return name === undefined ? { verb } : { verb, objectName: name };
    }
    case 'DELETE': {
      const position = isWord(tokens[1], 'FROM') ? 2 : 1;
      const { name } = qualifiedName(tokens, position);
      return name === undefined ? { verb } : { verb, objectName: name };
    }
    case 'UPDATE':
    case 'ANALYZE':
    case 'DROP': {
      let position = 1;
      let objectKind: string | undefined;
      if (verb === 'DROP' && tokens[1]?.kind === 'word') {
        objectKind = toAsciiUpperCase(tokens[1].value);
        position = 2;
        if (isWord(tokens[2], 'IF') && isWord(tokens[3], 'EXISTS')) {
          position = 4;
        }
      }
      const { name } = qualifiedName(tokens, position);
      return {
        verb,
        ...(objectKind === undefined ? {} : { objectKind }),
        ...(name === undefined ? {} : { objectName: name }),
      };
    }
    case 'CREATE': {
      let position = 1;
      while (
        isWord(tokens[position], 'TEMP') ||
        isWord(tokens[position], 'TEMPORARY') ||
        isWord(tokens[position], 'UNIQUE')
      ) {
        position++;
      }
      let objectKind =
        tokens[position]?.kind === 'word' ? toAsciiUpperCase(tokens[position]!.value) : '';
      position++;
      if (objectKind === 'VIRTUAL' && isWord(tokens[position], 'TABLE')) {
        objectKind = 'VIRTUAL TABLE';
        position++;
      }
      if (isWord(tokens[position], 'IF') && isWord(tokens[position + 1], 'NOT')) {
        position += 3;
      }
      const { name } = qualifiedName(tokens, position);
      return {
        verb,
        ...(objectKind === '' ? {} : { objectKind }),
        ...(name === undefined ? {} : { objectName: name }),
      };
    }
    default:
      return { verb };
  }
}
