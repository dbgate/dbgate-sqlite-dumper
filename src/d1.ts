/**
 * Optional adapter for Cloudflare D1.
 *
 * D1 is SQLite, but not a SQLite handle: it is reached over Cloudflare's REST
 * API (or, inside a Worker, through a binding), every statement is a request,
 * results arrive whole as JSON, and its authorizer refuses part of what an
 * embedded handle allows. The adapter declares those restrictions as
 * {@link SqliteConnectionFeatures}, and the core reads the database with the
 * equivalent queries D1 does allow — so the dump is the same plain-SQL,
 * native-`.dump`-compatible file a local copy of the database would give.
 *
 * Dump only. A dump's script relies on `BEGIN TRANSACTION` / `COMMIT` and
 * `PRAGMA writable_schema`, which D1 refuses; to load a dump into D1, use
 * `wrangler d1 execute --file` (or the D1 import API), which accept it once
 * those statements are removed.
 *
 * Uses only the global `fetch` (or the one passed in): no dependency.
 */
import type {
  SqliteConnection,
  SqliteConnectionFeatures,
  SqliteErrorInfo,
  SqliteParameterValue,
  SqliteQuery,
  SqliteQueryResult,
  SqliteRow,
  SqliteStreamOptions,
} from './connection/types.js';
import { OperationCancelledError, SqliteDumperError, throwIfAborted } from './utils/errors.js';

/** Rows per request when a table's data is read. */
export const DEFAULT_D1_PAGE_SIZE = 1000;

const DEFAULT_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

/**
 * What D1 does not allow, as the core understands it:
 *
 * - no `BEGIN` / `SAVEPOINT`, so no read snapshot;
 * - no table-valued `pragma_xxx()` functions;
 * - one database (`main`), and statements need not name it;
 * - JSON results, so bytes are fetched as `hex()` text;
 * - whole results, so table data is read in keyed pages;
 * - reserved `_cf_` tables, which sit in `sqlite_schema` but cannot be read.
 */
export function d1ConnectionFeatures(pageSize = DEFAULT_D1_PAGE_SIZE): SqliteConnectionFeatures {
  return {
    transactions: false,
    pragmaFunctions: false,
    schemaQualifiedNames: false,
    binaryTransport: 'hex',
    pagedReadSize: pageSize,
    reservedNamePrefixes: ['_cf_'],
  };
}

/** An error D1 reported for a statement or a request. */
export class D1Error extends SqliteDumperError {
  /** HTTP status of the response, for the REST API. */
  readonly status: number | undefined;
  /** SQLite's symbolic result code, when D1's message names one (`SQLITE_ERROR`). */
  readonly sqliteCode: string | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super('d1-error', message, options?.cause === undefined ? {} : { cause: options.cause });
    this.name = 'D1Error';
    this.status = options?.status;
    this.sqliteCode = /\b(SQLITE_[A-Z_]+)\b/.exec(message)?.[1];
  }
}

function toD1Parameter(value: SqliteParameterValue): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  // JSON has no bytes; the core never binds them when reading.
  throw new D1Error('Binary parameters cannot be sent to D1');
}

function rowsFromArrays(
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
): SqliteRow[] {
  return rows.map(values => {
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = values[index] ?? null;
    });
    return row as SqliteRow;
  });
}

/** A connection that can only run whole queries, given the two ways to run them. */
function d1Connection(
  run: (queries: readonly SqliteQuery[], signal?: AbortSignal) => Promise<SqliteQueryResult[]>,
  cancel: () => Promise<void>,
  pageSize: number,
): SqliteConnection {
  return {
    features: d1ConnectionFeatures(pageSize),

    async query<Row extends SqliteRow = SqliteRow>(
      query: SqliteQuery,
      signal?: AbortSignal,
    ): Promise<SqliteQueryResult<Row>> {
      throwIfAborted(signal);
      const [result] = await run([query], signal);
      return (result ?? { rows: [] }) as SqliteQueryResult<Row>;
    },

    async queryBatch(
      queries: readonly SqliteQuery[],
      signal?: AbortSignal,
    ): Promise<readonly SqliteQueryResult[]> {
      throwIfAborted(signal);
      return queries.length === 0 ? [] : run(queries, signal);
    },

    stream<Row extends SqliteRow = SqliteRow>(
      query: SqliteQuery,
      options?: SqliteStreamOptions,
    ): AsyncIterable<Row> {
      // D1 returns a result whole; the core reads table data in pages
      // (`pagedReadSize`) and does not stream from this connection.
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<Row> {
          throwIfAborted(options?.signal);
          const [result] = await run([query], options?.signal);
          for (const row of result?.rows ?? []) {
            if (options?.signal?.aborted) {
              throw new OperationCancelledError();
            }
            yield row as Row;
          }
        },
      };
    },

    describeError(error: unknown): SqliteErrorInfo | undefined {
      if (!(error instanceof Error)) {
        return undefined;
      }
      const code = error instanceof D1Error ? error.sqliteCode : undefined;
      return { ...(code === undefined ? {} : { code }), message: error.message };
    },

    cancel,
  };
}

export interface D1HttpOptions {
  /** Cloudflare account ID. */
  readonly accountId: string;
  /** The database's UUID (shown by `wrangler d1 list`). */
  readonly databaseId: string;
  /** An API token with the `D1 Read` (or `D1 Edit`) permission. */
  readonly apiToken: string;
  /** Defaults to `https://api.cloudflare.com/client/v4`. */
  readonly apiBaseUrl?: string;
  /** Rows per request when table data is read. Defaults to {@link DEFAULT_D1_PAGE_SIZE}. */
  readonly pageSize?: number;
  /** Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

interface D1Envelope {
  readonly success?: boolean;
  readonly errors?: readonly { readonly code?: number; readonly message?: string }[];
  readonly result?: readonly {
    readonly success?: boolean;
    readonly error?: string;
    readonly results?: {
      readonly columns?: readonly string[];
      readonly rows?: readonly unknown[][];
    };
  }[];
}

function envelopeError(envelope: D1Envelope | undefined, fallback: string): string {
  const messages = (envelope?.errors ?? [])
    .map(error => error.message)
    .filter((message): message is string => typeof message === 'string' && message !== '');
  return messages.length > 0 ? messages.join('; ') : fallback;
}

/**
 * A connection to a D1 database through Cloudflare's REST API — the `/raw`
 * query endpoint, which returns rows as arrays. Several catalog queries go
 * out as one `batch` request.
 *
 * ```ts
 * import { dumpSqlite } from 'dbgate-sqlite-dumper';
 * import { fromD1Http } from 'dbgate-sqlite-dumper/d1';
 *
 * const connection = fromD1Http({ accountId, databaseId, apiToken });
 * await dumpSqlite(connection, {}, fs.createWriteStream('backup.sql'));
 * ```
 *
 * The token is sent only in the `Authorization` header, and never appears in
 * an error message.
 */
export function fromD1Http(options: D1HttpOptions): SqliteConnection {
  const accountId = String(options.accountId ?? '').trim();
  const databaseId = String(options.databaseId ?? '').trim();
  const apiToken = String(options.apiToken ?? '').trim();
  if (!accountId || !databaseId || !apiToken) {
    throw new D1Error('A D1 connection needs an account ID, a database ID and an API token');
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new D1Error('No fetch implementation is available; pass one as options.fetch');
  }
  const baseUrl = (options.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
  const url = `${baseUrl}/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/raw`;
  const inFlight = new Set<AbortController>();

  const run = async (
    queries: readonly SqliteQuery[],
    signal?: AbortSignal,
  ): Promise<SqliteQueryResult[]> => {
    const statements = queries.map(query => ({
      sql: query.sql,
      ...(query.parameters === undefined || query.parameters.length === 0
        ? {}
        : { params: query.parameters.map(toD1Parameter) }),
    }));
    const body = statements.length === 1 ? statements[0] : { batch: statements };

    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    inFlight.add(controller);
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted || controller.signal.aborted) {
        throw new OperationCancelledError();
      }
      throw new D1Error(
        `D1 request failed: ${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    } finally {
      signal?.removeEventListener('abort', onAbort);
      inFlight.delete(controller);
    }

    let envelope: D1Envelope | undefined;
    try {
      envelope = JSON.parse(text) as D1Envelope;
    } catch {
      envelope = undefined;
    }
    if (!response.ok || !envelope || envelope.success === false) {
      throw new D1Error(
        envelopeError(
          envelope,
          `D1 request failed with HTTP ${response.status}${envelope ? '' : ' and a response that is not JSON'}`,
        ),
        { status: response.status },
      );
    }
    const items = envelope.result ?? [];
    if (items.length !== queries.length) {
      throw new D1Error(`D1 returned ${items.length} results for ${queries.length} statements`, {
        status: response.status,
      });
    }
    return items.map(item => {
      if (item.success === false) {
        throw new D1Error(item.error ?? 'D1 reported a failed statement', {
          status: response.status,
        });
      }
      const columns = item.results?.columns ?? [];
      return { rows: rowsFromArrays(columns, item.results?.rows ?? []), columns };
    });
  };

  return d1Connection(
    run,
    async () => {
      for (const controller of inFlight) {
        controller.abort();
      }
    },
    options.pageSize ?? DEFAULT_D1_PAGE_SIZE,
  );
}

/** The part of a Workers D1 binding (`env.DB`) this adapter uses. */
export interface D1DatabaseBinding {
  prepare(sql: string): D1PreparedStatementBinding;
  batch(statements: D1PreparedStatementBinding[]): Promise<{ results?: unknown[] }[]>;
}

export interface D1PreparedStatementBinding {
  bind(...values: unknown[]): D1PreparedStatementBinding;
  raw(options: { columnNames: true }): Promise<[string[], ...unknown[][]]>;
}

export interface D1BindingOptions {
  /** Rows per query when table data is read. Defaults to {@link DEFAULT_D1_PAGE_SIZE}. */
  readonly pageSize?: number;
}

/**
 * A connection through a D1 binding, for a dump taken inside a Worker
 * (`env.DB`). Needs the `nodejs_compat` compatibility flag, for `Buffer`.
 */
export function fromD1Binding(
  database: D1DatabaseBinding,
  options?: D1BindingOptions,
): SqliteConnection {
  const prepare = (query: SqliteQuery): D1PreparedStatementBinding => {
    const statement = database.prepare(query.sql);
    return query.parameters === undefined || query.parameters.length === 0
      ? statement
      : statement.bind(...query.parameters.map(toD1Parameter));
  };
  const run = async (
    queries: readonly SqliteQuery[],
    signal?: AbortSignal,
  ): Promise<SqliteQueryResult[]> => {
    throwIfAborted(signal);
    try {
      if (queries.length === 1) {
        const [columns, ...rows] = await prepare(queries[0] as SqliteQuery).raw({
          columnNames: true,
        });
        return [{ rows: rowsFromArrays(columns ?? [], rows), columns: columns ?? [] }];
      }
      const results = await database.batch(queries.map(prepare));
      return results.map(result => ({ rows: (result.results ?? []) as SqliteRow[] }));
    } catch (error) {
      if (error instanceof SqliteDumperError) throw error;
      throw new D1Error(error instanceof Error ? error.message : String(error), { cause: error });
    }
  };
  // A binding call cannot be interrupted; cancellation takes effect between queries.
  return d1Connection(run, async () => {}, options?.pageSize ?? DEFAULT_D1_PAGE_SIZE);
}
