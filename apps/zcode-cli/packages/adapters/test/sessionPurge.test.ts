import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { purgeSession } from "../src/storage/session-store/repositories/sessions.js";

const SESSION_ID = "session-purge-test";
const OTHER_SESSION_ID = "session-purge-other";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // runSqliteSessionMigrations 会打 pragma foreign_keys = on；级联删除依赖它，
  // 所以这个测试同时验证「purge 能级联」这一前提。
  runSqliteSessionMigrations(db, ":memory:");
  insertSession(db, SESSION_ID);
  insertSession(db, OTHER_SESSION_ID);
  return db;
}

function insertSession(db: DatabaseSync, sessionID: string): void {
  db.prepare(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values (?, 'project', 'slug', 'D:/workspace', 'title', '0.0.0', 0, 0)`,
  ).run(sessionID);
}

function seedSessionContent(db: DatabaseSync, sessionID: string): void {
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data)
     values (?, ?, 0, 0, '{}')`,
  ).run(`${sessionID}-message`, sessionID);
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data)
     values (?, ?, ?, 0, 0, '{}')`,
  ).run(`${sessionID}-part`, `${sessionID}-message`, sessionID);
  db.prepare(
    `insert into todo (session_id, content, status, priority, position, time_created, time_updated)
     values (?, 'todo', 'pending', 'high', 0, 0, 0)`,
  ).run(sessionID);
  db.prepare(
    `insert into input_history (id, project_id, session_id, text, kind, time_created)
     values (?, 'project', ?, 'text', 'prompt', 0)`,
  ).run(`${sessionID}-input`, sessionID);
}

function countRows(db: DatabaseSync, sql: string, ...args: string[]): number {
  const row = db.prepare(sql).get(...args) as { count?: number } | undefined;
  return Number(row?.count ?? 0);
}

test("purgeSession 物理删除会话及其级联内容，并解除无外键引用", () => {
  const db = createDb();
  seedSessionContent(db, SESSION_ID);
  seedSessionContent(db, OTHER_SESSION_ID);
  // dynamic workflow：dwf_run.parent_session_id 与 dwf_actor.session_id 都没有外键，
  // purge 必须显式解除引用而不是留下孤儿。
  db.prepare(
    `insert into dwf_run (id, parent_session_id, caps_max_concurrency, status, time_created, time_updated)
     values ('run-1', ?, 1, 'completed', 0, 0)`,
  ).run(SESSION_ID);
  db.prepare(
    `insert into dwf_actor (run_id, site_id, ordinal, session_id, time_created, time_updated)
     values ('run-1', 'site', 0, ?, 0, 0)`,
  ).run(SESSION_ID);

  purgeSession(db, { sessionID: SESSION_ID as never });

  // 会话行与级联内容全部消失。
  assert.equal(countRows(db, "select count(*) as count from session where id = ?", SESSION_ID), 0);
  assert.equal(
    countRows(db, "select count(*) as count from message where session_id = ?", SESSION_ID),
    0,
  );
  assert.equal(countRows(db, "select count(*) as count from part where session_id = ?", SESSION_ID), 0);
  assert.equal(countRows(db, "select count(*) as count from todo where session_id = ?", SESSION_ID), 0);
  assert.equal(
    countRows(db, "select count(*) as count from input_history where session_id = ?", SESSION_ID),
    0,
  );
  // workflow 历史保留行、只解除引用。
  assert.equal(countRows(db, "select count(*) as count from dwf_run where id = 'run-1'"), 1);
  assert.equal(
    countRows(db, "select count(*) as count from dwf_run where id = 'run-1' and parent_session_id is null"),
    1,
  );
  assert.equal(
    countRows(db, "select count(*) as count from dwf_actor where run_id = 'run-1' and session_id is null"),
    1,
  );
  // 其它会话不受影响。
  assert.equal(countRows(db, "select count(*) as count from session where id = ?", OTHER_SESSION_ID), 1);
  assert.equal(
    countRows(db, "select count(*) as count from message where session_id = ?", OTHER_SESSION_ID),
    1,
  );
  db.close();
});

test("purgeSession 对不存在的会话是幂等的", () => {
  const db = createDb();
  purgeSession(db, { sessionID: "missing-session" as never });
  assert.equal(countRows(db, "select count(*) as count from session"), 2);
  db.close();
});
