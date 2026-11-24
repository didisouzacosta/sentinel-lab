import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Sentinel Lab: upgrading an instance created before numeric ingest ids
// existed must backfill every project, in creation order, exactly once.

interface MigratableAuthState {
	initialized: boolean;
	ensureSchema(): Promise<void>;
}

describe('Lab: ingest_id migration', () => {
	it('backfills pre-existing projects in creation order and enforces uniqueness', async () => {
		const stub = env.AUTH_STATE.get(env.AUTH_STATE.idFromName(`lab-migration-${Date.now()}`));

		await runInDurableObject(stub, async (instance, state) => {
			const auth = instance as unknown as MigratableAuthState;
			const sql = state.storage.sql;

			// Build the current schema, then roll projects back to the
			// pre-ingest-id shape an older deployment would have.
			await auth.ensureSchema();
			sql.exec('DROP INDEX idx_projects_ingest_id');
			sql.exec('ALTER TABLE projects DROP COLUMN ingest_id');

			const now = '2026-01-01T00:00:00.000Z';
			sql.exec(
				"INSERT INTO users (id, email, password_hash, name, role, created_at, updated_at) VALUES ('u1', 'old@example.com', 'x', 'Old', 'admin', ?, ?)",
				now,
				now,
			);
			const legacy = [
				{ id: 'p-second', created: '2026-01-02T00:00:00.000Z' },
				{ id: 'p-first', created: '2026-01-01T00:00:00.000Z' },
				{ id: 'p-third', created: '2026-01-03T00:00:00.000Z' },
			];
			for (const p of legacy) {
				sql.exec(
					"INSERT INTO projects (id, name, slug, platform, public_key, created_at, created_by) VALUES (?, ?, ?, 'javascript', ?, ?, 'u1')",
					p.id,
					p.id,
					p.id,
					`key-${p.id}`,
					p.created,
				);
			}

			// Simulate the upgraded code booting on the old data.
			auth.initialized = false;
			await auth.ensureSchema();

			const rows = sql
				.exec('SELECT id, ingest_id FROM projects ORDER BY ingest_id')
				.toArray()
				.map((r) => [r.id, r.ingest_id]);
			expect(rows).toEqual([
				['p-first', 1],
				['p-second', 2],
				['p-third', 3],
			]);

			// Re-running the migration is a no-op.
			auth.initialized = false;
			await auth.ensureSchema();
			expect(sql.exec('SELECT COUNT(DISTINCT ingest_id) AS n FROM projects').one().n).toBe(3);

			// Uniqueness is enforced from now on.
			expect(() => sql.exec("UPDATE projects SET ingest_id = 1 WHERE id = 'p-third'")).toThrow();
		});
	});
});
