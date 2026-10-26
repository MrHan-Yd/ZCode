import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { lastAssistantMessage } from "../src/storage/session-store/repositories/messages.js";

/**
 * `lastAssistantMessage` 的语义必须与「全量 messages() 后取最后一条 assistant」一致。
 * 子 agent manifest 用它替代全量读取（子会话 parts 可能几十 MB）。
 */

const SESSION_ID = "sess-last-assistant";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  db.prepare(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values (?, 'project', 'slug', 'D:/workspace', 'title', '0.0.0', 0, 0)`,
  ).run(SESSION_ID);
  return db;
}

function insertMessage(
  db: DatabaseSync,
  input: { id: string; role: "assistant" | "user"; sequence: number | null; time: number },
): void {
  db.prepare(
    `insert into message (id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    SESSION_ID,
    input.time,
    input.time,
    JSON.stringify({ role: input.role, time: { created: input.time } }),
    input.sequence,
  );
}

function insertTextPart(db: DatabaseSync, messageID: string, id: string, text: string): void {
  db.prepare(
    `insert into part (id, message_id, session_id, time_created, time_updated, data, sequence)
     values (?, ?, ?, 0, 0, ?, 0)`,
  ).run(id, messageID, SESSION_ID, JSON.stringify({ type: "text", text }));
}

test("返回 sequence 最大的 assistant，并带齐 parts", async () => {
  const db = createDb();
  insertMessage(db, { id: "msg-a1", role: "assistant", sequence: 1, time: 1 });
  insertMessage(db, { id: "msg-u1", role: "user", sequence: 2, time: 2 });
  insertMessage(db, { id: "msg-a2", role: "assistant", sequence: 3, time: 3 });
  insertTextPart(db, "msg-a1", "part-a1", "first");
  insertTextPart(db, "msg-a2", "part-a2-1", "second");
  insertTextPart(db, "msg-a2", "part-a2-2", "second more");

  const message = await lastAssistantMessage(db, { sessionID: SESSION_ID as never });
  assert.ok(message);
  assert.equal(message.info.id, "msg-a2");
  assert.equal(message.info.role, "assistant");
  assert.equal(message.parts.length, 2);
  db.close();
});

test("sequence 缺失的 assistant 在 messages() 全序里靠后，必须优先选中", async () => {
  const db = createDb();
  insertMessage(db, { id: "msg-a1", role: "assistant", sequence: 1, time: 1 });
  // messages() 的排序是 `sequence is null, sequence, time_created, rowid` 升序：
  // 非空 sequence 在前，NULL sequence 在最后。倒序查找必须把 NULL 放在最前。
  insertMessage(db, { id: "msg-a-null", role: "assistant", sequence: null, time: 9 });
  insertTextPart(db, "msg-a-null", "part-null", "last");

  const message = await lastAssistantMessage(db, { sessionID: SESSION_ID as never });
  assert.ok(message);
  assert.equal(message.info.id, "msg-a-null");
  db.close();
});

test("没有 assistant 时返回 null", async () => {
  const db = createDb();
  insertMessage(db, { id: "msg-u1", role: "user", sequence: 1, time: 1 });
  assert.equal(await lastAssistantMessage(db, { sessionID: SESSION_ID as never }), null);
  db.close();
});
