import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

export function createSql(databaseUrl: string): Sql {
  return postgres(databaseUrl, {
    max: 8,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: false, // required for the Supabase transaction pooler
    transform: { undefined: null },
  });
}
