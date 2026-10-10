import path from "node:path";
import { defineConfig } from "prisma/config";

// Prisma 7 reads migration/introspection connection details from here (the
// schema no longer holds a `url`). The Prisma CLI does not auto-load .env, so
// load it manually (Node 20.12+ ships process.loadEnvFile).
try {
  process.loadEnvFile(path.join(process.cwd(), ".env"));
} catch {
  // .env is optional (e.g. on Vercel where vars are injected directly).
}

export default defineConfig({
  schema: path.join("prisma", "schema.prisma"),
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    // Not `env("DATABASE_URL")`: that throws when the variable is unset, which
    // breaks `prisma generate` (the postinstall step) on a fresh clone before
    // .env exists. Generate needs no database; commands that do connect
    // (db push, migrate) still fail loudly on an empty URL.
    url: process.env.DATABASE_URL ?? "",
  },
});
