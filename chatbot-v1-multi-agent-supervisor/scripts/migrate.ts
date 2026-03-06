// IMPORTANT: Load environment variables FIRST, before any other imports
// This ensures env vars are available when other modules are initialized
import { config } from 'dotenv';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from project root
// When running with tsx, __dirname is scripts
const projectRoot = join(__dirname, '..');
const envPath = join(projectRoot, '.env');
config({
  path: envPath,
});

// Now import other modules that depend on environment variables
import {
  isDatabaseAvailable,
  getSchemaName,
  getConnectionUrl,
} from '@chat-template/db';

async function main() {
  const { default: postgres } = await import('postgres');
  console.log('🔄 Running database migration...');

  // Require database configuration
  if (!isDatabaseAvailable()) {
    console.warn('⚠️ Database configuration not found!');
    console.warn(
      'ℹ️ Please set PGDATABASE/PGHOST/PGUSER or POSTGRES_URL environment variables to run migrations.',
    );
    console.warn('💡 Skipping migrations in ephemeral mode...');
    process.exit(0);
  }

  console.log('📊 Database configuration detected, running migrations...');

  const schemaName = getSchemaName();
  console.log(`🗃️ Using database schema: ${schemaName}`);

  // Create custom schema and apply grants so all app service principals can access it.
  // CAN_CONNECT_AND_CREATE on the Lakebase already controls who can connect, so
  // granting to PUBLIC within the database is safe and avoids cross-SP permission issues.
  const connectionUrl = await getConnectionUrl();
  const schemaConnection = postgres(connectionUrl, { max: 1 });
  try {
    console.log(`📁 Creating schema '${schemaName}' if it doesn't exist...`);
    await schemaConnection`CREATE SCHEMA IF NOT EXISTS ${schemaConnection(schemaName)}`;
    console.log(`✅ Schema '${schemaName}' ensured to exist`);

    console.log(`🔑 Granting PUBLIC access to schema '${schemaName}'...`);
    await schemaConnection`GRANT USAGE ON SCHEMA ${schemaConnection(schemaName)} TO PUBLIC`;
    await schemaConnection`GRANT CREATE ON SCHEMA ${schemaConnection(schemaName)} TO PUBLIC`;
    await schemaConnection`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schemaConnection(schemaName)} TO PUBLIC`;
    await schemaConnection`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schemaConnection(schemaName)} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO PUBLIC`;
    console.log(`✅ Grants applied`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.warn(`⚠️ Schema creation/grant warning:`, errorMessage);
    // Continue — schema may already exist and grants may be applied from a prior run
  } finally {
    await schemaConnection.end().catch(() => {});
  }

  // Use drizzle-orm migrate to run SQL migration files
  console.log('🔄 Running SQL migrations from migration files...');

  const migrationConnectionUrl = await getConnectionUrl();
  const migrationConnection = postgres(migrationConnectionUrl, { max: 1 });

  try {
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');

    const db = drizzle(migrationConnection);

    const migrationsFolder = join(projectRoot, 'packages', 'db', 'migrations');

    console.log('📂 Migrations folder:', migrationsFolder);
    console.log('🔄 Applying pending migrations...');

    // Store migration tracking in the app schema instead of the default `drizzle`
    // schema — the app SP may not own the `drizzle` schema if it was created by
    // a different principal (e.g. a local personal account).
    await migrate(db, { migrationsFolder, migrationsSchema: schemaName });

    console.log('✅ All migrations applied successfully');
    await migrationConnection.end();
    console.log('✅ Database migration completed successfully');
  } catch (error) {
    await migrationConnection.end().catch(() => {});

    // If permission is denied it means the schema was created by a different principal
    // (e.g. a personal account running migrations locally). The tables already exist
    // and the grants above will give runtime access. Allow the build to proceed.
    const postgresCode = (error as any)?.cause?.code;
    if (postgresCode === '42501') {
      console.warn('⚠️  Migration skipped: permission denied for schema access.');
      console.warn(
        '   Schema/tables were created by a different principal and should already exist.',
      );
      console.warn(
        '   Continuing build — runtime access is governed by the Lakebase resource binding.',
      );
      return;
    }

    console.log('error', error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('❌ Database migration failed:', errorMessage);
    process.exit(1);
  }
}

main().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error('❌ Migration script failed:', errorMessage);
  process.exit(1);
});
