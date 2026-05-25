import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './schema';

// Postgres returns bigint as string by default in node-pg. We keep that
// behaviour for the `seq` and `total_token_count` columns — JS numbers
// only safely represent integers up to 2^53, while bigint is arbitrary.
// Consumers can parseInt for display; the wire format stays exact.

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);

  private pool!: Pool;
  private kyselyInstance!: Kysely<Database>;

  async onModuleInit(): Promise<void> {
    const host = process.env.PG_HOST ?? '127.0.0.1';
    const port = Number(process.env.PG_PORT ?? '5432');
    const database = process.env.PG_DATABASE ?? 'swirlock_agent';
    const user = process.env.PG_USER ?? 'swirlock_agent';
    const password = process.env.PG_PASSWORD;

    if (!password) {
      throw new Error(
        'PG_PASSWORD is missing. Set it in service.config.local.cjs.',
      );
    }

    // Force timestamptz columns into native Date instances (default
    // behaviour, but pin it here so we don't drift if a future
    // dependency mutates the global type parser).
    types.setTypeParser(1184, (value) => (value ? new Date(value) : null));

    this.pool = new Pool({
      host,
      port,
      database,
      user,
      password,
      max: 10,
      idleTimeoutMillis: 30_000,
    });

    // Probe the connection at startup so a misconfigured DB fails fast
    // rather than at first request.
    const probe = await this.pool.query('SELECT 1 AS ok');
    if (probe.rows[0]?.ok !== 1) {
      throw new Error('Postgres probe query did not return ok=1');
    }

    this.kyselyInstance = new Kysely<Database>({
      dialect: new PostgresDialect({ pool: this.pool }),
    });

    this.logger.log(
      `connected ${user}@${host}:${port}/${database}`,
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.kyselyInstance) {
      await this.kyselyInstance.destroy();
    }
  }

  get db(): Kysely<Database> {
    return this.kyselyInstance;
  }
}
