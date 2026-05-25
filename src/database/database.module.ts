import { Global, Module } from '@nestjs/common';
import { DatabaseService } from './database.service';

// Global so feature modules (sessions, turns, etc.) can inject
// DatabaseService without re-importing this module everywhere.
@Global()
@Module({
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
