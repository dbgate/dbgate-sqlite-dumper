/**
 * The round-trip fixture: one statement per array element, executed on its
 * own with `better-sqlite3` — never through this package's parser, so a
 * statement-splitting bug cannot corrupt the fixture and hide itself.
 *
 * It is written to exercise every construct the dump and restore paths must
 * reproduce, and deliberately *not* in a friendly order: a view is created
 * before the table it reads, two tables reference each other, and rows are
 * deleted so hidden rowids have gaps.
 *
 * Everything here must also be understood by the `sqlite3` shell the
 * integration tests run (3.45 on Ubuntu 24.04), since the native paths of
 * the matrix restore and dump it too.
 */
export const FIXTURE_SCHEMA: readonly string[] = [
  // Circular references; better-sqlite3 enforces foreign keys by default.
  'PRAGMA foreign_keys = OFF',

  `CREATE TABLE authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE,
    bio TEXT DEFAULT 'n/a',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    favourite_book INTEGER REFERENCES books(id) -- circular with books.author_id
  )`,
  `CREATE TABLE books (
    id INTEGER PRIMARY KEY,
    author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
    title TEXT,
    price NUMERIC(10,2),
    weight REAL,
    cover BLOB,
    isbn TEXT UNIQUE,
    CHECK (price IS NULL OR price >= 0)
  )`,
  'CREATE VIEW v_early AS SELECT x FROM later_table',
  'CREATE TABLE "order" ("select" INTEGER, "a b" TEXT, "quote""d" TEXT)',
  "CREATE TABLE 'single_quoted' (x)",
  'CREATE TABLE [bracketed name] (x)',
  'CREATE TABLE "žluťoučký kůň" (ž TEXT)',
  'CREATE TABLE kv (k TEXT PRIMARY KEY, v) WITHOUT ROWID',
  'CREATE TABLE typed (i INTEGER, t TEXT, r REAL, b BLOB, a ANY) STRICT',
  `CREATE TABLE gen (
    a INTEGER,
    b INTEGER GENERATED ALWAYS AS (a * 2) VIRTUAL,
    c TEXT GENERATED ALWAYS AS (a || '!') STORED
  )`,
  'CREATE TABLE heap (a, b)',
  `CREATE TABLE commented (
    a INTEGER, -- a line comment; with a semicolon
    b TEXT /* a block comment -- with dashes */
  )`,
  'CREATE TABLE audit (id INTEGER PRIMARY KEY, message TEXT)',
  'CREATE TABLE self_ref (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES self_ref(id))',
  'CREATE TABLE later_table (x)',
  'CREATE VIEW v_books AS SELECT b.title, a.name FROM books b JOIN authors a ON a.id = b.author_id',
  "CREATE VIEW v_nested AS SELECT * FROM v_books WHERE title NOT LIKE '%--%'",
  'CREATE INDEX idx_books_title ON books (title COLLATE NOCASE DESC)',
  'CREATE UNIQUE INDEX idx_partial ON books (author_id, title) WHERE price > 0',
  'CREATE INDEX idx_expr ON authors (lower(name))',
  `CREATE TRIGGER trg_books_ai AFTER INSERT ON books BEGIN
    INSERT INTO audit (message) VALUES ('book ' || new.title || '; END');
    UPDATE authors SET bio = bio WHERE id = new.author_id;
  END`,
  "CREATE TRIGGER trg_view INSTEAD OF INSERT ON v_books BEGIN SELECT RAISE(ABORT, 'read only'); END",
  'CREATE VIRTUAL TABLE docs USING fts5 (title, body)',
  'CREATE VIRTUAL TABLE geo USING rtree (id, minx, maxx)',

  "INSERT INTO authors (name, bio, created_at) VALUES ('Ada', 'first' || char(10) || 'second line', '2024-01-01 00:00:00')",
  "INSERT INTO authors (name, bio, created_at) VALUES ('Brian', NULL, '2024-01-02 00:00:00')",
  "INSERT INTO authors (name, bio, created_at) VALUES ('Zed', 'to be deleted', '2024-01-03 00:00:00')",
  "DELETE FROM authors WHERE name = 'Zed'",
  "INSERT INTO books VALUES (1, 1, 'Notes; part 1', 12.50, 0.25, X'89504E470D0A1A0A', '978-0')",
  "INSERT INTO books VALUES (2, 1, 'It''s -- not a comment', 0, 1.5, X'', '978-1')",
  "INSERT INTO books VALUES (3, 2, 'CRLF' || char(13) || char(10) || 'inside', NULL, 2.0, NULL, NULL)",
  "INSERT INTO books VALUES (4, 2, 'emoji 😀 and žluť', 99.99, 0.1, zeroblob(3), '978-3')",
  'UPDATE authors SET favourite_book = 1 WHERE id = 1',
  `INSERT INTO "order" VALUES (1, 'space', 'q"uote')`,
  "INSERT INTO 'single_quoted' VALUES ('x')",
  'INSERT INTO [bracketed name] VALUES (1)',
  `INSERT INTO "žluťoučký kůň" VALUES ('úpěl ďábelské ódy')`,
  "INSERT INTO kv VALUES ('b', 2), ('a', 'one'), ('c', X'00FF'), ('d', NULL)",
  `INSERT INTO typed VALUES
    (9223372036854775807, 'max', 1e300, X'DEADBEEF', 1),
    (-9223372036854775808, 'min', -1e-300, X'', 'text'),
    (0, '', 9e999, NULL, 2.5),
    (NULL, NULL, -9e999, NULL, X'01')`,
  'INSERT INTO gen (a) VALUES (1), (2), (NULL)',
  "INSERT INTO heap VALUES (1, 'one'), (2, 'two'), (3, 'three'), (4, 3.0), (5, 1e20)",
  'DELETE FROM heap WHERE a = 2',
  "INSERT INTO commented VALUES (1, 'a;b')",
  'INSERT INTO self_ref VALUES (1, NULL), (2, 1), (3, 2)',
  'INSERT INTO later_table VALUES (1)',
  "INSERT INTO docs VALUES ('Hello', 'world of full-text search'), ('Second', 'quote '' and -- dashes')",
  'INSERT INTO geo VALUES (1, 0.5, 1.5), (2, -10, 10)',
  'ANALYZE',
  // better-sqlite3 is built with SQLITE_ENABLE_STAT4 and the Ubuntu shell is
  // not; a dump carrying sqlite_stat4 rows cannot be restored there (by the
  // shell's own .dump either). See docs/known-limitations.md.
  'DROP TABLE IF EXISTS sqlite_stat4',
];

/** Rows whose text holds bytes that are not valid UTF-8, inserted separately as blobs cast to text. */
export const INVALID_UTF8_TEXT: readonly Buffer[] = [
  Buffer.from([0x63, 0x61, 0x66, 0xe9]),
  Buffer.from([0xff, 0xfe, 0x41]),
];
