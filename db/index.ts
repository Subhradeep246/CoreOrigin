import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { ensureDatabase, getLibsql } from "./runtime";

export function getDb() {
  return drizzle(getLibsql(), { schema });
}

export async function getReadyDb() {
  await ensureDatabase();
  return getDb();
}
