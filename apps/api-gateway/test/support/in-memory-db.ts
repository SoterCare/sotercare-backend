/* eslint-disable @typescript-eslint/no-this-alias, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
/**
 * In-memory stand-in for the subset of TypeORM used by the device-ownership
 * and tenant-isolation code paths (Phase 0 security regression tests).
 *
 * Two properties matter and are modelled on purpose:
 *  1. TypeORM 0.3 default semantics: `undefined` values in a find `where`
 *     object are IGNORED (the root cause of GAP-002). Set
 *     `undefinedWhere: 'throw'` to model `invalidWhereValuesBehavior`.
 *  2. Every single operation is atomic, but each one yields to the event loop
 *     first, so concurrent read-check-write sequences interleave exactly like
 *     two requests racing against Postgres. A conditional `update()` is one
 *     atomic check-and-set, like `UPDATE ... WHERE <predicate>` under a row lock.
 *
 * It is NOT a database: DB-level guarantees still need the Postgres-backed
 * test (`phase0-ownership.pg.spec.ts`, gated by TEST_DATABASE_URL).
 */
import { FindOperator } from 'typeorm';

type Row = Record<string, any>;

interface TableDef {
  primaryKey: string;
  autoIncrement?: boolean;
  /** unique column groups used for insert-or-ignore conflicts */
  uniques?: string[][];
  /** column defaults applied on insert, like DB DEFAULTs (e.g. createdAt now()) */
  defaults?: Record<string, () => any>;
  /** relation name -> (target table, local FK column) */
  relations?: Record<string, { table: string; fk: string }>;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

export class InMemoryDb {
  readonly tables = new Map<string, Row[]>();
  private readonly defs = new Map<string, TableDef>();
  private readonly nextId = new Map<string, number>();
  undefinedWhere: 'ignore' | 'throw' = 'ignore';

  define(entity: any, def: TableDef) {
    this.defs.set(entity.name, def);
    this.tables.set(entity.name, []);
    this.nextId.set(entity.name, 1);
    return this;
  }

  rows(entity: any): Row[] {
    const rows = this.tables.get(entity.name);
    if (!rows) throw new Error(`InMemoryDb: entity ${entity.name} not defined`);
    return rows;
  }

  seed(entity: any, rows: Row[]) {
    for (const row of rows) this.insertRow(entity, { ...row }, false);
    return this;
  }

  repository(entity: any) {
    return new InMemoryRepository(this, entity);
  }

  /**
   * Stand-in for DataSource. Each transaction keeps its own undo log, so a
   * failed transaction rolls back only its own writes even when several
   * transactions interleave (a global snapshot would erase a concurrent
   * winner's committed rows).
   */
  dataSource() {
    const db = this;
    return {
      async transaction<T>(cb: (manager: InMemoryManager) => Promise<T>) {
        const manager = new InMemoryManager(db, []);
        try {
          return await cb(manager);
        } catch (error) {
          manager.rollback();
          throw error;
        }
      },
    };
  }

  // ── internals ───────────────────────────────────────────────────────────

  def(entity: any): TableDef {
    const def = this.defs.get(entity.name);
    if (!def) throw new Error(`InMemoryDb: entity ${entity.name} not defined`);
    return def;
  }

  matches(entity: any, row: Row, where: Row | undefined): boolean {
    if (!where) return true;
    return Object.entries(where).every(([key, expected]) => {
      if (expected === undefined) {
        if (this.undefinedWhere === 'throw') {
          throw new Error(
            `Undefined value encountered in property '${entity.name}.${key}' of a where condition.`,
          );
        }
        return true; // TypeORM default: skip undefined properties
      }
      const actual = row[key];
      if (expected instanceof FindOperator) {
        const op = expected;
        switch (op.type) {
          case 'in':
            return (op.value as any[]).some((v) => same(actual, v));
          case 'isNull':
            return actual === null || actual === undefined;
          case 'moreThanOrEqual':
            return cmp(actual) >= cmp(op.value);
          case 'lessThan':
            return cmp(actual) < cmp(op.value);
          case 'between': {
            const [lo, hi] = op.value as any[];
            return cmp(actual) >= cmp(lo) && cmp(actual) <= cmp(hi);
          }
          default:
            throw new Error(`InMemoryDb: unsupported operator ${op.type}`);
        }
      }
      return same(actual, expected);
    });
  }

  conflicts(entity: any, row: Row): Row | undefined {
    const def = this.def(entity);
    const groups = [[def.primaryKey], ...(def.uniques ?? [])];
    return this.rows(entity).find((existing) =>
      groups.some((cols) =>
        cols.every(
          (c) =>
            row[c] !== undefined &&
            row[c] !== null &&
            same(existing[c], row[c]),
        ),
      ),
    );
  }

  insertRow(entity: any, row: Row, ignoreConflicts: boolean): Row | null {
    const def = this.def(entity);
    for (const [column, make] of Object.entries(def.defaults ?? {})) {
      if (row[column] === undefined) row[column] = make();
    }
    if (
      def.autoIncrement &&
      (row[def.primaryKey] === undefined || row[def.primaryKey] === null)
    ) {
      const id = this.nextId.get(entity.name)!;
      this.nextId.set(entity.name, id + 1);
      row[def.primaryKey] = id;
    }
    if (this.conflicts(entity, row)) {
      if (ignoreConflicts) return null;
      throw new Error(`InMemoryDb: duplicate key in ${entity.name}`);
    }
    this.rows(entity).push(row);
    return row;
  }

  /** Always returns a detached copy, like rows materialised from a real query. */
  attachRelations(entity: any, row: Row, relations?: string[]) {
    const out = { ...row };
    if (!relations?.length) return out;
    const def = this.def(entity);
    for (const name of relations) {
      const rel = def.relations?.[name];
      if (!rel) throw new Error(`InMemoryDb: unknown relation ${name}`);
      const target = this.tables.get(rel.table) ?? [];
      const targetDef = this.defs.get(rel.table)!;
      const related = target.find((t) =>
        same(t[targetDef.primaryKey], row[rel.fk]),
      );
      out[name] = related ? { ...related } : null;
    }
    return out;
  }
}

function same(a: any, b: any) {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return a === b;
}

function cmp(v: any) {
  return v instanceof Date ? v.getTime() : v;
}

function applyFind(db: InMemoryDb, entity: any, options: any = {}): Row[] {
  const whereList: (Row | undefined)[] = Array.isArray(options.where)
    ? options.where
    : [options.where];
  let rows = db
    .rows(entity)
    .filter((row) => whereList.some((w) => db.matches(entity, row, w)));
  if (options.order) {
    const [[key, dir]] = Object.entries(options.order);
    rows = [...rows].sort((l, r) =>
      dir === 'DESC' ? cmp(r[key]) - cmp(l[key]) : cmp(l[key]) - cmp(r[key]),
    );
  }
  if (typeof options.take === 'number') rows = rows.slice(0, options.take);
  return rows.map((row) => db.attachRelations(entity, row, options.relations));
}

export class InMemoryRepository {
  constructor(
    private readonly db: InMemoryDb,
    private readonly entity: any,
  ) {}

  create(payload: Row) {
    return { ...payload };
  }

  /** `repository.manager.transaction(...)`, as on a real TypeORM repository. */
  get manager() {
    return this.db.dataSource();
  }

  async find(options?: any) {
    await tick();
    return applyFind(this.db, this.entity, options);
  }

  async findOne(options: any) {
    await tick();
    return applyFind(this.db, this.entity, { ...options, take: 1 })[0] ?? null;
  }

  async findOneBy(where: Row) {
    return this.findOne({ where });
  }

  async exists(options: any) {
    await tick();
    return applyFind(this.db, this.entity, options).length > 0;
  }

  async save(entity: Row) {
    await tick();
    const def = this.db.def(this.entity);
    const pk = entity[def.primaryKey];
    const rows = this.db.rows(this.entity);
    const index = rows.findIndex(
      (row) => pk !== undefined && same(row[def.primaryKey], pk),
    );
    if (index >= 0) {
      rows[index] = { ...rows[index], ...entity };
      return rows[index];
    }
    return this.db.insertRow(this.entity, { ...entity }, false);
  }

  /** Atomic conditional update — models `UPDATE ... WHERE criteria`. */
  async update(criteria: Row, partial: Row) {
    await tick();
    let affected = 0;
    for (const row of this.db.rows(this.entity)) {
      if (this.db.matches(this.entity, row, criteria)) {
        Object.assign(row, partial);
        affected += 1;
      }
    }
    return { affected, raw: [], generatedMaps: [] };
  }

  async insert(rows: Row | Row[]) {
    await tick();
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      this.db.insertRow(this.entity, { ...row }, false);
    }
    return { identifiers: [], generatedMaps: [], raw: [] };
  }

  createQueryBuilder(): never {
    throw new Error(
      `InMemoryDb: createQueryBuilder() on ${this.entity.name} is not supported by the fake`,
    );
  }
}

/** Stand-in for EntityManager inside dataSource.transaction(). */
export class InMemoryManager {
  constructor(
    private readonly db: InMemoryDb,
    private readonly undo: (() => void)[],
  ) {}

  rollback() {
    while (this.undo.length) this.undo.pop()!();
  }

  private trackInsert(entity: any, row: Row | null) {
    if (!row) return;
    this.undo.push(() => {
      const rows = this.db.rows(entity);
      const index = rows.indexOf(row);
      if (index >= 0) rows.splice(index, 1);
    });
  }

  private trackUpdate(row: Row) {
    const before = { ...row };
    this.undo.push(() => {
      for (const key of Object.keys(row)) delete row[key];
      Object.assign(row, before);
    });
  }

  async find(entity: any, options?: any) {
    await tick();
    return applyFind(this.db, entity, options);
  }

  async findOne(entity: any, options: any) {
    await tick();
    return applyFind(this.db, entity, { ...options, take: 1 })[0] ?? null;
  }

  async insert(entity: any, rows: Row | Row[]) {
    await tick();
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      this.trackInsert(entity, this.db.insertRow(entity, { ...row }, false));
    }
    return { identifiers: [], generatedMaps: [], raw: [] };
  }

  async update(entity: any, criteria: Row, partial: Row) {
    await tick();
    let affected = 0;
    for (const row of this.db.rows(entity)) {
      if (this.db.matches(entity, row, criteria)) {
        this.trackUpdate(row);
        Object.assign(row, partial);
        affected += 1;
      }
    }
    return { affected, raw: [], generatedMaps: [] };
  }

  /** Insert-or-update on the conflict columns (overwrites, like ON CONFLICT DO UPDATE). */
  async upsert(entity: any, rows: Row[], conflictPaths: string[]) {
    await tick();
    for (const row of rows) {
      const existing = this.db
        .rows(entity)
        .find((r) => conflictPaths.every((c) => same(r[c], row[c])));
      if (existing) {
        this.trackUpdate(existing);
        Object.assign(existing, row);
      } else {
        this.trackInsert(entity, this.db.insertRow(entity, { ...row }, false));
      }
    }
    return { identifiers: [], generatedMaps: [], raw: [] };
  }

  createQueryBuilder() {
    const db = this.db;
    const manager = this;
    const state: { entity?: any; rows: Row[]; ignore: boolean } = {
      rows: [],
      ignore: false,
    };
    const qb: any = {
      insert: () => qb,
      into: (entity: any) => ((state.entity = entity), qb),
      values: (rows: Row | Row[]) => (
        (state.rows = Array.isArray(rows) ? rows : [rows]),
        qb
      ),
      orIgnore: () => ((state.ignore = true), qb),
      returning: () => qb,
      updateEntity: () => qb,
      execute: async () => {
        await tick();
        const inserted: Row[] = [];
        for (const row of state.rows) {
          const result = db.insertRow(state.entity, { ...row }, state.ignore);
          manager.trackInsert(state.entity, result);
          if (result) inserted.push(result);
        }
        return { raw: inserted, identifiers: [], generatedMaps: [] };
      },
    };
    return qb;
  }
}
