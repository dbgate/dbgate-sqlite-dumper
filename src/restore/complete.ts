/**
 * A port of SQLite's `sqlite3_complete()` (`complete.c`) — the function the
 * `sqlite3` shell calls to decide whether the text it has accumulated so far
 * is one or more *complete* statements, and therefore ready to run.
 *
 * Splitting on `;` is not enough, and not in an edge-case way: a trigger
 * body is a list of statements, each ending in `;`, inside a single
 * `CREATE TRIGGER ... BEGIN ... END;`. `sqlite3_complete()` recognizes that
 * with a small state machine over eight token classes, and reproducing that
 * machine exactly is what makes this package split a script where the shell
 * does.
 */

/** Token classes of the `sqlite3_complete()` state machine. */
export const CompleteToken = {
  Semi: 0,
  Whitespace: 1,
  Other: 2,
  Explain: 3,
  Create: 4,
  Temp: 5,
  Trigger: 6,
  End: 7,
} as const;

export type CompleteToken = (typeof CompleteToken)[keyof typeof CompleteToken];

/**
 * States of the machine:
 *
 * - `0` INVALID — nothing but whitespace/comments seen yet.
 * - `1` START — at the start of a statement, or just after a complete one.
 * - `2` NORMAL — inside an ordinary statement.
 * - `3` EXPLAIN — the statement began with `EXPLAIN`.
 * - `4` CREATE — the statement began with `CREATE` (or `EXPLAIN CREATE`).
 * - `5` TRIGGER — inside `CREATE [TEMP] TRIGGER ...`, before or within its body.
 * - `6` SEMI — just saw a `;` inside a trigger body.
 * - `7` END — saw `END` right after such a `;`; the next `;` completes the trigger.
 */
export const COMPLETE_TRANSITIONS: readonly (readonly number[])[] = [
  //         SEMI  WS  OTHER EXPLAIN CREATE TEMP TRIGGER END
  /* 0 */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* 1 */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* 2 */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* 3 */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* 4 */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* 5 */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* 6 */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* 7 */ [1, 7, 5, 5, 5, 5, 5, 5],
];

/** Applies one token to a state. */
export function completeTransition(state: number, token: CompleteToken): number {
  return (COMPLETE_TRANSITIONS[state] as readonly number[])[token] as number;
}

/**
 * `IdChar()` from `complete.c`: letters, digits, `_`, `$`, and every byte (or
 * code unit) at or above `0x80`, which is how SQLite admits non-ASCII
 * identifiers without decoding them.
 */
export function isIdentifierCharCode(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x5f ||
    code === 0x24 ||
    code >= 0x80
  );
}

/** Classifies a complete identifier-like word the way `sqlite3_complete()` does. */
export function classifyWord(word: string): CompleteToken {
  switch (word.length) {
    case 3:
      return word.toLowerCase() === 'end' ? CompleteToken.End : CompleteToken.Other;
    case 4:
      return word.toLowerCase() === 'temp' ? CompleteToken.Temp : CompleteToken.Other;
    case 6:
      return word.toLowerCase() === 'create' ? CompleteToken.Create : CompleteToken.Other;
    case 7: {
      const lower = word.toLowerCase();
      if (lower === 'trigger') return CompleteToken.Trigger;
      if (lower === 'explain') return CompleteToken.Explain;
      return CompleteToken.Other;
    }
    case 9:
      return word.toLowerCase() === 'temporary' ? CompleteToken.Temp : CompleteToken.Other;
    default:
      return CompleteToken.Other;
  }
}

function isCompleteWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\r' ||
    character === '\t' ||
    character === '\n' ||
    character === '\f'
  );
}

/**
 * `sqlite3_complete()`: `true` when `sql` ends with a complete statement —
 * a `;` that is not inside a string, identifier, comment or trigger body,
 * followed by nothing but whitespace and comments.
 *
 * Faithful to the C, including its quirks: an unterminated `/*` comment or
 * quoted token makes the text incomplete, while a trailing `--` comment
 * with no newline does not.
 */
export function isCompleteStatement(sql: string): boolean {
  let state = 0;
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const character = sql[index] as string;
    let token: CompleteToken;

    if (character === ';') {
      token = CompleteToken.Semi;
    } else if (isCompleteWhitespace(character)) {
      token = CompleteToken.Whitespace;
    } else if (character === '/') {
      if (sql[index + 1] !== '*') {
        token = CompleteToken.Other;
      } else {
        index += 2;
        while (index < length && !(sql[index] === '*' && sql[index + 1] === '/')) {
          index++;
        }
        if (index >= length) {
          return false;
        }
        index++;
        token = CompleteToken.Whitespace;
      }
    } else if (character === '-') {
      if (sql[index + 1] !== '-') {
        token = CompleteToken.Other;
      } else {
        while (index < length && sql[index] !== '\n') {
          index++;
        }
        if (index >= length) {
          return state === 1;
        }
        token = CompleteToken.Whitespace;
      }
    } else if (character === '[') {
      index++;
      while (index < length && sql[index] !== ']') {
        index++;
      }
      if (index >= length) {
        return false;
      }
      token = CompleteToken.Other;
    } else if (character === '`' || character === '"' || character === "'") {
      index++;
      while (index < length && sql[index] !== character) {
        index++;
      }
      if (index >= length) {
        return false;
      }
      token = CompleteToken.Other;
    } else if (isIdentifierCharCode(sql.charCodeAt(index))) {
      let end = index + 1;
      while (end < length && isIdentifierCharCode(sql.charCodeAt(end))) {
        end++;
      }
      token = classifyWord(sql.slice(index, end));
      index = end - 1;
    } else {
      token = CompleteToken.Other;
    }

    state = completeTransition(state, token);
    index++;
  }
  return state === 1;
}
